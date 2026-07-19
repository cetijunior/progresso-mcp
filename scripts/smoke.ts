/**
 * Autonomous smoke test against live Progresso via MCP stdio.
 * Creates a zz-scratch project for writes, then deletes it.
 *
 *   npx tsx scripts/smoke.ts
 */
import { config } from "dotenv";
config();

import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Result = { name: string; ok: boolean; detail: string };

async function main() {
  const results: Result[] = [];
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const token = process.env.PROGRESSO_ACCESS_TOKEN!;
  if (!token) throw new Error("PROGRESSO_ACCESS_TOKEN missing in .env");

  const sb = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await sb.auth.getUser(token);
  const uid = userData.user?.id;
  if (!uid) throw new Error("Auth failed — refresh PROGRESSO_ACCESS_TOKEN");

  const scratchName = `zz-scratch-mcp-${new Date().toISOString().slice(0, 10)}`;
  const { data: board, error: bErr } = await sb
    .from("boards")
    .insert({ name: scratchName, kind: "project" })
    .select("*")
    .single();
  if (bErr) throw bErr;
  await sb.from("board_columns").insert(
    ["Backlog", "Planning", "Working", "Review", "Done"].map((n, i) => ({
      board_id: board.id,
      name: n,
      position: i,
    })),
  );
  const { data: project, error: pErr } = await sb
    .from("projects")
    .insert({
      name: scratchName,
      board_id: board.id,
      status: "active",
      description: "MCP smoke — auto-deleted",
    })
    .select("*")
    .single();
  if (pErr) throw pErr;
  await sb.from("project_members").insert({ project_id: project.id, user_id: uid });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: "progresso-smoke", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  results.push({
    name: "listTools",
    ok: tools.length >= 5,
    detail: tools.map((t) => t.name).join(", "),
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    try {
      const res = await client.callTool({ name, arguments: args });
      const text =
        Array.isArray(res.content) && res.content[0] && "text" in res.content[0]
          ? String((res.content[0] as { text: string }).text)
          : JSON.stringify(res);
      const isErr = Boolean((res as { isError?: boolean }).isError);
      results.push({
        name,
        ok: !isErr && !/auth failed/i.test(text),
        detail: text.slice(0, 400).replace(/\s+/g, " "),
      });
      return text;
    } catch (e) {
      results.push({
        name,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  await call("dashboard_pulse");
  await call("list_projects", { status: "active" });
  await call("list_tickets", { limit: 5 });
  await call("list_leads", { limit: 5 });

  const created = await call("create_ticket", {
    title: `mcp-smoke ${new Date().toISOString().slice(11, 16)}`,
    board_id: board.id,
    status: "Backlog",
    description: "Autonomous MCP smoke — deleted with scratch board",
  });
  let ticketId: string | null = null;
  try {
    ticketId = JSON.parse(created ?? "{}")?.created?.id ?? null;
  } catch {
    /* */
  }
  if (ticketId) {
    await call("move_ticket", { ticket_id: ticketId, status: "Working" });
    await call("check_in", { ticket_id: ticketId });
    await call("stop_timer", { note: "MCP smoke stop" });
    await call("list_tickets", { board_id: board.id, limit: 10 });
  } else {
    results.push({ name: "writes", ok: false, detail: "create_ticket returned no id" });
  }

  await client.close();

  const { error: dErr } = await sb.from("boards").delete().eq("id", board.id);
  results.push({
    name: "cleanup",
    ok: !dErr,
    detail: dErr ? dErr.message : `deleted ${scratchName} (${board.id})`,
  });

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== Progresso MCP smoke (live) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    console.log(`       ${r.detail.slice(0, 220)}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} passed (read + write + cleanup)`,
  );
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
