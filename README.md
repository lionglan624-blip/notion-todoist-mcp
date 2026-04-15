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

Tokens themselves are **stateless HMAC-signed**; a single `OAUTH_STATE` KV namespace tracks just enough state to enforce single-use codes and refresh rotation (see below). Consequences to be aware of:

- **Authorization codes are single-use** (RFC 6749 §4.1.2). Each code carries a `jti` that is written to `OAUTH_STATE` on consumption at `/token`; a second exchange within the 5-minute TTL returns `invalid_grant`.
- **Refresh tokens rotate with reuse detection** (RFC 6749 §10.4 / RFC 6819 §5.2.2.3). Each refresh carries a `jti` (unique per rotation) and `fam` (family, stable across rotations). Using a refresh token issues a new one in the same family; attempting to use an already-rotated token poisons `fam:<fam>` in KV for 30 days, invalidating the whole lineage so a stolen token cannot outlive the legitimate client's next rotation.
- **Sliding 30-day session.** The refresh token is re-issued on every use with a fresh 30-day expiry, so a client that keeps talking to the server stays logged in indefinitely. Only 30 consecutive days of silence (or a detected reuse) forces re-auth via `/authorize`.
- `client_id` and `resource` are bound into the code at `/authorize` and re-verified at `/token`, so a stolen code cannot be redeemed for a different client or audience.
- Every issued token is audience-bound (`aud` defaults to `${origin}/mcp` when the client omits `resource`), so tokens cannot be replayed against unrelated resource servers that might share the signing key in the future.
- `redirect_uri` is checked against a host allowlist at both GET and POST on `/authorize` so a crafted authorize URL cannot forward the authorization code to an attacker-controlled host. Default allowlist: `claude.ai`, `claude.com`, `anthropic.com` (plus subdomains) and loopback. Override with the `ALLOWED_REDIRECT_HOSTS` var (comma-separated; `*.suffix` wildcards supported).
- `POST /authorize` rejects cross-origin `Origin` headers to defeat browser-form CSRF (autofill / password-manager exploit). Same-origin and absent Origin (curl, server-to-server) are allowed.
- Login-secret comparison is constant-time (SHA-256 + byte-wise XOR). A 200–400 ms jittered delay is added on failed attempts; for real brute-force defense, attach a Cloudflare Rate Limiting Rule to `POST /authorize`.
- Only standard OAuth/PKCE parameters are re-emitted as hidden fields on the login page — non-standard query params are dropped so they cannot ride through.
- Token-endpoint errors are caught and returned as a generic `server_error` so request bodies (which contain `code`, `code_verifier`, `refresh_token`) never appear in responses or unhandled-exception logs.
- Upstream (Notion/Todoist) error messages are scrubbed of anything matching `Bearer <token>` and truncated to 200 chars before being returned through the MCP error channel, so request-body echoes from the upstream API cannot leak caller data unbounded.
- User-supplied IDs are validated before URL interpolation: Notion IDs must be 32-hex UUIDs (`normalizeId` throws otherwise) and Todoist IDs must match `[A-Za-z0-9_-]+` (`assertTodoistId`). This blocks path-pivot attacks like `task_id:"123/close"` silently turning `t_update_task` into `t_close_task`.

#### Key rotation

Individual tokens are not revocable by serial number, but two mechanisms give you revocation-like behaviour:

1. **Family poisoning** — if a refresh token is detected being re-used after rotation, its entire family is invalidated for 30 days and that client must re-auth.
2. **Signing-key rotation** — to invalidate *every* live access/refresh token at once (e.g. after suspected key leakage), rotate `MCP_SIGNING_KEY`:

```bash
npx wrangler secret put MCP_SIGNING_KEY   # enter a new random value
```

Any existing token signed under the old key fails HMAC verification on the next request and clients re-run the OAuth flow. Rotate `MCP_LOGIN_SECRET` independently if only the login password needs to change.

## Setup

### 1. Create the OAuth state KV namespace

```bash
npx wrangler kv namespace create OAUTH_STATE
```

Copy the returned `id` into `wrangler.toml` under the existing `[[kv_namespaces]]` block (replace the committed ID with your own). This namespace stores the single-use code markers and refresh-rotation history — without it, `/token` fails closed with `server_error`.

