# Progresso MCP

Hand the **live** Progresso workspace (same Supabase as [progresso.rritjesade.com](https://progresso.rritjesade.com)) to any MCP client — Cursor, Claude Desktop, Inspector, etc.

Docs: https://progresso.rritjesade.com/docs/mcp · Admins: **Settings → Connectors**

## One-command (Cursor)

```json
{
  "mcpServers": {
    "progresso": {
      "command": "npx",
      "args": ["-y", "github:cetijunior/progresso-mcp"],
      "env": {
        "SUPABASE_URL": "https://dtigibuhzhmxrkfzvijt.supabase.co",
        "SUPABASE_ANON_KEY": "sb_publishable_…",
        "PROGRESSO_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

Copy your refresh token from Settings → Connectors (web or Mac). Prefer refresh over access JWT. Never use the service-role key.

When published to npm: `npx -y progresso-mcp` (same env).

## Local / Inspector

```bash
cp .env.example .env   # URL, anon key, PROGRESSO_REFRESH_TOKEN
npm install
npm run build
npm run inspector
```

## Tools (v0.2)

| Tool | Purpose |
|------|---------|
| `dashboard_pulse` | Financials + presence + WIP count |
| `list_tickets` / `get_ticket` / `create_ticket` / `update_ticket` / `move_ticket` / `add_comment` | Board work |
| `list_leads` / `create_lead` / `update_lead` | CRM |
| `list_projects` / `update_project` | Projects |
| `check_in` / `check_out` / `stop_timer` | Time |
