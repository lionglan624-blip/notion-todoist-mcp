# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A Cloudflare Worker that exposes a custom MCP server for Notion + Todoist, protected by OAuth 2.1. Deployed via `wrangler`, no build step. ESM modules under `src/` are bundled at deploy time.

## Layout

```
worker.js        # fetch entry + route dispatch (thin)
src/tools.js     # MCP tool schemas (TOOLS array) — source of truth for tool count
src/mcp.js       # tool handlers + JSON-RPC dispatcher
src/notion.js    # Notion REST client, md→blocks, property shorthand
src/todoist.js   # Todoist REST + Sync clients, compact/TSV helpers
src/oauth.js     # OAuth 2.1 (HMAC tokens, PKCE, /authorize, /token)
src/utils.js     # date expressions, safeMath, id normalizer
```

When adding a tool: add schema to `src/tools.js` AND handler to `src/mcp.js`. Keep the tool count in `README.md` (`## Features (N tools)`) in sync.

## Conventions

- **Compact-first output.** Default to TSV / flattened props to save tokens. Any new list-returning tool should support `compact` + `format` like `t_get_tasks`.
- **Date expressions** (`today`, `today+7d`, `now`, etc.) are resolved server-side via `evalDate` in `src/utils.js`. Apply them anywhere the user passes a date string.
- **Property shorthand** for Notion properties lives in `normalizeProperties` (`src/notion.js`). Prefer extending it over forcing callers to write full Notion JSON.
- **Rate limits.** Both `notionReq` and `todoistReq` retry 429s with `Retry-After` + exponential backoff. Don't bypass them.
- **No secrets in logs.** Upstream error messages are scrubbed of `Bearer <token>` before surfacing. Don't add new log paths that echo request bodies.
- **Minimally-stateful tokens.** OAuth tokens are HMAC-signed and self-contained; the only persistent state is the `OAUTH_STATE` KV namespace used to enforce (a) authorization-code single-use and (b) refresh-token rotation with reuse detection. Don't add further storage without discussing the free-tier tradeoff first.

## Deploy / commit workflow

```bash
npx wrangler deploy    # deploys src + worker.js to Cloudflare
git push               # source of truth is GitHub; deploy is separate
```

`build.bat` / `push.bat` are convenience wrappers. There is no test suite — validate by importing modules in node (`node -e "import('./src/mcp.js')"`) and/or hitting the deployed `/health` endpoint.

### Automatic post-edit workflow (durable authorization)

**After any code edit in this repo, run the full release chain without waiting for user confirmation**:

1. `npm install -g wrangler@latest` — keep wrangler on the latest version before deploying.
2. Validate: `node -e "import('./src/mcp.js')"` and `node -e "import('./src/tools.js')"`.
3. If tool schemas changed: sync `README.md` (tool count in `## Features (N tools)` and the Notion/Todoist/Utilities tables).
4. `npx wrangler deploy` — deploy to Cloudflare.
5. `git add` the intentionally-changed files (still avoid `.dev.vars` and anything secret-looking) and `git commit` with a descriptive message.
6. `git push` to the tracking remote.

For doc-only edits (CLAUDE.md / README.md with no schema change), skip steps 1 & 4 — go validate → commit → push.

The user has pre-authorized this chain; do not pause between steps to ask. If any step fails (import error, deploy error, failing hook), stop and surface the failure — do not skip or bypass. Never force-push, never `--no-verify`.

## Gotchas

- Notion `children` / `append block children` are capped at 100 per request. Use `appendBlocksChunked` in `src/notion.js` for longer markdown.
- A single Notion `rich_text.text.content` is capped at 2000 chars — `splitLongRichText` handles this.
- `n_search` returns only what the integration has been shared with. Empty results usually mean "not shared", not a bug.
- Todoist's `/sections` / `/projects` endpoints sometimes return `{results:[...]}` and sometimes a bare array — handlers normalize with `Array.isArray(raw) ? raw : raw?.results ?? []`.
- `context` and `help` read workspace-specific IDs from `NOTION_DB_IDS` and `TODOIST_CONFIG` vars. Don't hardcode IDs in source.
- `/authorize` enforces a `redirect_uri` host allowlist. Default covers `claude.ai` / `claude.com` / `anthropic.com` (with subdomains) + loopback. Override via the `ALLOWED_REDIRECT_HOSTS` env var (comma-separated, supports `*.suffix`) — don't widen the default in source.
- Login-secret compare is constant-time via SHA-256 equality; don't regress to `===` on raw strings. Rotate `MCP_SIGNING_KEY` to invalidate all live tokens (stateless design has no per-token revocation).
- **OAuth state lives in the `OAUTH_STATE` KV namespace.** Authorization codes are single-use (RFC 6749 §4.1.2) and refresh tokens rotate with reuse-detection via family poisoning (RFC 6819 §5.2.2.3). Keys: `code:<jti>` (5-min TTL), `rt:<jti>` (30-day TTL), `fam:<fam>` (30-day TTL when reuse is detected — invalidates the whole lineage). Legacy tokens missing `jti`/`fam` are rejected; any pre-rollout client must re-auth via /authorize.
- **Todoist IDs go through `assertTodoistId`** before any URL interpolation (and ideally before any body use too). Notion IDs go through `normalizeId`, which now *throws* on non-UUID input. Both block path-pivot attacks (e.g. `task_id:"123/close"` turning an update into a close). Don't bypass — every new handler that takes a user-supplied ID must validate it.
- **`/authorize` POST checks the `Origin` header** — same-origin or absent only. Browser-form CSRF (autofill / password-manager exploit) is blocked here; absent-Origin (curl/server) is allowed for ops use.
- **Upstream error messages are truncated to 200 chars** in `notionReq` / `todoistReq` before being thrown. Don't widen — Notion/Todoist echo request bodies in validation errors and unbounded passthrough leaks caller data into MCP error frames.

## What NOT to do

- Don't add a build step. Wrangler bundles ESM directly.
- Don't add dependencies unless strictly necessary — the Worker is intentionally dependency-free.
- Don't commit `.dev.vars` or anything containing real tokens.
- Don't amend published commits; create new ones.
