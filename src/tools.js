// ─────────────────────────────────────────────
// Tool definitions  (ordered by usage frequency)
// ─────────────────────────────────────────────
export const TOOLS = [
  // ── Todoist: high-frequency ───────────────
  {
    name: "t_get_tasks",
    description:
      "Get Todoist tasks. project_id defaults to Inbox from config (no arg needed for typical use). " +
      "Pass project_id:\"all\" to fetch tasks across every project (no project filter). " +
      "Filter by section (name), section_id, label, filter, or ids[]. " +
      "section: resolve by name (e.g. 'ワクチン接種'). " +
      "compact (default true) returns id/section/co/content/labels/due. " +
      "Default format: tsv. fields: id,section,sid,co(=child_order/section position),content,labels,due,pid,pri,desc,proj,rec,cat.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID, or \"all\" for cross-project" },
        section: { type: "string", description: "Section name (resolved to section_id by Worker)" },
        section_id: { type: "string" },
        label: { type: "string" },
        filter: { type: "string", description: "Todoist filter e.g. '@next & #Inbox'" },
        ids: { type: "array", items: { type: "string" } },
        limit: { type: "number", description: "Max tasks to return (default: all)" },
        compact: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "tsv"], description: "Default: tsv" },
        fields: { type: "array", items: { type: "string" }, description: "Override compact field list" },
      },
    },
  },
  {
    name: "t_update_task",
    description: "Update a Todoist task. due_date supports date expressions (today, today+7d, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        content: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        due_date: { type: "string", description: "Date expression or ISO date" },
        due_string: { type: "string" },
        priority: { type: "number", description: "1=normal, 2=medium, 3=high, 4=urgent" },
        description: { type: "string" },
        section_id: { type: "string" },
        project_id: { type: "string", description: "Move task to another project" },
        parent_id: { type: "string", description: "Parent task ID (set to make subtask, 'none' to promote to top-level)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "t_close_task",
    description: "Mark a Todoist task as completed.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "t_create_task",
    description: "Create a Todoist task. due_date supports date expressions (today, today+7d, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        project_id: { type: "string" },
        section_id: { type: "string" },
        parent_id: { type: "string", description: "Parent task ID to create as subtask" },
        labels: { type: "array", items: { type: "string" } },
        due_date: { type: "string", description: "Date expression or ISO date" },
        due_string: { type: "string" },
        priority: { type: "number", description: "1=normal, 2=medium, 3=high, 4=urgent" },
        description: { type: "string" },
        order: { type: "number" },
      },
      required: ["content"],
    },
  },
  {
    name: "t_delete_task",
    description: "Delete a Todoist task permanently.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "t_bulk",
    description:
      "Execute multiple Todoist operations in one call. " +
      "Actions: update (task_id + fields), close (task_id), delete (task_id), " +
      "create (content + fields). Runs in parallel (max 3 concurrent). " +
      "Use for /review label fixes, batch closes, or sequential task renumbering.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "Array of operations to execute",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["update", "close", "delete", "create"] },
              task_id: { type: "string", description: "Required for update/close/delete" },
              content: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
              due_date: { type: "string", description: "Date expression or ISO date" },
              due_string: { type: "string" },
              priority: { type: "number" },
              description: { type: "string" },
              section_id: { type: "string" },
              project_id: { type: "string" },
              parent_id: { type: "string", description: "Parent task ID for subtask" },
              order: { type: "number" },
            },
            required: ["action"],
          },
        },
      },
      required: ["operations"],
    },
  },
  {
    name: "t_get_sections",
    description:
      "Get sections of a Todoist project. " +
      "Omit project_id (or pass \"all\") to list sections across every project. " +
      "compact:true (default) returns id/name/order (+project_id when cross-project).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID. Omit or pass \"all\" to list across every project." },
        compact: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "tsv"] },
      },
    },
  },
  {
    name: "t_get_projects",
    description: "List all Todoist projects. compact:true (default) returns id/name only.",
    inputSchema: {
      type: "object",
      properties: {
        compact: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "tsv"] },
      },
    },
  },

  // ── Notion: high-frequency ────────────────
  {
    name: "n_query",
    description:
      "Query a Notion database. Accepts collection:// IDs. compact:true (default) compresses output. fetch_all:true auto-paginates (max 500). " +
      "Date expressions supported in filters: today, today+7d, today-30d, etc. " +
      "Optional aggregate: {count, sum, avg, min, max} by property name. " +
      "fields: restrict returned properties to listed names (e.g. [\"ドメイン\"] for index-only fetch).",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        filter: { type: "object" },
        sorts: { type: "array" },
        page_size: { type: "number", default: 20 },
        start_cursor: { type: "string" },
        compact: { type: "boolean", default: true },
        fetch_all: { type: "boolean" },
        fields: { type: "array", items: { type: "string" }, description: "Restrict returned properties to these names only. e.g. [\"ドメイン\"] returns id + ドメイン only." },
        aggregate: {
          type: "object",
          properties: {
            count: { type: "boolean" },
            sum:   { type: "string", description: "Property name to sum" },
            avg:   { type: "string", description: "Property name to average" },
            min:   { type: "string", description: "Property name for minimum" },
            max:   { type: "string", description: "Property name for maximum" },
            first: { type: "string", description: "Property name: value of first result" },
            last:  { type: "string", description: "Property name: value of last result" },
            delta: { type: "string", description: "Property name: last minus first" },
            only_agg: { type: "boolean", description: "Return aggregations only, omit results (saves tokens)" },
          },
        },
      },
      required: ["database_id"],
    },
  },
  {
    name: "n_create_page",
    description:
      "Create a page in a Notion database. Date values support expressions. " +
      "content: Markdown (# h1, - bullet, **bold**, ```code```, etc.) " +
      "Property shorthand: string→rich_text, number→number, bool→checkbox, " +
      "[\"a\",\"b\"]→multi_select, {title:\"s\"}, {select:\"s\"}, {date:\"expr\"}, {multi_select:[\"a\"]}.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        properties: { type: "object" },
        content: { type: "string", description: "Optional Markdown body" },
      },
      required: ["database_id", "properties"],
    },
  },
  {
    name: "n_update_page",
    description:
      "Update properties or body content of a Notion page. " +
      "archived:true moves the page to trash (deletion); archived:false restores. " +
      "For a deletion-only call, prefer n_delete_page — this is the same archive op wrapped for clarity. " +
      "replace_content: Markdown string to replace the entire page body. " +
      "append_content: Markdown string to append blocks at the end of the page. " +
      "Property shorthand: string→rich_text, number→number, bool→checkbox, " +
      "[\"a\",\"b\"]→multi_select, {title:\"s\"}, {select:\"s\"}, {date:\"expr\"}, {multi_select:[\"a\"]}.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        properties: { type: "object" },
        archived: { type: "boolean" },
        replace_content: { type: "string", description: "Markdown — replaces all existing blocks" },
        append_content: { type: "string", description: "Markdown — appends blocks after existing content" },
      },
      required: ["page_id"],
    },
  },

  {
    name: "n_delete_page",
    description:
      "Delete a Notion page by archiving it (moves to trash). " +
      "Equivalent to n_update_page with archived:true — use this when deletion is the only intent. " +
      "Pass restore:true to un-archive instead.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        restore: { type: "boolean", description: "true = un-archive (restore from trash)" },
      },
      required: ["page_id"],
    },
  },

  {
    name: "n_bulk",
    description:
      "Execute multiple Notion operations in one call. " +
      "Accepts `ops` (preferred) or `operations` (alias of t_bulk for cross-tool ergonomics); each item accepts `op` or `action`. " +
      "op:\"create\" {database_id, properties, content?} — same semantics as n_create_page (property shorthand + Markdown body). " +
      "op:\"update\" {page_id, properties?, append_content?, replace_content?, archived?} — same as n_update_page. " +
      "op:\"delete\" {page_id} — archives the page. " +
      "Returns per-op results [{index, op, ok, id?, url?, error?}]; one failure does NOT abort the rest. " +
      "Subrequest-budget aware: processes ops until the per-Worker-invocation budget (SUBREQUEST_BUDGET env var, default 50 = Cloudflare free tier) would be exceeded, then returns remaining + next_cursor. " +
      "Re-call with start_cursor:<next_cursor> to continue — loop until remaining is absent. " +
      "For full-body page replacement prefer delete + create over replace_content (which deletes blocks one-by-one and is budget-capped, leaving stale_blocks if the budget is hit).",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Operations to execute in order. Alias: `operations`.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["create", "update", "delete"], description: "Alias: `action`" },
              action: { type: "string", enum: ["create", "update", "delete"], description: "Alias of `op` for t_bulk parity" },
              database_id: { type: "string", description: "Required for create" },
              page_id: { type: "string", description: "Required for update/delete" },
              properties: { type: "object", description: "Property shorthand (create/update)" },
              content: { type: "string", description: "Markdown body (create)" },
              append_content: { type: "string", description: "Markdown appended after existing blocks (update)" },
              replace_content: { type: "string", description: "Markdown replacing the whole body (update) — prefer delete+create" },
              archived: { type: "boolean", description: "true trashes the page (update)" },
            },
          },
        },
        operations: { type: "array", description: "Alias of `ops` (for symmetry with t_bulk)." },
        start_cursor: { type: "number", description: "Resume from this op index (use the next_cursor from a prior call)" },
        format: { type: "string", enum: ["json", "tsv"], description: "Result formatting. Default: json" },
      },
    },
  },

  {
    name: "n_bulk_metrics",
    description:
      "Sugar over n_bulk for the 📊 Metrics DB: bulk-log many same-date metrics in one call. " +
      "n_bulk_metrics({date, entries:[{指標, 値, 単位?, メモ?}], mode?}). " +
      "Each entry becomes a write op: title エントリ=`YYYY-MM-DD_指標名`, 指標 (select, auto-created if new), 値 (number), 日付 (date), optional 単位/メモ (rich_text). " +
      "date accepts a date expression (today, today-7d, …) or ISO date. " +
      "mode (default \"create\" for backward compat): " +
      "\"create\" = always insert (may duplicate on re-runs); " +
      "\"upsert\" = update if a row with the same エントリ title already exists, else create; " +
      "\"skip_existing\" = leave the existing row untouched, return status:\"skipped\". " +
      "**Use \"skip_existing\" or \"upsert\" for backfills / re-runs** — \"create\" mode is duplicate-prone. " +
      "Returns per-entry status: \"created\" | \"updated\" | \"skipped\" | \"error\". " +
      "指標 names are normalized via the optional METRIC_ALIASES env var (JSON map, e.g. {\"γGT\":\"γGTP\",\"Cr\":\"クレアチニン\"}) so synonyms don't fork the select. " +
      "Same subrequest-budget chunking + start_cursor continuation as n_bulk. " +
      "Defaults to NOTION_DB_IDS.metrics; override with database_id.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date expression or ISO date for 日付 and the エントリ title prefix" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              "指標": { type: "string", description: "Metric name (select value); normalized via METRIC_ALIASES if set" },
              "値": { type: "number", description: "Numeric value" },
              "単位": { type: "string", description: "Optional unit" },
              "メモ": { type: "string", description: "Optional note" },
            },
            required: ["指標", "値"],
          },
        },
        mode: {
          type: "string",
          enum: ["create", "upsert", "skip_existing"],
          description: "Collision behavior when the エントリ title already exists. Default \"create\" (backward-compat). Use \"skip_existing\" or \"upsert\" for backfills.",
        },
        database_id: { type: "string", description: "Override the Metrics DB id (default: NOTION_DB_IDS.metrics)" },
        start_cursor: { type: "number", description: "Resume from this entry index" },
        format: { type: "string", enum: ["json", "tsv"], description: "Result formatting. Default: json" },
      },
      required: ["date", "entries"],
    },
  },

  {
    name: "n_metrics_series",
    description:
      "Trend-read sugar over the 📊 Metrics DB: fetch a single 指標 series with summary stats in one call. " +
      "n_metrics_series({指標, from?, to?, limit?}) → {指標, count, series:[{date,値,単位?,メモ?}], stats:{first,last,delta,min,max,avg,median,count}}. " +
      "Replaces the n_query → filter → sorts → stats boilerplate. " +
      "from / to accept date expressions (today, today-30d, today-1y, …) or ISO dates; both optional. " +
      "Sorted ascending by 日付. 指標 is normalized via METRIC_ALIASES env var (same as n_bulk_metrics). " +
      "Auto-paginates up to 500 rows / 5 query pages.",
    inputSchema: {
      type: "object",
      properties: {
        "指標": { type: "string", description: "Metric name (select value); normalized via METRIC_ALIASES" },
        from: { type: "string", description: "Inclusive lower bound on 日付. Date expression or ISO date." },
        to: { type: "string", description: "Inclusive upper bound on 日付. Date expression or ISO date." },
        limit: { type: "number", description: "Cap series length (after sort). Default: all up to 500." },
        database_id: { type: "string", description: "Override the Metrics DB id (default: NOTION_DB_IDS.metrics)" },
        format: { type: "string", enum: ["json", "tsv"], description: "Series formatting (stats are always JSON). Default: json" },
      },
      required: ["指標"],
    },
  },

  // ── Utility ───────────────────────────────
  {
    name: "eval_date",
    description: "Resolve a JST date expression to ISO date. Supports: today, yesterday, tomorrow, today+7d, today-30d, today+2w, today+1m, now.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate a math expression. Supports Math.*. e.g. \"1400*1.2\", \"Math.round(56.4*0.185)\".",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  {
    name: "stats",
    description: "Compute statistics from a number array: count, sum, avg, min, max, first, last, delta (last−first), median. Pass round to round all results. Use after n_query to analyze extracted values.",
    inputSchema: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "number" }, description: "Array of numbers" },
        round: { type: "number", description: "Decimal places to round (optional)" },
      },
      required: ["values"],
    },
  },

  // ── Notion: lower-frequency ───────────────
  {
    name: "n_get_page",
    description: "Get a Notion page by ID (all properties).",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" } },
      required: ["page_id"],
    },
  },
  {
    name: "n_get_blocks",
    description: "Get page body as plain text blocks. Use when you need page content, not just properties.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        page_size: { type: "number", default: 100 },
      },
      required: ["page_id"],
    },
  },
  {
    name: "n_get_schema",
    description: "Get property schema of a Notion database. Accepts collection:// IDs.",
    inputSchema: {
      type: "object",
      properties: { database_id: { type: "string" } },
      required: ["database_id"],
    },
  },
  {
    name: "n_search",
    description:
      "Search Notion workspace. Default path uses Notion's /search API (title-only — body/property text is NOT indexed). " +
      "search_body:true enables body-text scan: fans out up to max_scan accessible pages (default 50, max 100), fetches each page's blocks, and filters by substring match against title+body. Expensive; use with a non-empty query. " +
      "query is optional for the default path — omit (or pass empty string) with type:\"database\" to list all databases the integration can access, " +
      "or with type:\"page\" to list all accessible top-level pages (useful for finding a parent_page_id before n_create_database). " +
      "include_properties:true returns compact properties for each page result so the caller can filter client-side.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match. For default path: title only. For search_body:true: title + body text." },
        type: { type: "string", enum: ["page", "database"] },
        page_size: { type: "number", default: 10 },
        include_properties: { type: "boolean", description: "Include compact properties for page results (default false)" },
        search_body: { type: "boolean", description: "Enable full-text body scan (bounded by max_scan). Requires query." },
        max_scan: { type: "number", description: "Max accessible pages to fetch+scan when search_body:true. Default 50, hard cap 100." },
      },
    },
  },

  // ── Todoist: lower-frequency ──────────────
  {
    name: "t_get_task",
    description: "Get a single Todoist task by ID. compact:true (default) strips to essential fields.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        compact: { type: "boolean", default: true },
        fields: { type: "array", items: { type: "string" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "t_reopen_task",
    description: "Reopen a completed Todoist task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "t_get_completed_tasks",
    description:
      "Get completed Todoist tasks. Defaults to the last 7 days, Inbox project. " +
      "section_id / project_id are filtered Worker-side (not by Todoist API). " +
      "Use for /review step 3: checking which #1 tasks finished so next can be promoted. " +
      "compact:true (default) strips fields. format:'tsv' for token savings.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project (Worker-side)" },
        section_id: { type: "string", description: "Filter by section (Worker-side)" },
        since: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        until: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        limit: { type: "number", description: "Max tasks (default 50, max 200)" },
        compact: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "tsv"] },
        fields: { type: "array", items: { type: "string" }, description: "Field list (adds 'cat' for completed_at by default)" },
      },
    },
  },
  {
    name: "t_get_labels",
    description: "List all personal labels in Todoist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "t_create_section",
    description: "Create a new section in a Todoist project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        project_id: { type: "string" },
        order: { type: "number" },
      },
      required: ["name", "project_id"],
    },
  },
  {
    name: "t_update_section",
    description: "Rename a Todoist section.",
    inputSchema: {
      type: "object",
      properties: {
        section_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["section_id", "name"],
    },
  },
  {
    name: "t_delete_section",
    description: "Delete a Todoist section (and all tasks within it).",
    inputSchema: {
      type: "object",
      properties: { section_id: { type: "string" } },
      required: ["section_id"],
    },
  },

  // ── Notion: rarely needed ─────────────────
  {
    name: "n_create_database",
    description:
      "Create a new Notion database under a parent page. " +
      "properties must include a title-type property. " +
      "e.g. {\"Name\":{\"title\":{}},\"Date\":{\"date\":{}},\"Value\":{\"number\":{}}}",
    inputSchema: {
      type: "object",
      properties: {
        parent_page_id: { type: "string" },
        title: { type: "string" },
        properties: { type: "object", description: "Notion property schema" },
        icon: { type: "string", description: "Emoji e.g. 📊" },
      },
      required: ["parent_page_id", "title", "properties"],
    },
  },
  {
    name: "n_update_schema",
    description:
      "Add/remove columns, rename, or archive a Notion database. " +
      "add: {col: schema}, remove: [colNames]. " +
      "archived:true moves the database to trash (archived:false restores). " +
      "Use this for cleanup of databases created via n_create_database.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        add: { type: "object" },
        remove: { type: "array", items: { type: "string" } },
        title: { type: "string", description: "Rename the database" },
        archived: { type: "boolean", description: "true = move DB to trash, false = restore" },
      },
      required: ["database_id"],
    },
  },

  // ── Todoist: project management ───────────
  {
    name: "t_create_project",
    description: "Create a new Todoist project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        color: { type: "string" },
        is_favorite: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "t_update_project",
    description: "Update a Todoist project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        is_favorite: { type: "boolean" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "t_delete_project",
    description: "Delete a Todoist project permanently.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },

  // ── Context (conversation bootstrap) ──────
  {
    name: "context",
    description:
      "Single-call conversation bootstrap. Fetches configured context sources in parallel. " +
      "Resolution order per slot: per-call args > CONTEXT_CONFIG env var > legacy defaults " +
      "(TODOIST_CONFIG.inbox_project_id + NOTION_DB_IDS.habits_page). " +
      "Call this once at the start of every conversation. " +
      "Args: tasks ({project_id, fields?} or false to skip); pages ([{id, label?}] — full override); " +
      "extra_pages ([{id, label?}] — appended on top of effective pages); " +
      "queries ([{database_id, label, filter?, sorts?, page_size?}] — n_query-style compact results).",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          description: "Todoist tasks config. {project_id, fields?} or false to skip.",
          oneOf: [
            { type: "object", properties: { project_id: { type: "string" }, fields: { type: "array", items: { type: "string" } } } },
            { type: "boolean" },
            { type: "null" },
          ],
        },
        pages: {
          type: "array",
          description: "Full override of Notion pages to fetch. Each: {id, label?}.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id"],
          },
        },
        extra_pages: {
          type: "array",
          description: "Notion pages appended on top of the effective pages config.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id"],
          },
        },
        queries: {
          type: "array",
          description: "Notion database queries. Each: {database_id, label, filter?, sorts?, page_size?}.",
          items: {
            type: "object",
            properties: {
              database_id: { type: "string" },
              label: { type: "string" },
              filter: { type: "object" },
              sorts: { type: "array" },
              page_size: { type: "number" },
            },
            required: ["database_id", "label"],
          },
        },
      },
    },
  },

  // ── Meta ──────────────────────────────────
  {
    name: "help",
    description:
      "Returns full tool list: all tool names and inputSchemas. Also returns static config: Notion DB IDs (state, metrics, events, food_master) and Todoist inbox project ID and section IDs.",
    inputSchema: { type: "object", properties: {} },
  },
];
