#!/usr/bin/env node
/**
 * Progresso MCP — hand the live agency workspace to any MCP client.
 * Auth: anon key + user refresh token (preferred) or access token. Never service-role.
 *
 * One-command (after publish):
 *   npx -y progresso-mcp
 *
 * Local:
 *   cp .env.example .env   # fill PROGRESSO_REFRESH_TOKEN
 *   npm install && npm run build && npm start
 */
import { config } from "dotenv";
config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeClient, requireUser } from "./supabase.js";

const DEFAULT_BOARD = "00000000-0000-0000-0000-000000000001";

const server = new McpServer({
  name: "progresso",
  version: "0.2.0",
});

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function tiraneToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

server.tool(
  "dashboard_pulse",
  "Agency pulse: financials summary, who's checked in, in-progress ticket count.",
  {},
  async () => {
    const sb = makeClient();
    await requireUser(sb);
    const [agency, working, hours, tickets] = await Promise.all([
      sb.from("v_agency_financials").select("*"),
      sb.from("v_currently_working").select("*"),
      sb.from("v_user_hours").select("*"),
      sb
        .from("tickets")
        .select("id,status,parent_id")
        .is("parent_id", null)
        .limit(1000),
    ]);
    const rows = tickets.data ?? [];
    const inProgress = rows.filter(
      (t) => t.status !== "Done" && t.status !== "Backlog",
    ).length;
    return text({
      financials: agency.data,
      working: working.data,
      hours: hours.data,
      in_progress_tickets: inProgress,
      errors: [agency.error, working.error, hours.error, tickets.error]
        .filter(Boolean)
        .map((e) => e!.message),
    });
  },
);

server.tool(
  "list_tickets",
  "List top-level tickets, optionally filtered by board_id or status.",
  {
    board_id: z.string().uuid().optional().describe("Defaults to Main board"),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ board_id, status, limit }) => {
    const sb = makeClient();
    await requireUser(sb);
    let q = sb
      .from("tickets")
      .select(
        "id,title,status,board_id,project_id,payment_status,amount,currency,due_at,updated_at,parent_id",
      )
      .is("parent_id", null)
      .eq("board_id", board_id ?? DEFAULT_BOARD)
      .order("position")
      .limit(limit ?? 50);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return text({ board_id: board_id ?? DEFAULT_BOARD, tickets: data });
  },
);

server.tool(
  "get_ticket",
  "Fetch one ticket plus its sub-tickets.",
  {
    ticket_id: z.string().uuid(),
  },
  async ({ ticket_id }) => {
    const sb = makeClient();
    await requireUser(sb);
    const { data: ticket, error } = await sb
      .from("tickets")
      .select(
        "id,title,status,description,board_id,project_id,parent_id,payment_status,amount,currency,due_at,updated_at",
      )
      .eq("id", ticket_id)
      .single();
    if (error) throw error;
    const { data: subs } = await sb
      .from("tickets")
      .select("id,title,status,position,updated_at")
      .eq("parent_id", ticket_id)
      .order("position");
    return text({ ticket, subtickets: subs ?? [] });
  },
);

server.tool(
  "create_ticket",
  "Create a ticket (or sub-ticket via parent_id). Prefer zz-scratch boards when testing live.",
  {
    title: z.string().min(1),
    board_id: z.string().uuid().optional(),
    status: z.string().optional(),
    description: z.string().optional(),
    parent_id: z.string().uuid().optional().describe("If set, creates a sub-ticket under this parent"),
  },
  async ({ title, board_id, status, description, parent_id }) => {
    const sb = makeClient();
    const user = await requireUser(sb);
    let bid = board_id ?? DEFAULT_BOARD;
    let projectId: string | null = null;
    let clientId: string | null = null;
    let col = status ?? "Backlog";

    if (parent_id) {
      const { data: parent, error: pErr } = await sb
        .from("tickets")
        .select("id,board_id,project_id,client_id,status")
        .eq("id", parent_id)
        .single();
      if (pErr) throw pErr;
      bid = parent.board_id;
      projectId = parent.project_id;
      clientId = parent.client_id;
      col = status ?? "Backlog";
    } else {
      const { data: proj } = await sb
        .from("projects")
        .select("id,client_id")
        .eq("board_id", bid)
        .maybeSingle();
      projectId = proj?.id ?? null;
      clientId = proj?.client_id ?? null;
    }

    const { data, error } = await sb
      .from("tickets")
      .insert({
        title: title.trim(),
        board_id: bid,
        status: col,
        description: description?.trim() || null,
        parent_id: parent_id ?? null,
        project_id: projectId,
        client_id: clientId,
        created_by: user.id,
        position: Date.now() % 100000,
        payment_status: "free",
        amount: 0,
        currency: "EUR",
        tags: [],
      })
      .select("*")
      .single();
    if (error) throw error;
    return text({ created: data });
  },
);

