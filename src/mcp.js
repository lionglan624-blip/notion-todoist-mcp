import { evalDate, resolveFilterDates, safeMath, sleep, normalizeId, extractNum } from "./utils.js";
import {
  notionReq, compactProps, appendBlocksChunked, mdToBlocks,
  resolvePropDates, normalizeProperties, NOTION_CHILDREN_BATCH,
} from "./notion.js";
import {
  TASK_COMPACT_DEFAULTS, compactTask, buildSectionMap, compactSection,
  compactProject, toTSV, formatTodoistList, todoistReq, todoistSync,
} from "./todoist.js";
import { verifyToken } from "./oauth.js";
import { TOOLS } from "./tools.js";

const MCP_VERSION = "2024-11-05";

// ─────────────────────────────────────────────
// Tool handlers — dispatched via TOOL_HANDLERS map below.
// Each handler receives (args, ctx) where ctx = { env, nt, tt }.
// ─────────────────────────────────────────────
const TOOL_HANDLERS = {
  // ── Utility ──
  eval_date: (args) => ({ expression: args.expression, resolved: evalDate(args.expression) }),

  calculate: (args) => {
    const result = safeMath(args.expression);
    return { expression: args.expression, result };
  },

  stats: (args) => {
    const nums = (args.values || []).filter(n => typeof n === "number" && !isNaN(n));
    if (!nums.length) return { error: "No valid numbers provided" };
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const r = args.round ?? null;
    const fmt = (n) => r !== null ? Math.round(n * 10 ** r) / 10 ** r : n;
    return {
      count: nums.length,
      sum: fmt(sum),
      avg: fmt(avg),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      first: nums[0],
      last: nums[nums.length - 1],
      delta: fmt(nums[nums.length - 1] - nums[0]),
      median: fmt(median),
    };
  },

  // ── Notion ──
  n_get_schema: async (args, { nt }) => {
      const id = normalizeId(args.database_id);
      const db = await notionReq(nt, "GET", `/databases/${id}`);
      const schema = {};
      for (const [pname, prop] of Object.entries(db.properties)) {
        schema[pname] = { type: prop.type };
        if (prop.select)       schema[pname].options = prop.select.options.map(o => o.name);
        if (prop.multi_select) schema[pname].options = prop.multi_select.options.map(o => o.name);
        if (prop.status)       schema[pname].options = prop.status.options?.map(o => o.name);
        if (prop.relation)     schema[pname].database_id = prop.relation.database_id;
        if (prop.number)       schema[pname].format = prop.number.format;
      }
    return { title: db.title?.[0]?.plain_text, database_id: id, properties: schema };
  },

  n_query: async (args, { nt }) => {
      const id = normalizeId(args.database_id);
      // When auto-paginating, default to the Notion API max (100) so the
      // 5-page safety cap actually reaches the 500-row hard limit.
      const defaultPageSize = args.fetch_all === true ? 100 : 20;
      const body = { page_size: args.page_size ?? defaultPageSize };
      if (args.filter) body.filter = resolveFilterDates(args.filter);
      if (args.sorts)  body.sorts = args.sorts;

      // 自動ページネーション (fetch_all:true 指定時)
      // 3req/s制限対応: ページ切り替え間に350msウェイト
      const allPages = [];
      let cursor = args.start_cursor ?? null;
      let remaining = true;
      let fetchCount = 0;

      while (remaining) {
        if (cursor) body.start_cursor = cursor;
        else delete body.start_cursor;

        if (fetchCount > 0) await sleep(350);
        const res = await notionReq(nt, "POST", `/databases/${id}/query`, body);
        fetchCount++;

        for (const p of res.results) {
          let props = args.compact !== false ? compactProps(p.properties) : p.properties;
          if (args.fields && args.fields.length) {
            props = Object.fromEntries(args.fields.map(f => [f, props[f] ?? null]));
          }
          allPages.push({
            id: p.id, url: p.url,
            created_time: p.created_time,
            last_edited_time: p.last_edited_time,
            properties: props,
          });
        }

        cursor = res.next_cursor;
        // fetch_all=true かつ続きがある場合のみ継続（安全上限: 500件 or 5ページ）
        remaining = args.fetch_all === true && res.has_more
          && allPages.length < 500 && fetchCount < 5;
      }

      const pages = allPages;
      const out = {
        result_count: pages.length,
        fetched_pages: fetchCount,
        has_more: cursor != null,
        next_cursor: cursor,
        results: pages,
      };

      if (args.aggregate) {
        const agg = args.aggregate;
        out.aggregations = {};
        if (agg.count) out.aggregations.count = pages.length;
        for (const op of ["sum", "avg", "min", "max", "first", "last", "delta"]) {
          const prop = agg[op];
          if (!prop) continue;
          // compactProps already reduces to scalar; handle both scalar and Notion property object
          const nums = pages.map(p => {
            const v = p.properties[prop];
            return typeof v === "number" ? v : extractNum(v);
          }).filter(n => typeof n === "number" && !isNaN(n));
          if (!nums.length) continue;
          const sum = nums.reduce((a, b) => a + b, 0);
          if (op === "sum")   out.aggregations[`sum_${prop}`]   = sum;
          if (op === "avg")   out.aggregations[`avg_${prop}`]   = sum / nums.length;
          if (op === "min")   out.aggregations[`min_${prop}`]   = Math.min(...nums);
          if (op === "max")   out.aggregations[`max_${prop}`]   = Math.max(...nums);
          if (op === "first") out.aggregations[`first_${prop}`] = nums[0];
          if (op === "last")  out.aggregations[`last_${prop}`]  = nums[nums.length - 1];
          if (op === "delta") out.aggregations[`delta_${prop}`] = nums[nums.length - 1] - nums[0];
        }
        // only_agg:true → aggregations only (skip results to save tokens)
        if (agg.only_agg) {
          return { result_count: pages.length, aggregations: out.aggregations };
        }
      }
      return out;
  },

  n_get_page: async (args, { nt }) => {
    const p = await notionReq(nt, "GET", `/pages/${normalizeId(args.page_id)}`);
    return { id: p.id, url: p.url, created_time: p.created_time, last_edited_time: p.last_edited_time, properties: p.properties };
  },

  n_get_blocks: async (args, { nt }) => {
      const id = normalizeId(args.page_id);
      const pageSize = args.page_size ?? 100;
      const res = await notionReq(nt, "GET", `/blocks/${id}/children?page_size=${pageSize}`);
      const extractText = (richTexts) => (richTexts || []).map(t => t.plain_text).join("");
      const blocks = res.results.map(b => {
        const type = b.type;
        const content = b[type];
        let text = "";
        if (content?.rich_text) text = extractText(content.rich_text);
        if (content?.title)     text = extractText(content.title);
        return { id: b.id, type, text, has_children: b.has_children };
      });
      return { block_count: blocks.length, has_more: res.has_more, next_cursor: res.next_cursor, blocks };
  },

  n_create_database: async (args, { nt }) => {
      const body = {
        parent: { page_id: normalizeId(args.parent_page_id) },
        title: [{ type: "text", text: { content: args.title } }],
        properties: args.properties,
      };
      if (args.icon) body.icon = { type: "emoji", emoji: args.icon };
      const db = await notionReq(nt, "POST", "/databases", body);
      return { id: db.id, url: db.url, title: args.title };
  },

  n_update_schema: async (args, { nt }) => {
      const id = normalizeId(args.database_id);
      const body = {};
      if (args.title) {
        body.title = [{ type: "text", text: { content: args.title } }];
      }
      if (args.add || args.remove) {
        body.properties = {};
        if (args.add) {
          Object.assign(body.properties, args.add);
        }
        if (args.remove) {
          for (const col of args.remove) {
            body.properties[col] = null;
          }
        }
      }
      if (args.archived !== undefined) body.archived = args.archived;
      const db = await notionReq(nt, "PATCH", `/databases/${id}`, body);
      return { id: db.id, url: db.url, last_edited_time: db.last_edited_time };
  },

  n_create_page: async (args, { nt }) => {
      const id = normalizeId(args.database_id);
      const body = {
        parent: { database_id: id },
        properties: resolvePropDates(normalizeProperties(args.properties)),
      };
      let overflowBlocks = [];
      if (args.content) {
        const blocks = mdToBlocks(args.content);
        if (blocks.length) {
          body.children = blocks.slice(0, NOTION_CHILDREN_BATCH);
          overflowBlocks = blocks.slice(NOTION_CHILDREN_BATCH);
        }
      }
      const p = await notionReq(nt, "POST", "/pages", body);
      if (overflowBlocks.length) {
        await appendBlocksChunked(nt, p.id, overflowBlocks);
      }
      return { id: p.id, url: p.url, created_time: p.created_time };
  },

  n_update_page: async (args, { nt }) => {
      const pid = normalizeId(args.page_id);
      let replaceWarnings = null;
      // 1. Property / archived update
      if (args.properties || args.archived !== undefined) {
        const body = {};
        if (args.properties) body.properties = resolvePropDates(normalizeProperties(args.properties));
        if (args.archived !== undefined) body.archived = args.archived;
        await notionReq(nt, "PATCH", `/pages/${pid}`, body);
      }
      // 2. replace_content: append new blocks FIRST, then delete old ones.
      // Order matters: if we deleted first and the append failed, the page
      // would be wiped. Appending first means a partial failure leaves the
      // old content intact alongside the new content (recoverable).
      if (args.replace_content !== undefined) {
        // Snapshot existing children (page_size=100 is the Notion API max)
        const oldBlocks = [];
        let cursor;
        do {
          const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : `?page_size=100`;
          const page = await notionReq(nt, "GET", `/blocks/${pid}/children${qs}`);
          oldBlocks.push(...page.results);
          cursor = page.has_more ? page.next_cursor : null;
        } while (cursor);

        const newBlocks = mdToBlocks(args.replace_content);
        if (newBlocks.length) {
          await appendBlocksChunked(nt, pid, newBlocks);
        }
        // Only delete old blocks after new content is safely in place.
        // Track deletion failures so the caller knows the page has stale blocks.
        const deleteFailures = [];
        for (const blk of oldBlocks) {
          try {
            await notionReq(nt, "DELETE", `/blocks/${blk.id}`);
          } catch (e) {
            deleteFailures.push({ id: blk.id, error: e.message });
          }
        }
        if (deleteFailures.length) {
          // Non-fatal: surface as a warning so the caller can clean up.
          replaceWarnings = deleteFailures;
        }
      }
      // 3. append_content: append blocks after existing content
      if (args.append_content) {
        const appendBlocks = mdToBlocks(args.append_content);
        if (appendBlocks.length) {
          await appendBlocksChunked(nt, pid, appendBlocks);
        }
      }
      const p = await notionReq(nt, "GET", `/pages/${pid}`);
      const out = { id: p.id, url: p.url, last_edited_time: p.last_edited_time };
      if (replaceWarnings) out.replace_warnings = replaceWarnings;
      return out;
  },

  n_search: async (args, { nt }) => {
      // query is optional — Notion accepts an empty query and returns everything
      // the integration can access, filtered by the object-type filter below.
      const body = { query: args.query ?? "", page_size: args.page_size ?? 10 };
      if (args.type) body.filter = { value: args.type, property: "object" };
      const res = await notionReq(nt, "POST", "/search", body);
      // Page title lives under whichever property is typed "title" — the key
      // is not always "title" (often "Name" or a localized label), so scan.
      const extractPageTitle = (props) => {
        if (!props) return null;
        for (const v of Object.values(props)) {
          if (v?.type === "title") return v.title?.map(t => t.plain_text).join("") || null;
        }
        return null;
      };
      return {
        results: res.results.map(r => ({
          id: r.id, type: r.object, url: r.url,
          title: r.title?.map(t => t.plain_text).join("") || extractPageTitle(r.properties) || "(untitled)",
          last_edited_time: r.last_edited_time,
        })),
        has_more: res.has_more,
      };
  },

  // ── Todoist ──
  t_get_projects: async (args, { tt }) => {
      const raw = await todoistReq(tt, "GET", "/projects");
      const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
      return formatTodoistList(items, (p) => compactProject(p), args);
  },

  t_get_sections: async (args, { tt }) => {
      const raw = await todoistReq(tt, "GET", `/sections?project_id=${args.project_id}`);
      const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
      return formatTodoistList(items, (s) => compactSection(s), args);
  },

  t_create_section: async (args, { tt }) => {
    const body = { name: args.name, project_id: args.project_id };
    if (args.order !== undefined) body.order = args.order;
    return todoistReq(tt, "POST", "/sections", body);
  },

  t_get_labels: async (args, { tt }) => todoistReq(tt, "GET", "/labels"),

  t_create_project: async (args, { tt }) => {
      const body = { name: args.name };
      if (args.color)       body.color = args.color;
      if (args.is_favorite !== undefined) body.is_favorite = args.is_favorite;
      return todoistReq(tt, "POST", "/projects", body);
  },

  t_update_project: async (args, { tt }) => {
      const { project_id, ...rest } = args;
      const body = {};
      if (rest.name)        body.name = rest.name;
      if (rest.color)       body.color = rest.color;
      if (rest.is_favorite !== undefined) body.is_favorite = rest.is_favorite;
      return todoistReq(tt, "POST", `/projects/${project_id}`, body);
  },

  t_delete_project: async (args, { tt }) => {
    await todoistReq(tt, "DELETE", `/projects/${args.project_id}`);
    return { success: true, project_id: args.project_id };
  },

  t_update_section: async (args, { tt }) =>
    todoistReq(tt, "POST", `/sections/${args.section_id}`, { name: args.name }),

  t_delete_section: async (args, { tt }) => {
    await todoistReq(tt, "DELETE", `/sections/${args.section_id}`);
    return { success: true, section_id: args.section_id };
  },

  t_get_task: async (args, { tt }) => {
      const raw = await todoistReq(tt, "GET", `/tasks/${args.task_id}`);
      if (args.compact === false) return raw;
      // Resolve section name if 'section' field is requested
      const f = args.fields || TASK_COMPACT_DEFAULTS;
      let secMap = null;
      if (f.includes("section") && raw.section_id && raw.project_id) {
        const { map } = await buildSectionMap(tt, raw.project_id);
        secMap = map;
      }
      return compactTask(raw, args.fields, secMap);
  },

  t_get_tasks: async (args, { env, tt }) => {
      // Default project_id from config if not specified and no filter/label/ids
      let projectId = args.project_id;
      if (!projectId && !args.filter && !args.label && !args.ids?.length) {
        try { projectId = JSON.parse(env.TODOIST_CONFIG).inbox_project_id; } catch {}
      }

      // Resolve section name → section_id
      let sectionId = args.section_id;
      let sectionMap = null;
      const needsSectionName = (args.fields || TASK_COMPACT_DEFAULTS).includes("section");

      if (args.section || needsSectionName) {
        const pid = projectId || args.project_id;
        if (!pid) {
          // Explicit section-name lookup requires a project; defaulted field
          // list ("section") can degrade silently so filter/ids/label calls
          // aren't blocked.
          if (args.section) {
            return { error: "project_id is required when filtering by section name" };
          }
        } else {
          const { map, sections } = await buildSectionMap(tt, pid);
          sectionMap = map;
          if (args.section) {
            const match = sections.find(s =>
              s.name === args.section || s.name.includes(args.section)
            );
            if (!match) return { error: `Section not found: "${args.section}". Available: ${sections.map(s => s.name).join(", ")}` };
            sectionId = match.id;
          }
        }
      }

      const params = new URLSearchParams();
      if (projectId)       params.set("project_id", projectId);
      if (sectionId)       params.set("section_id", sectionId);
      if (args.label)      params.set("label", args.label);
      if (args.filter)     params.set("filter", args.filter);
      if (args.ids?.length) params.set("ids", args.ids.join(","));
      if (args.limit)      params.set("limit", String(args.limit));
      const qs = params.toString();
      const raw = await todoistReq(tt, "GET", `/tasks${qs ? "?" + qs : ""}`);
      const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
      return formatTodoistList(items, (t) => compactTask(t, args.fields, sectionMap), args);
  },

  t_create_task: async (args, { tt }) => {
      const body = { content: args.content };
      if (args.project_id)  body.project_id = args.project_id;
      if (args.section_id)  body.section_id = args.section_id;
      if (args.parent_id)   body.parent_id = args.parent_id;
      if (args.labels)      body.labels = args.labels;
      if (args.priority !== undefined) body.priority = args.priority;
      if (args.description) body.description = args.description;
      if (args.order !== undefined) body.order = args.order;
      if (args.due_date)   body.due_date = evalDate(args.due_date);
      if (args.due_string) body.due_string = args.due_string;
      return todoistReq(tt, "POST", "/tasks", body);
  },

  t_update_task: async (args, { tt }) => {
      const { task_id, ...rest } = args;
      const body = {};
      if (rest.content)     body.content = rest.content;
      if (rest.labels)      body.labels = rest.labels;
      if (rest.priority !== undefined) body.priority = rest.priority;
      if (rest.description) body.description = rest.description;
      if (rest.section_id)  body.section_id = rest.section_id;
      if (rest.project_id)  body.project_id = rest.project_id;
      if (rest.parent_id !== undefined) body.parent_id = (rest.parent_id === "" || rest.parent_id === "none") ? null : rest.parent_id;
      if (rest.due_date)    body.due_date = evalDate(rest.due_date);
      if (rest.due_string)  body.due_string = rest.due_string;
      return todoistReq(tt, "POST", `/tasks/${task_id}`, body);
  },

  t_close_task: async (args, { tt }) => {
    await todoistReq(tt, "POST", `/tasks/${args.task_id}/close`);
    return { success: true, task_id: args.task_id };
  },

  t_reopen_task: async (args, { tt }) => {
    await todoistReq(tt, "POST", `/tasks/${args.task_id}/reopen`);
    return { success: true, task_id: args.task_id };
  },

  t_get_completed_tasks: async (args, { env, tt }) => {
      // Unified API v1: GET /api/v1/tasks/completed/by_completion_date
      // since & until are required by the API; default to last 7 days
      const since = evalDate(args.since ?? "today-7d");
      const until = evalDate(args.until ?? "today");
      // Default project_id from config
      let completedPid = args.project_id;
      if (!completedPid) {
        try { completedPid = JSON.parse(env.TODOIST_CONFIG).inbox_project_id; } catch {}
      }
      const params = new URLSearchParams();
      params.set("since", since + "T00:00:00Z");
      params.set("until", until + "T23:59:59Z");
      // Schema advertises default 50 / max 200 — enforce both so callers
      // can't accidentally DoS themselves via an unbounded API call.
      const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
      params.set("limit", String(limit));
      const qs = params.toString();
      const data = await todoistReq(tt, "GET", `/tasks/completed/by_completion_date?${qs}`);
      let items = Array.isArray(data) ? data : (data?.items ?? data?.results ?? []);
      // Worker-side filtering (API does not support these server-side)
      if (args.section_id) items = items.filter(t => t.section_id === args.section_id);
      if (completedPid) items = items.filter(t => t.project_id === completedPid);
      // Default fields for completed tasks include completed_at + section name
      const defaultFields = args.fields || ["id", "section", "co", "content", "labels", "due", "cat"];
      // Build sectionMap if section name output is needed
      let sectionMap = null;
      if (defaultFields.includes("section") && completedPid) {
        const { map } = await buildSectionMap(tt, completedPid);
        sectionMap = map;
      }
      return formatTodoistList(items, (t) => compactTask(t, defaultFields, sectionMap), args);
  },

  t_delete_task: async (args, { tt }) => {
    await todoistReq(tt, "DELETE", `/tasks/${args.task_id}`);
    return { success: true, task_id: args.task_id };
  },

  t_bulk: async (args, { tt }) => {
      const ops = args.operations ?? [];
      if (!ops.length) return { error: "No operations provided" };

      // Collect reorder items from all update ops; executed as a single Sync API call after REST ops.
      const reorderItems = [];

      // Execute a single operation, reusing existing handler logic
      const execOp = async (op, idx) => {
        try {
          switch (op.action) {
            case "update": {
              if (!op.task_id) throw new Error("task_id required for update");
              const body = {};
              if (op.content)     body.content = op.content;
              if (op.labels)      body.labels = op.labels;
              if (op.priority !== undefined) body.priority = op.priority;
              if (op.description) body.description = op.description;
              if (op.section_id)  body.section_id = op.section_id;
              if (op.project_id)  body.project_id = op.project_id;
              if (op.parent_id !== undefined) body.parent_id = (op.parent_id === "" || op.parent_id === "none") ? null : op.parent_id;
              if (op.due_date)    body.due_date = evalDate(op.due_date);
              if (op.due_string)  body.due_string = op.due_string;
              // order is handled via Sync API after all REST ops complete
              if (op.order !== undefined) reorderItems.push({ id: op.task_id, child_order: op.order });
              // Only call REST if there are non-order fields to update
              if (Object.keys(body).length > 0) {
                await todoistReq(tt, "POST", `/tasks/${op.task_id}`, body);
              }
              return { idx, action: "update", task_id: op.task_id, ok: true };
            }
            case "close": {
              if (!op.task_id) throw new Error("task_id required for close");
              await todoistReq(tt, "POST", `/tasks/${op.task_id}/close`);
              return { idx, action: "close", task_id: op.task_id, ok: true };
            }
            case "delete": {
              if (!op.task_id) throw new Error("task_id required for delete");
              await todoistReq(tt, "DELETE", `/tasks/${op.task_id}`);
              return { idx, action: "delete", task_id: op.task_id, ok: true };
            }
            case "create": {
              if (!op.content) throw new Error("content required for create");
              const body = { content: op.content };
              if (op.project_id)  body.project_id = op.project_id;
              if (op.section_id)  body.section_id = op.section_id;
              if (op.parent_id)   body.parent_id = op.parent_id;
              if (op.labels)      body.labels = op.labels;
              if (op.priority !== undefined) body.priority = op.priority;
              if (op.description) body.description = op.description;
              if (op.order !== undefined) body.order = op.order;
              if (op.due_date)    body.due_date = evalDate(op.due_date);
              if (op.due_string)  body.due_string = op.due_string;
              const created = await todoistReq(tt, "POST", "/tasks", body);
              return { idx, action: "create", task_id: created.id, ok: true };
            }
            default:
              throw new Error(`Unknown action: ${op.action}`);
          }
        } catch (e) {
          return { idx, action: op.action, task_id: op.task_id, ok: false, error: e.message };
        }
      };

      // Run with concurrency limit of 3 to avoid rate limits
      const results = [];
      for (let i = 0; i < ops.length; i += 3) {
        const batch = ops.slice(i, i + 3).map((op, j) => execOp(op, i + j));
        results.push(...await Promise.all(batch));
      }

      // Batch-execute all reorders in a single Sync API call
      if (reorderItems.length > 0) {
        try {
          await todoistSync(tt, [{
            type: "item_reorder",
            uuid: crypto.randomUUID(),
            args: { items: reorderItems },
          }]);
        } catch (e) {
          // Mark every op that contributed a reorder as failed.
          // Use filter (not find) so duplicate task_ids across ops are all caught.
          const affectedIds = new Set(reorderItems.map(i => i.id));
          for (const r of results) {
            if (r.action === "update" && affectedIds.has(r.task_id)) {
              r.ok = false;
              r.error = `Reorder failed: ${e.message}`;
            }
          }
        }
      }

      // Recompute after reorder-failure marking above
      const succeeded = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;
      return {
        total: ops.length, succeeded, failed,
        ...(failed > 0 && { partial_failure: true }),
        results,
      };
  },

  context: async (args, { env, nt, tt }) => {
      // Resolve config
      let inboxPid, habitsPageId;
      try { inboxPid = JSON.parse(env.TODOIST_CONFIG).inbox_project_id; } catch {}
      try { habitsPageId = JSON.parse(env.NOTION_DB_IDS).habits_page; } catch {}
      if (!inboxPid) return { error: "TODOIST_CONFIG.inbox_project_id not set" };
      if (!habitsPageId) return { error: "NOTION_DB_IDS.habits_page not set" };

      // Parallel fetch: Todoist tasks (with section map) + Notion habits blocks
      const [tasksResult, habitsResult] = await Promise.all([
        (async () => {
          const { map: sectionMap } = await buildSectionMap(tt, inboxPid);
          const params = new URLSearchParams({ project_id: inboxPid });
          const raw = await todoistReq(tt, "GET", `/tasks?${params}`);
          const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
          return toTSV(items.map(t => compactTask(t, TASK_COMPACT_DEFAULTS, sectionMap)));
        })(),
        (async () => {
          const res = await notionReq(nt, "GET", `/blocks/${normalizeId(habitsPageId)}/children?page_size=100`);
          const extractText = (rt) => (rt || []).map(t => t.plain_text).join("");
          return res.results.map(b => {
            const c = b[b.type];
            let text = "";
            if (c?.rich_text) text = extractText(c.rich_text);
            if (c?.title)     text = extractText(c.title);
            if (!text.trim()) return null;
            // Add lightweight heading markers so Claude can identify sections
            if (b.type === "heading_1") return `\n## ${text}`;
            if (b.type === "heading_2") return `\n### ${text}`;
            if (b.type === "heading_3") return `#### ${text}`;
            return text;
          }).filter(Boolean).join("\n");
        })(),
      ]);

      return { todoist_tasks: tasksResult, habits: habitsResult };
  },

  help: (args, { env }) => {
      const config = {};
      if (env.NOTION_DB_IDS) {
        try { config.notion_dbs = JSON.parse(env.NOTION_DB_IDS); } catch {}
      }
      if (env.TODOIST_CONFIG) {
        try { config.todoist = JSON.parse(env.TODOIST_CONFIG); } catch {}
      }
      return {
        tools: TOOLS.map(t => ({ name: t.name, inputSchema: t.inputSchema })),
        ...config,
      };
  },
};

