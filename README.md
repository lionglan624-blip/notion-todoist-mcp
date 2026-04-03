# notion-todoist-mcp

A custom [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server running on Cloudflare Workers that provides Claude with full read/write access to Notion and Todoist.

## Features

### Todoist (14 tools)

| Tool | Description |
|------|-------------|
| `t_get_tasks` | Query tasks by project, section (name), label, filter, or IDs. Compact TSV output by default |
| `t_create_task` | Create a task with labels, due date, priority, section, subtask support |
| `t_update_task` | Update any task field including move between projects/sections |
| `t_close_task` | Mark a task as completed |
| `t_delete_task` | Permanently delete a task |
| `t_reopen_task` | Reopen a completed task |
| `t_bulk` | Execute multiple operations (create/update/close/delete) in one call with concurrency control |
| `t_get_completed_tasks` | Query completed tasks with date range filtering |
| `t_get_projects` | List all projects |
| `t_create_project` | Create a new project |
| `t_update_project` | Update project name/color/favorite |
| `t_delete_project` | Delete a project |
| `t_get_sections` | List sections in a project |
| `t_create_section` / `t_update_section` / `t_delete_section` | Manage sections |
| `t_get_labels` | List all personal labels |

### Notion (7 tools)

| Tool | Description |
|------|-------------|
| `n_query` | Query a database with filters, sorts, auto-pagination, and aggregations (sum/avg/min/max/delta) |
| `n_create_page` | Create a page with property shorthand and Markdown body |
| `n_update_page` | Update properties, replace or append page body content |
| `n_get_page` | Get a single page with all properties |
| `n_get_blocks` | Get page body as plain text blocks |
| `n_get_schema` | Get database property schema |
| `n_search` | Search workspace by title |
| `n_create_database` | Create a new database under a parent page |
| `n_update_schema` | Add/remove columns or rename a database |

### Utilities (3 tools)

| Tool | Description |
|------|-------------|
| `eval_date` | Resolve JST date expressions (`today`, `today+7d`, `yesterday`, `today-2w`, `now`, etc.) |
| `calculate` | Safe math evaluator with `Math.*` support (no `eval`) |
| `stats` | Compute statistics (count, sum, avg, min, max, median, delta) from a number array |

## Key Design Choices

- **Compact output** — Properties are flattened to simple values; default format is TSV to minimize token usage
- **Date expressions** — `today`, `today+7d`, `today-30d`, `tomorrow`, `today+1m`, `now` etc. are resolved in JST
- **Property shorthand** — `"text"` becomes `rich_text`, `123` becomes `number`, `true` becomes `checkbox`, `["a","b"]` becomes `multi_select`
- **Markdown body** — Page content accepts Markdown (headings, bullets, numbered lists, code blocks, bold/italic/code inline)
- **Rate limit handling** — Both Notion and Todoist requests auto-retry on 429 with exponential backoff
- **Bulk operations** — `t_bulk` runs up to 3 concurrent operations to stay within rate limits

## Setup

### 1. Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

### 2. Set secrets

```bash
npx wrangler secret put NOTION_TOKEN    # Notion integration token
npx wrangler secret put TODOIST_TOKEN   # Todoist API token
```

### 3. Notion integration setup

1. Go to [Notion Integrations](https://www.notion.so/my-integrations) and create a new integration
2. Copy the integration token
3. Share each database you want to access with the integration

### 4. Todoist API token

1. Go to [Todoist Settings > Integrations > Developer](https://todoist.com/app/settings/integrations/developer)
2. Copy your API token

### 5. Register as MCP server

Add to your Claude Desktop / Claude Code MCP config:

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
| `/mcp` or `/` | POST | MCP JSON-RPC endpoint |
| `/health` | GET | Health check (returns tool count) |

## Customization

The `help` tool returns a static config with pre-configured Notion database IDs and Todoist project IDs. Edit the `help` handler in `worker.js` to match your own workspace setup.

## License

MIT