server.tool(
  "update_ticket",
  "Patch ticket fields (title, description, status, due_at, payment).",
  {
    ticket_id: z.string().uuid(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    due_at: z.string().nullable().optional(),
    payment_status: z.enum(["free", "outstanding", "paid"]).optional(),
    amount: z.number().optional(),
  },
  async (args) => {
    const sb = makeClient();
    await requireUser(sb);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) patch.status = args.status;
    if (args.due_at !== undefined) patch.due_at = args.due_at;
    if (args.payment_status !== undefined) patch.payment_status = args.payment_status;
    if (args.amount !== undefined) patch.amount = args.amount;
    const { data, error } = await sb
      .from("tickets")
      .update(patch)
      .eq("id", args.ticket_id)
      .select("*")
      .single();
    if (error) throw error;
    return text({ updated: data });
  },
);

server.tool(
  "move_ticket",
  "Move a ticket to a new column (status) and optional position.",
  {
    ticket_id: z.string().uuid(),
    status: z.string(),
    position: z.number().optional(),
  },
  async ({ ticket_id, status, position }) => {
    const sb = makeClient();
    await requireUser(sb);
    const { data, error } = await sb
      .from("tickets")
      .update({ status, ...(position != null ? { position } : {}), updated_at: new Date().toISOString() })
      .eq("id", ticket_id)
      .select("id,title,status,position")
      .single();
    if (error) throw error;
    return text({ moved: data });
  },
);

server.tool(
  "add_comment",
  "Add a comment on a ticket (supports @Name mentions in body text).",
  {
    ticket_id: z.string().uuid(),
    body: z.string().min(1),
  },
  async ({ ticket_id, body }) => {
    const sb = makeClient();
    const user = await requireUser(sb);
    const { data, error } = await sb
      .from("ticket_comments")
      .insert({ ticket_id, user_id: user.id, body: body.trim() })
      .select("*")
      .single();
    if (error) throw error;
    return text({ comment: data });
  },
);

server.tool(
  "list_leads",
  "List CRM leads (newest first).",
  {
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ status, limit }) => {
    const sb = makeClient();
    await requireUser(sb);
    let q = sb
      .from("leads")
      .select(
        "id,name,company,status,temperature,owner_id,estimated_value,currency,next_follow_up,updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(limit ?? 40);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return text({ leads: data });
  },
);

server.tool(
  "create_lead",
  "Create a CRM lead.",
  {
    name: z.string().min(1),
    company: z.string().optional(),
    status: z.string().optional(),
    temperature: z.enum(["hot", "warm", "cold"]).optional(),
    next_follow_up: z.string().optional(),
    notes: z.string().optional(),
  },
  async (args) => {
    const sb = makeClient();
    const user = await requireUser(sb);
    const { data, error } = await sb
      .from("leads")
      .insert({
        name: args.name.trim(),
        company: args.company?.trim() || null,
        status: args.status ?? "new",
        temperature: args.temperature ?? "warm",
        next_follow_up: args.next_follow_up || null,
        notes: args.notes?.trim() || null,
        owner_id: user.id,
        created_by: user.id,
      })
      .select("*")
      .single();
    if (error) throw error;
    return text({ created: data });
  },
);

