import { evalDate, resolveFilterDates, safeMath, sleep, normalizeId, extractNum, assertTodoistId } from "./utils.js";
import {
  notionReq, compactProps, appendBlocksChunked, mdToBlocks,
  resolvePropDates, normalizeProperties, NOTION_CHILDREN_BATCH,
  mkRichText, RICH_TEXT_BLOCK_TYPES,
} from "./notion.js";
import {
  TASK_COMPACT_DEFAULTS, compactTask, buildSectionMap, compactSection,
  compactProject, toTSV, formatTodoistList, todoistReq, todoistSync,
} from "./todoist.js";
import { verifyToken } from "./oauth.js";
import { handleItemCompleted } from "./webhook.js";
import { TOOLS } from "./tools.js";

const MCP_VERSION = "2024-11-05";

// Levenshtein edit distance — small inputs (property names), so the simple
// O(m*n) DP is fine. Used to power "did you mean?" hints when a caller passes
// a property name that isn't in the database schema.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Nearest known key to `name`, if close enough to be a likely typo. Threshold
// scales with length so short names need a near-exact match. Returns null when
// nothing is plausibly close.
function suggestKey(name, knownKeys) {
  let best = null, bestD = Infinity;
  for (const k of knownKeys) {
    const d = editDistance(name, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  const threshold = Math.max(2, Math.floor(name.length / 3));
  return best != null && bestD <= threshold ? best : null;
}

// ─────────────────────────────────────────────
// Tool handlers — dispatched via TOOL_HANDLERS map below.
// Each handler receives (args, ctx) where ctx = { env, nt, tt }.
// ─────────────────────────────────────────────
const TOOL_HANDLERS = {
  // ── Utility ──
  // Accept `expr` as an alias for `expression` — the 2026-05-29 session lost a
  // round-trip guessing the arg name. The schema's canonical key stays
  // `expression`; this just keeps a near-miss from silently returning undefined.
  eval_date: (args) => {
    const expression = args.expression ?? args.expr;
    return { expression, resolved: evalDate(expression) };
  },

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
      // Real property names seen across the fetched rows — the keys of each
      // page's `properties` ARE the canonical schema names. Collected so we can
      // warn when a requested `fields` / `aggregate` name doesn't exist instead
      // of silently returning null (the n_metrics_series "available options"
      // courtesy, ported to n_query).
      const knownKeys = new Set();
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
          for (const k of Object.keys(p.properties)) knownKeys.add(k);
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

      // Unknown-property warnings. Only meaningful when at least one row came
      // back (an empty result set tells us nothing about the schema). Covers
      // `fields` and the property-name args of `aggregate` — both of which fail
      // silently (null / skipped) rather than erroring like a bad filter does.
      if (knownKeys.size) {
        const requested = [];
        for (const f of args.fields || []) if (typeof f === "string") requested.push(["field", f]);
        if (args.aggregate) {
          for (const op of ["sum", "avg", "min", "max", "first", "last", "delta"]) {
            const p = args.aggregate[op];
            if (typeof p === "string") requested.push([`aggregate.${op}`, p]);
          }
        }
        const warnings = [];
        for (const [kind, name] of requested) {
          if (knownKeys.has(name)) continue;
          const hint = suggestKey(name, knownKeys);
          warnings.push(`unknown ${kind}: "${name}"${hint ? ` — did you mean "${hint}"?` : ""}`);
        }
        if (warnings.length) {
          out.warnings = warnings;
          out.available_fields = [...knownKeys];
        }
      }

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

  n_delete_page: async (args, { nt }) => {
      const pid = normalizeId(args.page_id);
      const archived = args.restore ? false : true;
      const p = await notionReq(nt, "PATCH", `/pages/${pid}`, { archived });
      return { id: p.id, url: p.url, archived: p.archived, last_edited_time: p.last_edited_time };
  },

  n_update_block: async (args, { nt }) => {
      const id = normalizeId(args.block_id);
      // Delete path.
      if (args.archived === true || args.delete === true) {
        const b = await notionReq(nt, "DELETE", `/blocks/${id}`);
        return { id: b.id, type: b.type, deleted: true };
      }
      if (args.content === undefined || args.content === null) {
        return { error: "Provide `content` to replace the block text, or archived:true / delete:true to remove the block." };
      }
      // Replace-text path: a block's type can't change via PATCH, so fetch the
      // existing type and re-send its rich_text. Non-text block types (image,
      // divider, table, …) have nothing to replace.
      const blk = await notionReq(nt, "GET", `/blocks/${id}`);
      if (!RICH_TEXT_BLOCK_TYPES.has(blk.type)) {
        return { error: `Block type "${blk.type}" has no editable rich_text. Editable: ${[...RICH_TEXT_BLOCK_TYPES].join(", ")}.` };
      }
      const payload = { rich_text: mkRichText(String(args.content)) };
      // Code blocks require a language; PATCH would otherwise risk clearing it.
      if (blk.type === "code") payload.language = blk.code?.language || "plain text";
      const u = await notionReq(nt, "PATCH", `/blocks/${id}`, { [blk.type]: payload });
      return { id: u.id, type: u.type, last_edited_time: u.last_edited_time };
  },

  n_bulk: async (args, ctx) => {
      // Accept `ops` or `operations` (alias of t_bulk); each item accepts `op` or `action`.
      const raw = args.ops ?? args.operations ?? [];
      const ops = raw.map(o => o?.op ? o : (o?.action ? { ...o, op: o.action } : o));
      return runNotionBulk(ops, ctx, args);
  },

  n_bulk_metrics: async (args, ctx) => runBulkMetrics(args, ctx),

  quick_log: async (args, ctx) => {
      if (args.value === undefined || args.value === null) return { error: "value is required" };
      if (!args.metric || typeof args.metric !== "string") return { error: "metric is required" };
      const date = args.date || "today";
      const res = await runBulkMetrics({
        date,
        entries: [{ metric: args.metric, value: args.value, unit: args.unit, memo: args.memo }],
        mode: args.mode || "upsert",
        database_id: args.database_id,
      }, ctx);
      // runBulkMetrics returns {results:[row], ...} or {error}. Flatten the
      // single row for ergonomics; surface the whole object on error/budget.
      const row = Array.isArray(res.results) ? res.results[0] : null;
      if (!row) return res;
      return { ...row, date: evalDate(date), mode: res.mode };
  },

  n_metrics_series: async (args, ctx) => runMetricsSeries(args, ctx),

  n_search: async (args, { nt }) => {
      // Page title lives under whichever property is typed "title" — the key
      // is not always "title" (often "Name" or a localized label), so scan.
      const extractPageTitle = (props) => {
        if (!props) return null;
        for (const v of Object.values(props)) {
          if (v?.type === "title") return v.title?.map(t => t.plain_text).join("") || null;
        }
        return null;
      };

      const pageSize = args.page_size ?? 10;

      // search_body:true → body-text scan.
      // Notion's /search API is title-only, so we fan out: list accessible pages
      // via empty search, fetch each page's blocks, and filter by substring match
      // against the combined title + body text. Bounded by max_scan (default 50,
      // hard cap 100) to avoid runaway API cost.
      if (args.search_body && args.query) {
        const needle = String(args.query).toLowerCase();
        const maxScan = Math.min(Math.max(1, args.max_scan ?? 50), 100);
        const listBody = { query: "", page_size: maxScan, filter: { value: "page", property: "object" } };
        const listed = await notionReq(nt, "POST", "/search", listBody);

        // Fetch blocks with concurrency 3 to respect Notion's 3 req/s limit.
        const scanPage = async (r) => {
          try {
            const blocks = await notionReq(nt, "GET", `/blocks/${r.id}/children?page_size=100`);
            const bodyText = blocks.results.map(b => {
              const c = b[b.type];
              if (c?.rich_text) return c.rich_text.map(t => t.plain_text).join("");
              if (c?.title)     return c.title.map(t => t.plain_text).join("");
              return "";
            }).join("\n");
            const title = r.title?.map(t => t.plain_text).join("") || extractPageTitle(r.properties) || "";
            const combined = (title + "\n" + bodyText).toLowerCase();
            return combined.includes(needle) ? { r, title, snippet: bodyText.slice(0, 240) } : null;
          } catch {
            return null;
          }
        };

        const hits = [];
        for (let i = 0; i < listed.results.length && hits.length < pageSize; i += 3) {
          const batch = listed.results.slice(i, i + 3);
          const batchResults = await Promise.all(batch.map(scanPage));
          for (const m of batchResults) if (m) hits.push(m);
        }

        return {
          scanned: listed.results.length,
          scan_has_more: listed.has_more,
          match_count: hits.length,
          results: hits.slice(0, pageSize).map(({ r, title, snippet }) => {
            const row = {
              id: r.id, type: r.object, url: r.url,
              title: title || "(untitled)",
              last_edited_time: r.last_edited_time,
              snippet,
            };
            if (args.include_properties && r.properties) {
              row.properties = compactProps(r.properties);
            }
            return row;
          }),
        };
      }

      // Default path: title-only search via Notion API.
      const body = { query: args.query ?? "", page_size: pageSize };
      if (args.type) body.filter = { value: args.type, property: "object" };
      const res = await notionReq(nt, "POST", "/search", body);
      return {
        results: res.results.map(r => {
          const row = {
            id: r.id, type: r.object, url: r.url,
            title: r.title?.map(t => t.plain_text).join("") || extractPageTitle(r.properties) || "(untitled)",
            last_edited_time: r.last_edited_time,
          };
          if (args.include_properties && r.object === "page" && r.properties) {
            row.properties = compactProps(r.properties);
          }
          return row;
        }),
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
      const crossProject = !args.project_id || args.project_id === "all";
      if (!crossProject) assertTodoistId(args.project_id, "project_id");
      const path = crossProject ? "/sections" : `/sections?project_id=${args.project_id}`;
      const raw = await todoistReq(tt, "GET", path);
      const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
      // When cross-project, keep project_id in the compact row so callers can
      // tell which project each section belongs to.
      const mapper = crossProject
        ? (s) => ({ ...compactSection(s), project_id: s.project_id })
        : (s) => compactSection(s);
      return formatTodoistList(items, mapper, args);
  },

  t_create_section: async (args, { tt }) => {
    assertTodoistId(args.project_id, "project_id");
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
      assertTodoistId(project_id, "project_id");
      const body = {};
      if (rest.name)        body.name = rest.name;
      if (rest.color)       body.color = rest.color;
      if (rest.is_favorite !== undefined) body.is_favorite = rest.is_favorite;
      return todoistReq(tt, "POST", `/projects/${project_id}`, body);
  },

  t_delete_project: async (args, { tt }) => {
    assertTodoistId(args.project_id, "project_id");
    await todoistReq(tt, "DELETE", `/projects/${args.project_id}`);
    return { success: true, project_id: args.project_id };
  },

  t_update_section: async (args, { tt }) => {
    assertTodoistId(args.section_id, "section_id");
    return todoistReq(tt, "POST", `/sections/${args.section_id}`, { name: args.name });
  },

  t_delete_section: async (args, { tt }) => {
    assertTodoistId(args.section_id, "section_id");
    await todoistReq(tt, "DELETE", `/sections/${args.section_id}`);
    return { success: true, section_id: args.section_id };
  },

  t_get_task: async (args, { tt }) => {
      assertTodoistId(args.task_id, "task_id");
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
      // project_id:"all" → explicit opt-out of the Inbox default; skip API filter entirely.
      const crossProject = args.project_id === "all";
      // Default project_id from config if not specified and no filter/label/ids
      let projectId = crossProject ? undefined : args.project_id;
      if (!crossProject && !projectId && !args.filter && !args.label && !args.ids?.length) {
        try { projectId = JSON.parse(env.TODOIST_CONFIG).inbox_project_id; } catch {}
      }
      if (projectId) assertTodoistId(projectId, "project_id");
      if (args.ids?.length) for (const id of args.ids) assertTodoistId(id, "ids[]");

      // Resolve section name → section_id
      let sectionId = args.section_id;
      if (sectionId) assertTodoistId(sectionId, "section_id");
      let sectionMap = null;
      const needsSectionName = (args.fields || TASK_COMPACT_DEFAULTS).includes("section");

      if (args.section || needsSectionName) {
        const pid = projectId;
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
      if (args.project_id) assertTodoistId(args.project_id, "project_id");
      if (args.section_id) assertTodoistId(args.section_id, "section_id");
      if (args.parent_id)  assertTodoistId(args.parent_id, "parent_id");
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
      assertTodoistId(task_id, "task_id");
      if (rest.section_id) assertTodoistId(rest.section_id, "section_id");
      if (rest.project_id) assertTodoistId(rest.project_id, "project_id");
      if (rest.parent_id && rest.parent_id !== "" && rest.parent_id !== "none") {
        assertTodoistId(rest.parent_id, "parent_id");
      }
      const body = {};
      if (rest.content)     body.content = rest.content;
      if (rest.labels)      body.labels = rest.labels;
      if (rest.priority !== undefined) body.priority = rest.priority;
      if (rest.description) body.description = rest.description;
      if (rest.project_id)  body.project_id = rest.project_id;
      if (rest.parent_id !== undefined) body.parent_id = (rest.parent_id === "" || rest.parent_id === "none") ? null : rest.parent_id;
      if (rest.due_date)    body.due_date = evalDate(rest.due_date);
      if (rest.due_string)  body.due_string = rest.due_string;
      if (Object.keys(body).length > 0) {
        await todoistReq(tt, "POST", `/tasks/${task_id}`, body);
      }
      if (rest.section_id) {
        await todoistSync(tt, [{ type: "item_move", uuid: crypto.randomUUID(), args: { id: task_id, section_id: rest.section_id } }]);
      }
      return { success: true, task_id };
  },

  t_close_task: async (args, { tt }) => {
    assertTodoistId(args.task_id, "task_id");
    // Fetch task before closing to get content/section/parent for renumber
    const task = await todoistReq(tt, "GET", `/tasks/${args.task_id}`);
    await todoistReq(tt, "POST", `/tasks/${args.task_id}/close`);
    const result = { success: true, task_id: args.task_id };
    // Auto-renumber if sequential task
    if (task?.content && /^#\d+\s/.test(task.content) && task.section_id) {
      const renumber = await handleItemCompleted(
        { event_data: { content: task.content, section_id: task.section_id, parent_id: task.parent_id ?? null } },
        tt,
      );
      result.renumber = renumber;
    }
    return result;
  },

  t_reopen_task: async (args, { tt }) => {
    assertTodoistId(args.task_id, "task_id");
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
      if (completedPid) assertTodoistId(completedPid, "project_id");
      if (args.section_id) assertTodoistId(args.section_id, "section_id");
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
    assertTodoistId(args.task_id, "task_id");
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
              assertTodoistId(op.task_id, "task_id");
              if (op.section_id) assertTodoistId(op.section_id, "section_id");
              if (op.project_id) assertTodoistId(op.project_id, "project_id");
              if (op.parent_id && op.parent_id !== "" && op.parent_id !== "none") {
                assertTodoistId(op.parent_id, "parent_id");
              }
              const body = {};
              if (op.content)     body.content = op.content;
              if (op.labels)      body.labels = op.labels;
              if (op.priority !== undefined) body.priority = op.priority;
              if (op.description) body.description = op.description;
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
              if (op.section_id) {
                await todoistSync(tt, [{ type: "item_move", uuid: crypto.randomUUID(), args: { id: op.task_id, section_id: op.section_id } }]);
              }
              return { idx, action: "update", task_id: op.task_id, ok: true };
            }
            case "close": {
              if (!op.task_id) throw new Error("task_id required for close");
              assertTodoistId(op.task_id, "task_id");
              const task = await todoistReq(tt, "GET", `/tasks/${op.task_id}`);
              await todoistReq(tt, "POST", `/tasks/${op.task_id}/close`);
              const res = { idx, action: "close", task_id: op.task_id, ok: true };
              if (task?.content && /^#\d+\s/.test(task.content) && task.section_id) {
                res.renumber = await handleItemCompleted(
                  { event_data: { content: task.content, section_id: task.section_id, parent_id: task.parent_id ?? null } },
                  tt,
                );
              }
              return res;
            }
            case "delete": {
              if (!op.task_id) throw new Error("task_id required for delete");
              assertTodoistId(op.task_id, "task_id");
              await todoistReq(tt, "DELETE", `/tasks/${op.task_id}`);
              return { idx, action: "delete", task_id: op.task_id, ok: true };
            }
            case "create": {
              if (!op.content) throw new Error("content required for create");
              if (op.project_id) assertTodoistId(op.project_id, "project_id");
              if (op.section_id) assertTodoistId(op.section_id, "section_id");
              if (op.parent_id)  assertTodoistId(op.parent_id, "parent_id");
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
      // Resolution order for each slot:
      //   1. per-call args (args.tasks / args.pages / args.queries)
      //   2. CONTEXT_CONFIG env var (JSON)
      //   3. legacy defaults (TODOIST_CONFIG.inbox_project_id + NOTION_DB_IDS.habits_page)
      let envCfg = {};
      try { if (env.CONTEXT_CONFIG) envCfg = JSON.parse(env.CONTEXT_CONFIG); } catch {}

      let inboxPid, habitsPageId;
      try { inboxPid = JSON.parse(env.TODOIST_CONFIG).inbox_project_id; } catch {}
      try { habitsPageId = JSON.parse(env.NOTION_DB_IDS).habits_page; } catch {}

      const legacyTasks = inboxPid ? { project_id: inboxPid } : null;
      const legacyPages = habitsPageId ? [{ id: habitsPageId, label: "habits" }] : [];

      // Tasks slot: args > env > legacy. Pass false/null at any layer to skip.
      const tasksCfg = args.tasks !== undefined
        ? args.tasks
        : (envCfg.tasks !== undefined ? envCfg.tasks : legacyTasks);

      // Pages slot: args fully override env, env fully overrides legacy.
      // extra_pages appends on top of whichever layer is effective.
      let pagesCfg = args.pages ?? envCfg.pages ?? legacyPages;
      if (args.extra_pages?.length) pagesCfg = [...pagesCfg, ...args.extra_pages];

      const queriesCfg = args.queries ?? envCfg.queries ?? [];

      const extractBlockText = (rt) => (rt || []).map(t => t.plain_text).join("");
      const blocksToMarkdown = (blocks) => blocks.map(b => {
        const c = b[b.type];
        let text = "";
        if (c?.rich_text) text = extractBlockText(c.rich_text);
        if (c?.title)     text = extractBlockText(c.title);
        if (!text.trim()) return null;
        if (b.type === "heading_1") return `\n## ${text}`;
        if (b.type === "heading_2") return `\n### ${text}`;
        if (b.type === "heading_3") return `#### ${text}`;
        return text;
      }).filter(Boolean).join("\n");

      const fetchTasks = async (cfg) => {
        const pid = cfg.project_id;
        if (!pid) return null;
        const { map: sectionMap } = await buildSectionMap(tt, pid);
        const params = new URLSearchParams({ project_id: pid });
        const raw = await todoistReq(tt, "GET", `/tasks?${params}`);
        const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
        return toTSV(items.map(t => compactTask(t, cfg.fields || TASK_COMPACT_DEFAULTS, sectionMap)));
      };

      const fetchPage = async (spec) => {
        const res = await notionReq(nt, "GET", `/blocks/${normalizeId(spec.id)}/children?page_size=100`);
        return blocksToMarkdown(res.results);
      };

      const fetchQuery = async (spec) => {
        const body = { page_size: spec.page_size ?? 20 };
        if (spec.filter) body.filter = resolveFilterDates(spec.filter);
        if (spec.sorts)  body.sorts = spec.sorts;
        const res = await notionReq(nt, "POST", `/databases/${normalizeId(spec.database_id)}/query`, body);
        return res.results.map(p => ({
          id: p.id,
          properties: compactProps(p.properties),
        }));
      };

      // Resolve everything in parallel. Empty/falsy slots are skipped.
      const jobs = [];
      if (tasksCfg) jobs.push(["todoist_tasks", fetchTasks(tasksCfg)]);
      for (const page of pagesCfg) {
        jobs.push([page.label || page.id, fetchPage(page)]);
      }
      for (const q of queriesCfg) {
        if (!q.label) continue;
        jobs.push([q.label, fetchQuery(q)]);
      }

      const settled = await Promise.all(jobs.map(([, p]) => p.catch(e => ({ __error: e.message }))));
      const out = {};
      jobs.forEach(([label], i) => { out[label] = settled[i]; });
      if (!jobs.length) return { error: "No context sources configured. Set CONTEXT_CONFIG, TODOIST_CONFIG.inbox_project_id, or NOTION_DB_IDS.habits_page, or pass args." };
      // JST-resolved date anchors so callers never hand-compute a date or
      // round-trip to eval_date for the common cases. Cheap (pure compute).
      out.dates = {
        today: evalDate("today"),
        now: evalDate("now"),
        yesterday: evalDate("yesterday"),
        tomorrow: evalDate("tomorrow"),
        week_start: evalDate("week_start"),
        week_end: evalDate("week_end"),
        month_start: evalDate("month_start"),
        month_end: evalDate("month_end"),
      };
      return out;
  },

  help: async (args, { env, nt }) => {
      const config = {};
      let notionDbs = null;
      if (env.NOTION_DB_IDS) {
        try { notionDbs = JSON.parse(env.NOTION_DB_IDS); config.notion_dbs = notionDbs; } catch {}
      }
      if (env.TODOIST_CONFIG) {
        try { config.todoist = JSON.parse(env.TODOIST_CONFIG); } catch {}
      }
      // Resolve each configured DB's title-property NAME (ドメイン / タイトル /
      // エントリ differ per DB — the 2026-05-29 session lost a round-trip to
      // this). Best-effort: an entry that isn't a DB (e.g. a page id) or isn't
      // shared with the integration simply 404s and is omitted. No auto-rewrite
      // — this only surfaces the real name so callers stop guessing.
      if (notionDbs && typeof notionDbs === "object") {
        const titleProps = {};
        const entries = Object.entries(notionDbs).filter(([, v]) => typeof v === "string");
        await Promise.all(entries.map(async ([key, id]) => {
          try {
            const db = await notionReq(nt, "GET", `/databases/${normalizeId(id)}`);
            const titleKey = Object.entries(db.properties || {}).find(([, p]) => p.type === "title")?.[0];
            if (titleKey) titleProps[key] = titleKey;
          } catch { /* not a DB / not shared — omit */ }
        }));
        if (Object.keys(titleProps).length) config.notion_db_title_props = titleProps;
      }
      return {
        tools: TOOLS.map(t => ({ name: t.name, inputSchema: t.inputSchema })),
        ...config,
      };
  },
};

// ─────────────────────────────────────────────
// n_bulk — multi-op Notion executor with Cloudflare subrequest budgeting.
//
// A single MCP tools/call is one Worker invocation, capped at SUBREQUEST_BUDGET
// fetch subrequests (Cloudflare free tier = 50, paid = 1000). We estimate each
// op's Notion-API call count up front and stop before the budget would be
// exceeded, handing back {remaining, next_cursor} so the caller can continue in
// a follow-up call. On the free tier this is the only way to write >~50 pages;
// on paid it collapses to a single call. The token auth path does no fetch/KV
// subrequests, so (nearly) the full budget is available to the handler.
// ─────────────────────────────────────────────
const mdBlockCount = (md) => (md ? mdToBlocks(md).length : 0);

function estimateOpCost(op, budget) {
  if (op.op === "delete") return 1;
  // update_block: GET (learn type) + PATCH; delete-via-archived is a single DELETE.
  if (op.op === "update_block") return (op.archived === true || op.delete === true) ? 1 : 2;
  // insert_after: GET (resolve parent) + one append children call.
  if (op.op === "insert_after") return 2;
  if (op.op === "create") {
    const overflow = Math.max(0, mdBlockCount(op.content) - NOTION_CHILDREN_BATCH);
    return 1 + Math.ceil(overflow / NOTION_CHILDREN_BATCH);
  }
  if (op.op === "update") {
    // replace_content's cost depends on the page's existing block count, which
    // we can't know statically. Charge it the full budget so it always starts
    // its own batch — the in-op hard cap then governs the delete-storm.
    if (op.replace_content !== undefined) return budget;
    let c = (op.properties || op.archived !== undefined) ? 1 : 0;
    if (op.append_content) c += Math.ceil(mdBlockCount(op.append_content) / NOTION_CHILDREN_BATCH);
    return Math.max(1, c);
  }
  return 1;
}

// Execute one op. Returns a result row plus __cost = actual subrequests used,
// so the caller can keep an accurate running budget tally. `spentBefore` is the
// budget already consumed this invocation; replace_content's deletes stop once
// spentBefore + in-op cost reaches `budget`.
async function execNotionOp(op, idx, nt, budget, spentBefore) {
  try {
    switch (op.op) {
      case "create": {
        if (!op.database_id) throw new Error("database_id required for create");
        const body = {
          parent: { database_id: normalizeId(op.database_id) },
          properties: resolvePropDates(normalizeProperties(op.properties)),
        };
        let overflow = [];
        if (op.content) {
          const blocks = mdToBlocks(op.content);
          if (blocks.length) {
            body.children = blocks.slice(0, NOTION_CHILDREN_BATCH);
            overflow = blocks.slice(NOTION_CHILDREN_BATCH);
          }
        }
        const p = await notionReq(nt, "POST", "/pages", body);
        let cost = 1;
        if (overflow.length) {
          await appendBlocksChunked(nt, p.id, overflow);
          cost += Math.ceil(overflow.length / NOTION_CHILDREN_BATCH);
        }
        return { index: idx, op: "create", ok: true, id: p.id, url: p.url, __cost: cost };
      }
      case "delete": {
        if (!op.page_id) throw new Error("page_id required for delete");
        const pid = normalizeId(op.page_id);
        const p = await notionReq(nt, "PATCH", `/pages/${pid}`, { archived: true });
        return { index: idx, op: "delete", ok: true, id: p.id, url: p.url, __cost: 1 };
      }
      case "update_block": {
        if (!op.block_id) throw new Error("block_id required for update_block");
        const bid = normalizeId(op.block_id);
        if (op.archived === true || op.delete === true) {
          const b = await notionReq(nt, "DELETE", `/blocks/${bid}`);
          return { index: idx, op: "update_block", ok: true, id: b.id, deleted: true, __cost: 1 };
        }
        if (op.content === undefined || op.content === null) {
          throw new Error("update_block needs content (replacement text) or archived/delete:true");
        }
        const blk = await notionReq(nt, "GET", `/blocks/${bid}`);
        if (!RICH_TEXT_BLOCK_TYPES.has(blk.type)) {
          throw new Error(`Block type "${blk.type}" has no editable rich_text`);
        }
        const payload = { rich_text: mkRichText(String(op.content)) };
        if (blk.type === "code") payload.language = blk.code?.language || "plain text";
        const u = await notionReq(nt, "PATCH", `/blocks/${bid}`, { [blk.type]: payload });
        return { index: idx, op: "update_block", ok: true, id: u.id, __cost: 2 };
      }
      case "insert_after": {
        if (!op.block_id) throw new Error("block_id required for insert_after");
        const bid = normalizeId(op.block_id);
        const blocks = mdToBlocks(op.content || "");
        if (!blocks.length) throw new Error("insert_after needs non-empty content");
        if (blocks.length > NOTION_CHILDREN_BATCH) {
          throw new Error(`insert_after is capped at ${NOTION_CHILDREN_BATCH} blocks; got ${blocks.length}. Split the insert.`);
        }
        // Notion inserts via the PARENT's children endpoint with `after:<sibling>`.
        const blk = await notionReq(nt, "GET", `/blocks/${bid}`);
        const parent = blk.parent || {};
        const parentRaw = parent.type === "page_id" ? parent.page_id
          : parent.type === "block_id" ? parent.block_id : null;
        if (!parentRaw) throw new Error("could not resolve the parent of block_id for insertion");
        const r = await notionReq(nt, "PATCH", `/blocks/${normalizeId(parentRaw)}/children`, { children: blocks, after: bid });
        const ids = (r.results || []).map(b => b.id);
        return { index: idx, op: "insert_after", ok: true, inserted: ids.length, ids, __cost: 2 };
      }
      case "update": {
        if (!op.page_id) throw new Error("page_id required for update");
        const pid = normalizeId(op.page_id);
        let cost = 0;
        if (op.properties || op.archived !== undefined) {
          const b = {};
          if (op.properties) b.properties = resolvePropDates(normalizeProperties(op.properties));
          if (op.archived !== undefined) b.archived = op.archived;
          await notionReq(nt, "PATCH", `/pages/${pid}`, b);
          cost += 1;
        }
        let staleBlocks = 0;
        if (op.replace_content !== undefined) {
          // Append new blocks FIRST (so a partial failure leaves old content
          // intact), then delete old blocks — but never past the budget.
          const oldBlocks = [];
          let cursor;
          do {
            const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : `?page_size=100`;
            const page = await notionReq(nt, "GET", `/blocks/${pid}/children${qs}`);
            cost += 1;
            oldBlocks.push(...page.results);
            cursor = page.has_more ? page.next_cursor : null;
          } while (cursor);
          const newBlocks = mdToBlocks(op.replace_content);
          if (newBlocks.length) {
            await appendBlocksChunked(nt, pid, newBlocks);
            cost += Math.ceil(newBlocks.length / NOTION_CHILDREN_BATCH);
          }
          for (const blk of oldBlocks) {
            if (spentBefore + cost >= budget) { staleBlocks++; continue; }
            try { await notionReq(nt, "DELETE", `/blocks/${blk.id}`); cost += 1; }
            catch { staleBlocks++; }
          }
        }
        if (op.append_content) {
          const blocks = mdToBlocks(op.append_content);
          if (blocks.length) {
            await appendBlocksChunked(nt, pid, blocks);
            cost += Math.ceil(blocks.length / NOTION_CHILDREN_BATCH);
          }
        }
        const r = { index: idx, op: "update", ok: true, id: pid, __cost: Math.max(1, cost) };
        if (staleBlocks > 0) {
          r.stale_blocks = staleBlocks;
          r.warning = `${staleBlocks} old block(s) left undeleted (subrequest budget reached). ` +
            `Prefer delete+create for full-body replacement, or re-run to finish cleanup.`;
        }
        return r;
      }
      default:
        throw new Error(`Unknown op: ${op.op}`);
    }
  } catch (e) {
    return { index: idx, op: op.op, ok: false, error: e.message, __cost: 1 };
  }
}

async function runNotionBulk(ops, { env, nt }, args = {}) {
  if (!Array.isArray(ops) || !ops.length) return { error: "No operations provided" };

  const budget = Math.max(1, Number(env.SUBREQUEST_BUDGET) || 50);
  const startIdx = Math.max(0, Math.floor(Number(args.start_cursor) || 0));

  let spent = 0;
  let i = startIdx;
  const results = [];
  for (; i < ops.length; i++) {
    const est = estimateOpCost(ops[i], budget);
    // Defer the rest to a continuation call once the budget would be exceeded.
    // The first op of a batch always runs even if it alone is expensive.
    if (spent > 0 && spent + est > budget) break;
    const r = await execNotionOp(ops[i], i, nt, budget, spent);
    spent += r.__cost ?? est;
    delete r.__cost;
    results.push(r);
  }

  const remaining = ops.length - i;
  const succeeded = results.filter(r => r.ok).length;
  const failed = results.length - succeeded;
  const out = {
    total: ops.length,
    processed: results.length,
    succeeded,
    failed,
    ...(failed > 0 && { partial_failure: true }),
    ...(remaining > 0 && {
      remaining,
      next_cursor: i,
      note: `Subrequest budget (${budget}) reached after ${results.length} op(s). ` +
        `Re-call with start_cursor:${i} to process the remaining ${remaining}.`,
    }),
    results: args.format === "tsv" ? toTSV(results) : results,
  };
  return out;
}

// ─────────────────────────────────────────────
// Metrics DB helpers (n_bulk_metrics + n_metrics_series).
// METRIC_ALIASES env var ({ "γGT": "γGTP", … }) maps free-typed synonyms to the
// canonical 指標 select value at write/read time — light-touch hygiene without
// a full master DB.
// ─────────────────────────────────────────────
function parseMetricAliases(env) {
  try { return JSON.parse(env.METRIC_ALIASES || "{}"); } catch { return {}; }
}

function normalizeMetricName(raw, aliases) {
  if (typeof raw !== "string") return raw;
  return aliases[raw] || raw;
}

// METRIC_RANGES env var: { "<canonical_metric>": [low, high], ... }. Either
// bound may be null for one-sided ranges (e.g. LDL upper-bound only:
// `[null, 119]`; HDL lower-bound only: `[40, null]`). Keyed by canonical
// (post-alias) names, since lookups happen after normalization.
function parseMetricRanges(env) {
  try { return JSON.parse(env.METRIC_RANGES || "{}"); } catch { return {}; }
}

function rangeBounds(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  const low = typeof range[0] === "number" && !isNaN(range[0]) ? range[0] : null;
  const high = typeof range[1] === "number" && !isNaN(range[1]) ? range[1] : null;
  if (low === null && high === null) return null;
  return { low, high };
}

function flagValue(value, bounds) {
  if (typeof value !== "number" || isNaN(value) || !bounds) return null;
  if (bounds.low !== null && value < bounds.low) return "low";
  if (bounds.high !== null && value > bounds.high) return "high";
  return "normal";
}

function resolveMetricsId(args, env) {
  if (args.database_id) return args.database_id;
  try { return JSON.parse(env.NOTION_DB_IDS).metrics; } catch { return null; }
}

// Query the Metrics DB for all rows whose エントリ title begins with `${iso}_`.
// One filtered query (paginated) replaces N per-entry collision checks. Returns
// { map: canonicalTitle -> {id,url,raw_title?}, subrequests } so the caller can
// keep its budget tally.
//
// Dedup key is derived from the 指標 SELECT value, not the literal title:
// 04-02 legacy rows have abbreviated titles (e.g. `2025-02-12_Cr`) while their
// select column holds the canonical name (クレアチニン). Title-keyed dedup
// would miss those and silently produce duplicates on re-import. Aliases are
// applied to the select value too, defending against rows whose select itself
// drifted from the canonical name.
async function fetchMetricsByDatePrefix(token, dbId, iso, aliases) {
  const prefix = `${iso}_`;
  const map = new Map();
  let subrequests = 0;
  let cursor = null;
  do {
    const body = {
      page_size: 100,
      filter: { property: "エントリ", title: { starts_with: prefix } },
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionReq(token, "POST", `/databases/${dbId}/query`, body);
    subrequests++;
    for (const p of res.results) {
      const selectName = p.properties["指標"]?.select?.name;
      if (!selectName) continue;
      const canonical = normalizeMetricName(selectName, aliases);
      const key = `${iso}_${canonical}`;
      const titleProp = p.properties["エントリ"];
      const rawTitle = titleProp?.title?.map(t => t.plain_text).join("") || null;
      // On the off chance the DB has stale duplicate rows for the same
      // (date, metric), keep the first one so upsert/skip has a stable target.
      if (!map.has(key)) map.set(key, { id: p.id, url: p.url, raw_title: rawTitle });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return { map, subrequests };
}

function buildMetricsProps(iso, metric, value, unit, memo) {
  const props = {
    "エントリ": { title: `${iso}_${metric}` },
    "指標": { select: metric },
    "値": value,
    "日付": { date: iso },
  };
  if (unit !== undefined && unit !== null && unit !== "") props["単位"] = unit;
  if (memo !== undefined && memo !== null && memo !== "") props["メモ"] = memo;
  return props;
}

async function runBulkMetrics(args, { env, nt }) {
  const entries = args.entries ?? [];
  if (!Array.isArray(entries) || !entries.length) return { error: "No entries provided" };

  const metricsIdRaw = resolveMetricsId(args, env);
  if (!metricsIdRaw) return { error: "Metrics DB id not configured (NOTION_DB_IDS.metrics)" };
  const metricsId = normalizeId(metricsIdRaw);

  const mode = args.mode || "create";
  if (!["create", "upsert", "skip_existing"].includes(mode)) {
    return { error: `Invalid mode: ${mode}. Use create | upsert | skip_existing.` };
  }

  const iso = evalDate(args.date);
  const aliases = parseMetricAliases(env);
  const budget = Math.max(1, Number(env.SUBREQUEST_BUDGET) || 50);
  const startIdx = Math.max(0, Math.floor(Number(args.start_cursor) || 0));

  // Pre-flight dedup query (skipped in pure "create" mode). Re-runs on every
  // continuation call — costs 1-2 subrequests, negligible vs. the savings.
  let existing = new Map();
  let spent = 0;
  if (mode !== "create") {
    const lookup = await fetchMetricsByDatePrefix(nt, metricsId, iso, aliases);
    existing = lookup.map;
    spent += lookup.subrequests;
  }

  // Tracks canonical titles already processed in THIS call. Separate from
  // `existing` (which means "lives in DB") so we can collapse in-batch
  // duplicates to a single write under upsert (previously the 2nd occurrence
  // re-ran update, costing a subrequest and skewing the updated count).
  // First-wins semantic: the earliest entry writes; subsequent same-title
  // entries return status:"skipped" + reason:"duplicate_in_batch". Mode
  // "create" preserves legacy duplicate-prone behavior unchanged.
  const handledInCall = new Set();
  const results = [];
  let i = startIdx;
  for (; i < entries.length; i++) {
    const e = entries[i];
    // Accept both ASCII (schema-canonical, required by the Anthropic tool-use
    // API) and Japanese keys (the original API; some clients/conversations
    // still use these). ASCII wins if both are present.
    const rawMetric = e.metric ?? e["指標"];
    const value = e.value ?? e["値"];
    const unit = e.unit ?? e["単位"];
    const memo = e.memo ?? e["メモ"];
    const metric = normalizeMetricName(rawMetric, aliases);
    const title = `${iso}_${metric}`;

    if (mode !== "create" && handledInCall.has(title)) {
      const found = existing.get(title);
      const row = {
        index: i, status: "skipped", reason: "duplicate_in_batch", ok: true, title,
        ...(found && { id: found.id, url: found.url }),
      };
      if (rawMetric !== metric) row.normalized_from = rawMetric;
      results.push(row);
      continue;
    }

    const found = existing.get(title);

    // Skip path costs 0 subrequests.
    if (found && mode === "skip_existing") {
      const row = { index: i, status: "skipped", ok: true, id: found.id, url: found.url, title };
      if (found.raw_title && found.raw_title !== title) row.matched_raw_title = found.raw_title;
      if (rawMetric !== metric) row.normalized_from = rawMetric;
      results.push(row);
      handledInCall.add(title);
      continue;
    }

    // Write paths each cost 1 subrequest.
    if (spent > 0 && spent + 1 > budget) break;

    try {
      const props = resolvePropDates(normalizeProperties(
        buildMetricsProps(iso, metric, value, unit, memo),
      ));
      let row;
      if (found && mode === "upsert") {
        const p = await notionReq(nt, "PATCH", `/pages/${found.id}`, { properties: props });
        row = { index: i, status: "updated", ok: true, id: p.id, url: p.url, title };
        if (found.raw_title && found.raw_title !== title) row.matched_raw_title = found.raw_title;
      } else {
        const p = await notionReq(nt, "POST", "/pages", {
          parent: { database_id: metricsId },
          properties: props,
        });
        row = { index: i, status: "created", ok: true, id: p.id, url: p.url, title };
        existing.set(title, { id: p.id, url: p.url });
      }
      if (rawMetric !== metric) row.normalized_from = rawMetric;
      results.push(row);
      handledInCall.add(title);
      spent += 1;
    } catch (err) {
      // Intentionally NOT marking the title as handled — the caller may want
      // to retry, and a transient 5xx shouldn't poison subsequent entries.
      results.push({ index: i, status: "error", ok: false, error: err.message, title });
      spent += 1;
    }
  }

  const remaining = entries.length - i;
  const counts = { created: 0, updated: 0, skipped: 0, error: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const out = {
    total: entries.length,
    processed: results.length,
    mode,
    ...counts,
    ...(counts.error > 0 && { partial_failure: true }),
    ...(remaining > 0 && {
      remaining,
      next_cursor: i,
      note: `Subrequest budget (${budget}) reached after ${results.length} entr${results.length === 1 ? "y" : "ies"}. ` +
        `Re-call with start_cursor:${i} to process the remaining ${remaining}.`,
    }),
    results: args.format === "tsv" ? toTSV(results) : results,
  };
  return out;
}

function computeSeriesStats(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return {
    count: nums.length,
    first: nums[0],
    last: nums[nums.length - 1],
    delta: nums[nums.length - 1] - nums[0],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / nums.length,
    median,
  };
}

async function runMetricsSeries(args, { env, nt }) {
  const metricsIdRaw = resolveMetricsId(args, env);
  if (!metricsIdRaw) return { error: "Metrics DB id not configured (NOTION_DB_IDS.metrics)" };
  const metricsId = normalizeId(metricsIdRaw);

  const aliases = parseMetricAliases(env);
  // ASCII `metric` is the schema-canonical input; Japanese `指標` is also
  // accepted as a fallback for clients still using the original API.
  const rawMetric = args.metric ?? args["指標"];
  if (!rawMetric || typeof rawMetric !== "string") return { error: "metric is required" };
  const metric = normalizeMetricName(rawMetric, aliases);

  const conds = [{ property: "指標", select: { equals: metric } }];
  if (args.from) conds.push({ property: "日付", date: { on_or_after: evalDate(args.from) } });
  if (args.to)   conds.push({ property: "日付", date: { on_or_before: evalDate(args.to) } });
  const filter = conds.length === 1 ? conds[0] : { and: conds };

  // Auto-paginate, mirroring n_query's safety caps (500 rows / 5 pages).
  const all = [];
  let cursor = null;
  let pages = 0;
  while (true) {
    const body = {
      page_size: 100,
      filter,
      sorts: [{ property: "日付", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    if (pages > 0) await sleep(350);
    const res = await notionReq(nt, "POST", `/databases/${metricsId}/query`, body);
    pages++;
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (!cursor || all.length >= 500 || pages >= 5) break;
  }

  let series = all.map(p => {
    const props = compactProps(p.properties);
    return {
      date: props["日付"] ?? null,
      "値": props["値"] ?? null,
      "単位": props["単位"] || null,
      "メモ": props["メモ"] || null,
    };
  });
  // limit = head N (oldest); tail = last N (latest). Both apply if set, with
  // limit first then tail, so `limit:200 + tail:5` means "the 5 latest entries
  // within the oldest 200". Stats and last_flag use whatever the final slice
  // contains (last entry of the returned series = the value being flagged).
  //
  // Coerce via Number() rather than gating on Number.isFinite(args.x) directly
  // — some MCP-client serializations send a schema-declared `number` as a JSON
  // string ("2" rather than 2), and strict isFinite would silently no-op. The
  // 2026-05-28 tail:N regression was exactly this. The coercion still rejects
  // NaN / Infinity / non-positive values, just via the post-Number check.
  const toPosInt = (v) => {
    if (v === undefined || v === null) return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const limitN = toPosInt(args.limit);
  const tailN = toPosInt(args.tail);
  if (limitN !== null) series = series.slice(0, limitN);
  if (tailN !== null) series = series.slice(-tailN);

  const nums = series.map(s => s["値"]).filter(n => typeof n === "number" && !isNaN(n));
  const stats = computeSeriesStats(nums);

  // Optional reference-range flagging via METRIC_RANGES. The field is omitted
  // entirely when no range is configured for this metric — a "normal" flag
  // would be misleading when there's nothing to compare against.
  const ranges = parseMetricRanges(env);
  const bounds = rangeBounds(ranges[metric]);
  const last = nums.length ? nums[nums.length - 1] : null;
  const last_flag = bounds ? flagValue(last, bounds) : null;

  const out = {
    "指標": metric,
    ...(rawMetric !== metric && { normalized_from: rawMetric }),
    count: series.length,
    fetched_pages: pages,
    has_more: cursor != null,
    series: args.format === "tsv" ? toTSV(series) : series,
    stats,
    ...(bounds && { ref: bounds }),
    ...(last_flag != null && { last_flag }),
  };
  return out;
}

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
