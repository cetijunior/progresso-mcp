/**
 * Live Progresso optimizer — MCP tools analyze the agency workspace and apply
 * safe CRM hygiene; flags money/deadline risks without moving client tickets.
 *
 *   npx tsx scripts/optimize.ts
 */
import { config } from "dotenv";
config();
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAIN = "00000000-0000-0000-0000-000000000001";

function todayTirane() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: "progresso-optimize", version: "0.1.0" });
  await client.connect(transport);

  async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? "{}";
    if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as T;
  }

  const today = todayTirane();
  const pulse = await call<{
    financials: { currency: string; paid_total: number; outstanding_total: number }[];
    working: {
      user_id: string;
      name: string | null;
      checked_in: boolean;
      has_active_timer: boolean;
      active_ticket_title?: string | null;
    }[];
    hours: {
      user_id: string;
      name: string | null;
      minutes_today: number;
      minutes_week: number;
      minutes_month: number;
    }[];
    in_progress_tickets: number;
  }>("dashboard_pulse");

  const { projects } = await call<{
    projects: { id: string; name: string; status: string; board_id: string }[];
  }>("list_projects", { status: "active" });

  const { leads } = await call<{
    leads: {
      id: string;
      name: string;
      company: string | null;
      status: string;
      temperature: string;
      estimated_value: number;
      currency: string;
      next_follow_up: string | null;
      owner_id: string | null;
    }[];
  }>("list_leads", { limit: 100 });

  const boards = [
    { id: MAIN, name: "Main" },
    ...projects.map((p) => ({ id: p.board_id, name: p.name })),
  ];

  type Ticket = {
    id: string;
    title: string;
    status: string;
    payment_status: string;
    amount: number;
    currency: string;
    due_at: string | null;
    updated_at: string | null;
    board_name: string;
  };

  const allTickets: Ticket[] = [];
  for (const b of boards) {
    const { tickets } = await call<{ tickets: Omit<Ticket, "board_name">[] }>("list_tickets", {
      board_id: b.id,
      limit: 200,
    });
    for (const t of tickets) allTickets.push({ ...t, board_name: b.name });
  }

  const actions: {
    kind: string;
    target: string;
    detail: string;
    applied: boolean;
    board?: string;
    amount?: number;
    currency?: string;
  }[] = [];

  const openLeads = leads.filter((l) => !["won", "lost"].includes(l.status));

  for (const lead of openLeads) {
    const patch: Record<string, unknown> = { lead_id: lead.id };
    const detail: string[] = [];
    if (!lead.next_follow_up || lead.next_follow_up < today) {
      patch.next_follow_up = today;
      detail.push(
        lead.next_follow_up ? `overdue ${lead.next_follow_up}→today` : "set follow-up today",
      );
    }
    if (lead.temperature === "cold" && (lead.estimated_value || 0) >= 100) {
      patch.temperature = "warm";
      detail.push("cold→warm");
    }
    if (lead.status === "new" && !lead.owner_id) {
      actions.push({
        kind: "needs_owner",
        target: lead.name,
        detail: "new + unowned",
        applied: false,
      });
    }
    if (detail.length) {
      await call("update_lead", patch);
      actions.push({
        kind: "lead_hygiene",
        target: lead.name,
        detail: detail.join("; "),
        applied: true,
      });
    }
  }

  const staleCutoff = Date.now() - 7 * 864e5;
  const wip = allTickets.filter((t) => !["Done", "Backlog"].includes(t.status));
  const stale = wip.filter(
    (t) => t.updated_at && new Date(t.updated_at).getTime() < staleCutoff,
  );
  const overdueDue = allTickets.filter(
    (t) => t.due_at && t.status !== "Done" && t.due_at.slice(0, 10) < today,
  );
  const outstanding = allTickets.filter(
    (t) => t.payment_status === "outstanding" && t.amount > 0,
  );

  for (const t of stale.slice(0, 12)) {
    actions.push({
      kind: "stale_wip",
      target: t.title,
      detail: `${t.board_name} · ${t.status} · updated ${(t.updated_at || "").slice(0, 10)}`,
      applied: false,
      board: t.board_name,
    });
  }
  for (const t of overdueDue.slice(0, 12)) {
    actions.push({
      kind: "overdue_due",
      target: t.title,
      detail: `${t.board_name} · due ${t.due_at!.slice(0, 10)} · ${t.status}`,
      applied: false,
      board: t.board_name,
    });
  }
  for (const t of outstanding) {
    actions.push({
      kind: "collect",
      target: t.title,
      detail: `${t.amount} ${t.currency} outstanding · ${t.board_name}`,
      applied: false,
      amount: t.amount,
      currency: t.currency,
      board: t.board_name,
    });
  }

  const teamMap = new Map<
    string,
    {
      id: string;
      name: string;
      status: string;
      ticket: string | null;
      weekMin: number;
      todayMin: number;
    }
  >();
  for (const w of pulse.working) {
    const h = pulse.hours.find((x) => x.user_id === w.user_id);
    const row = {
      id: w.user_id,
      name: w.name || "Member",
      status: w.has_active_timer ? "Working" : w.checked_in ? "In" : "Out",
      ticket: w.active_ticket_title || null,
      weekMin: h?.minutes_week ?? 0,
      todayMin: h?.minutes_today ?? 0,
    };
    const prev = teamMap.get(w.user_id);
    if (!prev || (row.status !== "Out" && prev.status === "Out") || row.weekMin > prev.weekMin) {
      teamMap.set(w.user_id, row);
    }
  }
  const team = [...teamMap.values()].sort((a, b) => b.weekMin - a.weekMin);

  const wipByBoard: Record<string, number> = {};
  for (const t of wip) wipByBoard[t.board_name] = (wipByBoard[t.board_name] || 0) + 1;
  const statusDist: Record<string, number> = {};
  for (const t of allTickets) statusDist[t.status] = (statusDist[t.status] || 0) + 1;

  const report = {
    ranAt: new Date().toISOString(),
    today,
    summary: {
      outstandingEur: pulse.financials?.[0]?.outstanding_total ?? 0,
      paidEur: pulse.financials?.[0]?.paid_total ?? 0,
      ticketsScanned: allTickets.length,
      boardsScanned: boards.length,
      wip: wip.length,
      staleWip: stale.length,
      overdueDue: overdueDue.length,
      collectable: outstanding.length,
      collectableSum: outstanding.reduce((s, t) => s + t.amount, 0),
      openLeads: openLeads.length,
      actionsApplied: actions.filter((a) => a.applied).length,
      actionsFlagged: actions.filter((a) => !a.applied).length,
      teamIn: team.filter((t) => t.status !== "Out").length,
      teamSize: team.length,
    },
    statusDist,
    wipByBoard: Object.entries(wipByBoard)
      .map(([board, count]) => ({ board, count }))
      .sort((a, b) => b.count - a.count),
    team,
    grinders: team.slice(0, 5).map((t) => ({
      name: t.name,
      weekH: Math.round(t.weekMin / 6) / 10,
      todayH: Math.round(t.todayMin / 6) / 10,
      status: t.status,
    })),
    leads: openLeads.map((l) => ({
      name: l.name,
      status: l.status,
      temp: l.temperature,
      value: l.estimated_value,
      follow: l.next_follow_up,
      company: l.company,
    })),
    actions,
    projects: projects.map((p) => p.name),
    topStale: stale.slice(0, 8).map((t) => ({
      title: t.title,
      board: t.board_name,
      status: t.status,
      updated: (t.updated_at || "").slice(0, 10),
    })),
    topCollect: outstanding.slice(0, 8).map((t) => ({
      title: t.title,
      board: t.board_name,
      amount: t.amount,
      currency: t.currency,
    })),
  };

  writeFileSync("scripts/last-optimize.json", JSON.stringify(report, null, 2));
  await client.close();

  console.log("\n=== Progresso live optimize ===\n");
  console.log(JSON.stringify(report.summary, null, 2));
  for (const a of actions) {
    console.log(`${a.applied ? "✓" : "·"} ${a.kind}  ${a.target} — ${a.detail}`);
  }
  console.log("\nReport → scripts/last-optimize.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