server.tool(
  "update_lead",
  "Patch a lead's status, temperature, or follow-up date (YYYY-MM-DD).",
  {
    lead_id: z.string().uuid(),
    status: z.string().optional(),
    temperature: z.enum(["hot", "warm", "cold"]).optional(),
    next_follow_up: z.string().optional(),
  },
  async (args) => {
    const sb = makeClient();
    await requireUser(sb);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (args.status) patch.status = args.status;
    if (args.temperature) patch.temperature = args.temperature;
    if (args.next_follow_up !== undefined) patch.next_follow_up = args.next_follow_up || null;
    const { data, error } = await sb
      .from("leads")
      .update(patch)
      .eq("id", args.lead_id)
      .select("*")
      .single();
    if (error) throw error;
    return text({ updated: data });
  },
);

server.tool(
  "check_in",
  "Check in for today. Optionally start a timer on a ticket (omit ticket_id for presence-only if you are admin — still recommended to pass a ticket).",
  {
    ticket_id: z.string().uuid().optional().describe("Ticket to start timing on"),
  },
  async ({ ticket_id }) => {
    const sb = makeClient();
    const user = await requireUser(sb);
    const today = tiraneToday();
    const { error: cErr } = await sb.from("check_ins").upsert(
      {
        user_id: user.id,
        date: today,
        checked_in_at: new Date().toISOString(),
        checked_out_at: null,
      },
      { onConflict: "user_id,date" },
    );
    if (cErr) throw cErr;

    if (!ticket_id) {
      return text({ checked_in: true, timer: null, note: "Presence only — no timer started." });
    }

    await sb
      .from("time_entries")
      .update({ ended_at: new Date().toISOString(), note: "(auto) switched timer" })
      .eq("user_id", user.id)
      .is("ended_at", null);
    const { data, error } = await sb
      .from("time_entries")
      .insert({
        user_id: user.id,
        ticket_id,
        started_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (error) throw error;
    return text({ checked_in: true, timer: data });
  },
);

server.tool(
  "check_out",
  "Check out for today. Running timers are stopped with an auto note.",
  {},
  async () => {
    const sb = makeClient();
    const user = await requireUser(sb);
    const today = tiraneToday();
    const now = new Date().toISOString();
    await sb
      .from("time_entries")
      .update({ ended_at: now, note: "(auto) checked out" })
      .eq("user_id", user.id)
      .is("ended_at", null);
    const { error } = await sb
      .from("check_ins")
      .update({ checked_out_at: now })
      .eq("user_id", user.id)
      .eq("date", today);
    if (error) throw error;
    return text({ checked_out: true });
  },
);

server.tool(
  "stop_timer",
  "Stop the running timer. Work note is required.",
  {
    note: z.string().min(1),
  },
  async ({ note }) => {
    const sb = makeClient();
    const user = await requireUser(sb);
    const { data: running, error: fErr } = await sb
      .from("time_entries")
      .select("id")
      .eq("user_id", user.id)
      .is("ended_at", null)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!running) return text({ stopped: false, reason: "No running timer" });
    const { data, error } = await sb
      .from("time_entries")
      .update({ ended_at: new Date().toISOString(), note: note.trim() })
      .eq("id", running.id)
      .select("*")
      .single();
    if (error) throw error;
    return text({ stopped: data });
  },
);

server.tool(
  "list_projects",
  "List projects with status.",
  {
    status: z.enum(["active", "completed", "archived"]).optional(),
  },
  async ({ status }) => {
    const sb = makeClient();
    await requireUser(sb);
    let q = sb
      .from("projects")
      .select("id,name,status,description,board_id,client_id,updated_at")
      .order("name");
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return text({ projects: data });
  },
);

server.tool(
  "update_project",
  "Patch a project's name, description, or status.",
  {
    project_id: z.string().uuid(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["active", "completed", "archived"]).optional(),
  },
  async (args) => {
    const sb = makeClient();
    await requireUser(sb);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) patch.status = args.status;
    const { data, error } = await sb
      .from("projects")
      .update(patch)
      .eq("id", args.project_id)
      .select("*")
      .single();
    if (error) throw error;
    return text({ updated: data });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