### 2. Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

### 3. Set secrets

```bash
npx wrangler secret put NOTION_TOKEN             # Notion integration token
npx wrangler secret put TODOIST_TOKEN            # Todoist API token (also used by the cron + webhook)
npx wrangler secret put MCP_LOGIN_SECRET         # Password you'll type on /authorize

# Pipe a random 32-char HMAC key straight in — never display it on screen:
openssl rand -base64 24 | tr -d '\n' | npx wrangler secret put MCP_SIGNING_KEY
# Node fallback if openssl isn't on PATH:
# node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64'))" | npx wrangler secret put MCP_SIGNING_KEY

# Only needed if you enable the Todoist webhook (see § Automation in CLAUDE.md):
npx wrangler secret put TODOIST_WEBHOOK_SECRET   # Todoist app client_secret

# Optional — override the default redirect_uri host allowlist:
# npx wrangler secret put ALLOWED_REDIRECT_HOSTS   # e.g. "claude.ai,*.claude.ai,localhost"
```

#### Which secrets you need to retain

| Secret | Retain locally? | Why |
|--------|-----------------|-----|
| `NOTION_TOKEN` | No | Always visible in the Notion integration settings page |
| `TODOIST_TOKEN` | No | Always visible in Todoist → Settings → Integrations → Developer |
| `TODOIST_WEBHOOK_SECRET` | No | Always visible in the Todoist Developer Console as the app's `client_secret` |
| `MCP_SIGNING_KEY` | **No — disposable by design** | Throwaway random string. Rotating / regenerating it is the intentional revocation path: all live OAuth tokens fail verification and clients re-auth once via `/authorize`. There is nothing to back up |
| `MCP_LOGIN_SECRET` | **Yes** | The password you type on `/authorize`. Forgetting it means you can no longer issue new OAuth tokens (existing tokens keep working until `MCP_SIGNING_KEY` rotates) |

So the random-pipe pattern above for `MCP_SIGNING_KEY` is deliberate — not seeing the value on screen is fine because you never need to see it again. For `MCP_LOGIN_SECRET`, use the interactive `wrangler secret put` prompt (or your password manager) since you'll have to type it into the browser.

Legacy deployments that set a single `MCP_SECRET` still work: both roles fall back to it when the split secrets are absent. New deployments should prefer the split form.

### 4. Notion integration setup

1. Go to [Notion Integrations](https://www.notion.so/my-integrations) and create a new integration
2. Copy the integration token
3. Share each database you want to access with the integration

### 5. Todoist API token

1. Go to [Todoist Settings > Integrations > Developer](https://todoist.com/app/settings/integrations/developer)
2. Copy your API token

### 6. Register as MCP server

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
| `/webhook/todoist` | POST | Todoist webhook receiver (HMAC-verified). Renumbers `#N` sequential sections on `item:completed`. See CLAUDE.md § Automation |

## Customization

The `help` and `context` tools read workspace-specific IDs from two JSON-valued Worker vars:

- `NOTION_DB_IDS` — e.g. `{"habits_page":"<page-id>","state":"<db-id>","metrics":"<db-id>"}`
- `TODOIST_CONFIG` — e.g. `{"inbox_project_id":"<project-id>"}`

Set them in `wrangler.toml` (`[vars]`) or via `npx wrangler secret put` if you prefer to keep IDs out of source control. `context` requires both `TODOIST_CONFIG.inbox_project_id` and `NOTION_DB_IDS.habits_page`.

## Project structure

```
worker.js          # fetch entry + route dispatch; also exports `scheduled` for the cron
src/utils.js       # date expressions, safeMath, id normalizer
src/notion.js      # Notion REST client, Markdown→blocks, property shorthand
src/todoist.js     # Todoist REST + Sync clients, compact/TSV helpers
src/oauth.js       # OAuth 2.1 (HMAC tokens, PKCE, /authorize, /token)
src/tools.js       # MCP tool schemas (TOOLS array)
src/mcp.js         # tool handlers + JSON-RPC dispatcher
src/cron.js        # daily `next`-label maintenance (runs via [triggers].crons)
src/webhook.js     # POST /webhook/todoist — sequential (#N) section renumbering
```

Wrangler bundles the ESM imports at deploy time — no build step is required.

## License

MIT