async function runTool(env, name, args) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args, { env, nt: env.NOTION_TOKEN, tt: env.TODOIST_TOKEN });
}

// MCP and /health responses: no CORS wildcard.
// The /mcp endpoint requires a Bearer token, and MCP clients are native
// (not browsers), so advertising `Access-Control-Allow-Origin: *` only
// benefits attackers running JS in a victim's browser tab.
// OAuth discovery/registration/authorize/token endpoints use oauthJson()
// in oauth.js, which still returns CORS headers since those are legitimately
// called cross-origin by browser-based OAuth clients.
export function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcErr(id, code, message) {
  // Defense in depth: scrub anything that looks like a bearer token so an
  // upstream error that accidentally echoes our Authorization header can't
  // leak credentials through the MCP error channel.
  const safe = typeof message === "string"
    ? message.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    : message;
  return jsonResp({ jsonrpc: "2.0", id, error: { code, message: safe } });
}

// ─────────────────────────────────────────────
// MCP JSON-RPC handler
// ─────────────────────────────────────────────
export async function handleMCP(request, url, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const verified = token ? await verifyToken(token, "access", env).catch(() => null) : null;
  // RFC 8707: if the access token was bound to a specific resource, enforce it.
  // Accept both `${origin}/mcp` and `${origin}` as the canonical resource identifier.
  if (verified?.aud) {
    const expected = [`${url.origin}/mcp`, url.origin];
    if (!expected.includes(verified.aud)) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="invalid_token", error_description="audience mismatch"`,
        },
      });
    }
  }
  if (!verified) {
    const resourceMeta = `${url.origin}/.well-known/oauth-protected-resource`;
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${resourceMeta}"`,
      },
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return rpcErr(null, -32700, "Parse error"); }

  const { id, method, params } = body;

  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "notion-todoist-mcp", version: "1.8.0" },
        };
        break;

      case "notifications/initialized":
        return new Response(null, { status: 204 });

      case "ping":
        result = {};
        break;

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolResult = await runTool(env, params.name, params.arguments ?? {});
        const text = typeof toolResult === "string"
          ? toolResult
          : JSON.stringify(toolResult, null, 2);
        result = { content: [{ type: "text", text }] };
        break;
      }

      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }

    return jsonResp({ jsonrpc: "2.0", id, result });
  } catch (err) {
    return rpcErr(id, -32000, err.message);
  }
}

export { TOOLS };
