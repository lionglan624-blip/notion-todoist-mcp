# notion-todoist-mcp

A custom [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server running on Cloudflare Workers that provides Claude with full read/write access to Notion and Todoist. Protected by OAuth 2.1 for use with remote MCP clients.

## Features (33 tools)

### Todoist (18 tools)

| Tool | Description |
|------|-------------|
| `t_get_tasks` | Query tasks by project, section (name), section_id, label, filter, or IDs. `project_id:"all"` for cross-project. Compact TSV output by default |
| `t_get_task` | Get a single task by ID |
| `t_create_task` | Create a task with labels, due date, priority, section, subtask support |
| `t_update_task` | Update any task field including move between projects/sections and reorder within a section |
| `t_close_task` | Mark a task as completed |
| `t_reopen_task` | Reopen a completed task |
| `t_delete_task` | Permanently delete a task |
| `t_bulk` | Execute multiple operations (create/update/close/delete) in one call with concurrency control; reorders batched via Sync API |
| `t_get_completed_tasks` | Query completed tasks with date range filtering |
| `t_get_projects` | List all projects |
| `t_create_project` / `t_update_project` / `t_delete_project` | Manage projects |
| `t_get_sections` | List sections in a project (omit `project_id` or pass `"all"` for cross-project) |
| `t_create_section` / `t_update_section` / `t_delete_section` | Manage sections |
| `t_get_labels` | List all personal labels |

### Notion (10 tools)

| Tool | Description |
|------|-------------|
| `n_query` | Query a database with filters, sorts, auto-pagination, and aggregations (sum/avg/min/max/delta) |
| `n_create_page` | Create a page with property shorthand and Markdown body |
| `n_update_page` | Update properties, replace or append page body content (`archived:true` trashes the page) |
| `n_delete_page` | Delete a page by archiving it (convenience wrapper; `restore:true` un-archives) |
| `n_get_page` | Get a single page with all properties |
| `n_get_blocks` | Get page body as plain text with heading markers (`##`/`###`/`####`) |
| `n_get_schema` | Get database property schema |
| `n_search` | Search workspace by title, or set `search_body:true` for bounded full-text body scan (fetches blocks for up to `max_scan` accessible pages, default 50, cap 100). `query` optional for title path. `include_properties:true` adds compact properties for client-side filtering |
| `n_create_database` | Create a new database under a parent page |
| `n_update_schema` | Add/remove columns, rename, or archive (`archived:true`) a database |

### Utilities (5 tools)

| Tool | Description |
|------|-------------|
| `eval_date` | Resolve JST date expressions (`today`, `today+7d`, `yesterday`, `today-2w`, `now`, etc.) |
| `calculate` | Safe math evaluator with `Math.*` support (no `eval`) |
| `stats` | Compute statistics (count, sum, avg, min, max, median, delta) from a number array |
| `context` | Single-call conversation bootstrap. Fetches configured sources in parallel. Resolution: per-call args > `CONTEXT_CONFIG` env var > legacy defaults (`TODOIST_CONFIG.inbox_project_id` + `NOTION_DB_IDS.habits_page`). Supports `tasks`, `pages`, `extra_pages`, `queries` slots |
| `help` | Return the full tool list (names + inputSchemas) plus static workspace config (pre-configured database/project IDs) |

## Key Design Choices

- **Compact output** — Properties are flattened to simple values; default format is TSV to minimize token usage
- **Date expressions** — `today`, `today+7d`, `today-30d`, `tomorrow`, `today+1m`, `now` etc. are resolved in JST
- **Property shorthand** — `"text"` becomes `rich_text`, `123` becomes `number`, `true` becomes `checkbox`, `["a","b"]` becomes `multi_select`
- **Markdown body** — Page content accepts Markdown (headings, bullets, numbered lists, code blocks, bold/italic/code inline)
- **Rate limit handling** — Notion, Todoist REST, and Todoist Sync requests auto-retry on 429 with exponential backoff
- **Bulk operations** — `t_bulk` runs up to 3 concurrent operations and batches reorders into a single Sync API call
- **OAuth 2.1** — `/mcp` endpoint is protected; dynamic client registration + PKCE supported. Access tokens are audience-bound via [RFC 8707 resource indicators](https://datatracker.ietf.org/doc/html/rfc8707) when the client sends a `resource` parameter, so a token leaked to an unrelated MCP server cannot be replayed against this one.

### OAuth security tradeoffs

This server uses **stateless HMAC-signed tokens** (no KV/DO) to stay free-tier friendly. Consequences to be aware of:

- **Authorization codes are reusable until they expire** (5 minutes). A standards-compliant implementation (RFC 6749 §4.1.2) issues codes that MUST be one-time use. Without persistent storage we cannot track consumption. In a single-user deployment this is a low risk, but if you operate this for multiple users, front it with KV-backed code storage.
- `client_id` and `resource` are bound into the code at `/authorize` and re-verified at `/token`, so a stolen code cannot be redeemed for a different client or audience.
- Token-endpoint errors are caught and returned as a generic `server_error` so request bodies (which contain `code`, `code_verifier`, `refresh_token`) never appear in responses or unhandled-exception logs.
- Upstream (Notion/Todoist) error messages are scrubbed of anything matching `Bearer <token>` before being returned through the MCP error channel.

## Setup

### 1. Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

### 2. Set secrets

```bash
npx wrangler secret put NOTION_TOKEN       # Notion integration token
npx wrangler secret put TODOIST_TOKEN      # Todoist API token
npx wrangler secret put MCP_SIGNING_KEY    # HMAC key for OAuth token sign/verify (random 32+ bytes)
npx wrangler secret put MCP_LOGIN_SECRET   # Password entered on the /authorize login page
```

`MCP_SIGNING_KEY` and `MCP_LOGIN_SECRET` should be different values. The signing key must never be shown to the user — generate it with e.g. `openssl rand -base64 32`. The login secret is what you type into the browser when an MCP client triggers the OAuth flow.

Legacy deployments that set a single `MCP_SECRET` still work: both roles fall back to it when the split secrets are absent. New deployments should prefer the split form.

### 3. Notion integration setup

1. Go to [Notion Integrations](https://www.notion.so/my-integrations) and create a new integration
2. Copy the integration token
3. Share each database you want to access with the integration

### 4. Todoist API token

1. Go to [Todoist Settings > Integrations > Developer](https://todoist.com/app/settings/integrations/developer)
2. Copy your API token

### 5. Register as MCP server

Add to your Claude Desktop / Claude Code MCP config. The client will perform OAuth discovery automatically:

```json
{
  "mcpServers": {
    "notion-todoist": {
      "type": "url",
      "url": "https://your-worker.your-subdomain.workers.dev/mcp"
    }
  }
}
```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` or `/` | POST | MCP JSON-RPC endpoint (OAuth-protected) |
| `/health` | GET | Health check (returns tool count) |
| `/.well-known/oauth-protected-resource` | GET | OAuth 2.0 protected resource metadata |
| `/.well-known/oauth-authorization-server` | GET | OAuth 2.0 authorization server metadata |
| `/register` | POST | Dynamic client registration (RFC 7591) |
| `/authorize` | GET/POST | Authorization endpoint (PKCE) |
| `/token` | POST | Token endpoint |

## Customization

The `help` and `context` tools read workspace-specific IDs from two JSON-valued Worker vars:

- `NOTION_DB_IDS` — e.g. `{"habits_page":"<page-id>","state":"<db-id>","metrics":"<db-id>"}`
- `TODOIST_CONFIG` — e.g. `{"inbox_project_id":"<project-id>"}`

Set them in `wrangler.toml` (`[vars]`) or via `npx wrangler secret put` if you prefer to keep IDs out of source control. `context` requires both `TODOIST_CONFIG.inbox_project_id` and `NOTION_DB_IDS.habits_page`.

## Project structure

```
worker.js          # fetch entry + route dispatch
src/utils.js       # date expressions, safeMath, id normalizer
src/notion.js      # Notion REST client, Markdown→blocks, property shorthand
src/todoist.js     # Todoist REST + Sync clients, compact/TSV helpers
src/oauth.js       # OAuth 2.1 (HMAC tokens, PKCE, /authorize, /token)
src/tools.js       # MCP tool schemas (TOOLS array)
src/mcp.js         # tool handlers + JSON-RPC dispatcher
```

Wrangler bundles the ESM imports at deploy time — no build step is required.

## License

MIT
