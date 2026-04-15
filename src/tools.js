// ─────────────────────────────────────────────
// Tool definitions  (ordered by usage frequency)
// ─────────────────────────────────────────────
export const TOOLS = [
  // ── Todoist: high-frequency ───────────────
  {
    name: "t_get_tasks",
    description:
      "Get Todoist tasks. project_id defaults to Inbox from config (no arg needed for typical use). " +
      "Filter by section (name), section_id, label, filter, or ids[]. " +
      "section: resolve by name (e.g. 'ワクチン接種'). " +
      "compact (default true) returns id/section/co/content/labels/due. " +
      "Default format: tsv. fields: id,section,sid,co(=child_order/section position),content,labels,due,pid,pri,desc,proj,rec,cat.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
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
    description: "Get sections of a Todoist project. compact:true (default) returns id/name/order only.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        compact: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "tsv"] },
      },
      required: ["project_id"],
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
      "archived:true to trash. " +
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
      "Search Notion workspace by title. " +
      "query is optional — omit (or pass empty string) with type:\"database\" to list all databases the integration can access, " +
      "or with type:\"page\" to list all accessible top-level pages (useful for finding a parent_page_id before n_create_database).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Title substring; omit to list everything accessible" },
        type: { type: "string", enum: ["page", "database"] },
        page_size: { type: "number", default: 10 },
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
      "Single-call conversation bootstrap. Returns Todoist all tasks (Inbox) + Notion habits page blocks in parallel. " +
      "No arguments required — reads inbox_project_id from TODOIST_CONFIG and habits_page from NOTION_DB_IDS. " +
      "Call this once at the start of every conversation.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Meta ──────────────────────────────────
  {
    name: "help",
    description:
      "Returns full tool list: all tool names and inputSchemas. Also returns static config: Notion DB IDs (state, metrics, events, food_master) and Todoist inbox project ID and section IDs.",
    inputSchema: { type: "object", properties: {} },
  },
];
