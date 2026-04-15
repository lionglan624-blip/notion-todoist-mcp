/**
 * Notion + Todoist MCP Server for Cloudflare Workers
 *
 * Deploy:
 *   wrangler secret put NOTION_TOKEN   ← Notion integration token
 *   wrangler secret put TODOIST_TOKEN  ← Todoist API token
 *   wrangler deploy
 *
 * Then register the Worker URL as a custom connector in Claude.ai.
 */

const MCP_VERSION = "2024-11-05";

// ─────────────────────────────────────────────
// Date expression evaluator (JST-aware)
// Supported: "today", "yesterday", "tomorrow",
//   "today+7d", "today-30d", "today+2w", "today+1m", "today+1y", "now"
//   ISO date/datetime strings pass through as-is.
// ─────────────────────────────────────────────
function evalDate(expr) {
  if (!expr || typeof expr !== "string") return expr;

  // JST offset: UTC+9
  const nowUTC = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJST = new Date(nowUTC.getTime() + jstOffset);
  const todayJST = new Date(
    Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate())
  );

  const isoDate = (d) => d.toISOString().split("T")[0];

  if (expr === "now")       return nowJST.toISOString().replace("Z", "+09:00");
  if (expr === "today")     return isoDate(todayJST);
  if (expr === "yesterday") { const d = new Date(todayJST); d.setUTCDate(d.getUTCDate() - 1); return isoDate(d); }
  if (expr === "tomorrow")  { const d = new Date(todayJST); d.setUTCDate(d.getUTCDate() + 1); return isoDate(d); }

  // today±N[dwmy]
  const rel = expr.match(/^today([+-])(\d+)([dwmy])$/);
  if (rel) {
    const [, sign, num, unit] = rel;
    const n = parseInt(num, 10) * (sign === "+" ? 1 : -1);
    const d = new Date(todayJST);
    if (unit === "d") d.setUTCDate(d.getUTCDate() + n);
    if (unit === "w") d.setUTCDate(d.getUTCDate() + n * 7);
    if (unit === "m") d.setUTCMonth(d.getUTCMonth() + n);
    if (unit === "y") d.setUTCFullYear(d.getUTCFullYear() + n);
    return isoDate(d);
  }

  return expr; // ISO date/datetime pass-through
}

// Recursively resolve date expressions inside a Notion filter object
function resolveFilterDates(filter) {
  if (!filter || typeof filter !== "object") return filter;
  if (Array.isArray(filter)) return filter.map(resolveFilterDates);

  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === "date" && typeof v === "object" && v !== null) {
      out[k] = {};
      for (const [op, val] of Object.entries(v)) {
        const dateOps = ["equals","before","after","on_or_before","on_or_after"];
        out[k][op] = dateOps.includes(op) ? evalDate(val) : val;
      }
    } else if (typeof v === "object" && v !== null) {
      out[k] = resolveFilterDates(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Safe math evaluator
// Recursive descent parser — no eval/new Function (CF Workers compatible)
// Supports: +  -  *  /  %  ^  unary-  ()  Math.*  numeric literals
// ─────────────────────────────────────────────
function safeMath(expr) {
  if (!expr || typeof expr !== "string") throw new Error("Expression required");

  // ── Tokenizer ──────────────────────────────
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Invalid number: ${num}`);
      tokens.push({ t: "num", v: parseFloat(num) });
    } else if (/[a-zA-Z_]/.test(c)) {
      let id = "";
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) id += expr[i++];
      tokens.push({ t: "id", v: id });
    } else if ("+-*/%(),.^".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
    } else {
      throw new Error(`Unexpected character: ${c}`);
    }
  }
  tokens.push({ t: "eof", v: "" });

  // ── Supported Math.* ──────────────────────
  const MATH_FN = {
    round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    pow: Math.pow, hypot: Math.hypot,
    min: Math.min, max: Math.max,
    trunc: Math.trunc, sign: Math.sign,
  };
  const MATH_CONST = {
    PI: Math.PI, E: Math.E,
    LN2: Math.LN2, LN10: Math.LN10,
    LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
    SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
  };

  // ── Parser ────────────────────────────────
  let pos = 0;
  const peek   = ()  => tokens[pos];
  const consume = () => tokens[pos++];
  const expectOp = (v) => {
    if (peek().v !== v) throw new Error(`Expected '${v}', got '${peek().v || peek().t}'`);
    return consume();
  };

  // expr  = term  (('+' | '-') term)*
  function parseExpr() {
    let v = parseTerm();
    while (peek().v === "+" || peek().v === "-") {
      const op = consume().v;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  // term  = unary (('*' | '/' | '%') unary)*
  function parseTerm() {
    let v = parseUnary();
    while (["*", "/", "%"].includes(peek().v)) {
      const op = consume().v;
      const r = parseUnary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }

  // unary = ('-' | '+') unary  |  pow
  // Lower precedence than '^' so -2^2 === -(2^2) === -4 (standard math convention)
  function parseUnary() {
    if (peek().v === "-") { consume(); return -parseUnary(); }
    if (peek().v === "+") { consume(); return parseUnary(); }
    return parsePow();
  }

  // pow   = atom ('^' unary)?   (right-associative via unary → pow recursion)
  // 2^3^2 === 2^(3^2) === 512;   2^-3 === 0.125
  function parsePow() {
    const v = parseAtom();
    if (peek().v === "^") { consume(); return Math.pow(v, parseUnary()); }
    return v;
  }

  // atom  = NUMBER | '(' expr ')' | 'Math' '.' IDENT ('(' args ')')?
  function parseAtom() {
    const t = peek();
    if (t.t === "num") { consume(); return t.v; }
    if (t.v === "(") {
      consume();
      const v = parseExpr();
      expectOp(")");
      return v;
    }
    if (t.t === "id") {
      if (t.v === "Math") {
        consume();
        expectOp(".");
        const name = peek();
        if (name.t !== "id") throw new Error(`Expected Math.* name after '.'`);
        consume();
        if (peek().v === "(") {
          // Function call
          if (!(name.v in MATH_FN)) throw new Error(`Unknown Math function: Math.${name.v}`);
          consume(); // '('
          const args = [];
          if (peek().v !== ")") {
            args.push(parseExpr());
            while (peek().v === ",") { consume(); args.push(parseExpr()); }
          }
          expectOp(")");
          return MATH_FN[name.v](...args);
        } else {
          // Constant
          if (!(name.v in MATH_CONST)) throw new Error(`Unknown Math constant: Math.${name.v}`);
          return MATH_CONST[name.v];
        }
      }
      throw new Error(`Unknown identifier: ${t.v}`);
    }
    throw new Error(`Unexpected token: ${t.v || t.t}`);
  }

  let result;
  try {
    result = parseExpr();
    if (peek().t !== "eof") throw new Error(`Unexpected token after expression: '${peek().v}'`);
  } catch (e) {
    throw new Error(`Math error: ${e.message}`);
  }
  if (typeof result !== "number" || !isFinite(result)) {
    throw new Error("Result is not a finite number");
  }
  return result;
}

// ─────────────────────────────────────────────
// Todoist compact & TSV helpers
// ─────────────────────────────────────────────
const TASK_COMPACT_DEFAULTS = ["id", "section", "co", "content", "labels", "due"];
const TASK_FULL_MAP = {
  id: "id", section: "(resolved)", sid: "section_id", co: "child_order",
  content: "content", labels: "labels", due: "due", pid: "parent_id",
  pri: "priority", desc: "description", proj: "project_id", rec: "due",
};

function compactTask(t, fields, sectionMap) {
  const f = fields || TASK_COMPACT_DEFAULTS;
  const o = {};
  for (const k of f) {
    switch (k) {
      case "id":      o.id = t.id; break;
      case "section": o.section = sectionMap?.[t.section_id] ?? t.section_id ?? ""; break;
      case "sid":     o.sid = t.section_id ?? ""; break;
      case "co":      o.co = t.child_order ?? 0; break;
      case "content": o.content = t.content ?? ""; break;
      case "labels":  o.labels = t.labels ?? []; break;
      case "due":     o.due = t.due?.date ?? ""; break;
      case "pid":     o.pid = t.parent_id ?? ""; break;
      case "pri":     o.pri = (t.priority ?? 1) > 1 ? t.priority : ""; break;
      case "desc":    o.desc = t.description ?? ""; break;
      case "proj":    o.proj = t.project_id ?? ""; break;
      case "rec":     o.rec = t.due?.is_recurring ? "y" : ""; break;
      case "cat":     o.cat = t.completed_at ?? ""; break;
    }
  }
  return o;
}

// Build section_id → name map from Todoist sections API
async function buildSectionMap(token, projectId) {
  const raw = await todoistReq(token, "GET", `/sections?project_id=${projectId}`);
  const sections = Array.isArray(raw) ? raw : (raw?.results ?? []);
  const map = {};
  for (const s of sections) map[s.id] = s.name;
  return { map, sections };
}

function compactSection(s) {
  return { id: s.id, name: s.name, order: s.section_order ?? s.order ?? 0 };
}

function compactProject(p) {
  return { id: p.id, name: p.name };
}

function toTSV(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(",");
    const s = String(v);
    // If value contains tab or newline, quote it (replace internal newlines with ␊)
    if (s.includes("\t") || s.includes("\n") || s.includes("\r"))
      return s.replace(/[\r\n]+/g, "␊");
    return s;
  };
  const header = keys.join("\t");
  const lines = rows.map(r => keys.map(k => escape(r[k])).join("\t"));
  return header + "\n" + lines.join("\n");
}

// Apply compact + format to a Todoist list result
function formatTodoistList(items, compactFn, args) {
  const compact = args.compact !== false; // default true
  const rows = compact ? items.map(i => compactFn(i)) : items;
  if (args.format === "json") return { results: rows, count: rows.length };
  return toTSV(rows); // default: tsv
}

// ─────────────────────────────────────────────
// Notion API helper  (429対応: Retry-After尊重 + 指数バックオフ)
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notionReq(token, method, path, body, _attempt = 0) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limited — wait and retry (max 4 attempts)
  if (res.status === 429 && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
    const waitMs = Math.max(retryAfter * 1000, 400 * Math.pow(2, _attempt));
    await sleep(waitMs);
    return notionReq(token, method, path, body, _attempt + 1);
  }

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Notion ${res.status}: ${e.message || res.statusText}`);
  }
  return res.json();
}

// Strip collection:// prefix if present
function normalizeId(id) {
  return id?.replace(/^collection:\/\//, "").replace(/-/g, "").replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"
  ) ?? id;
}

// Extract numeric value from any Notion property
function extractNum(prop) {
  if (!prop) return null;
  if (prop.type === "number") return prop.number;
  if (prop.type === "formula") return prop.formula?.number ?? null;
  if (prop.type === "rollup") {
    if (prop.rollup?.type === "number") return prop.rollup.number;
    if (prop.rollup?.type === "array") {
      const nums = (prop.rollup.array || []).map(extractNum).filter(n => n !== null);
      return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
    }
  }
  return null;
}


// Compact property extractor: Notion property JSON → simple value (token saver)
function compactProps(properties) {
  const out = {};
  for (const [k, v] of Object.entries(properties)) {
    switch (v.type) {
      case "title":
      case "rich_text": out[k] = v[v.type].map(t => t.plain_text).join(""); break;
      case "number":    out[k] = v.number; break;
      case "select":    out[k] = v.select?.name ?? null; break;
      case "multi_select": out[k] = v.multi_select.map(o => o.name); break;
      case "status":    out[k] = v.status?.name ?? null; break;
      case "date":      out[k] = v.date ? (v.date.end ? `${v.date.start}~${v.date.end}` : v.date.start) : null; break;
      case "checkbox":  out[k] = v.checkbox; break;
      case "url":       out[k] = v.url; break;
      case "email":     out[k] = v.email; break;
      case "phone_number": out[k] = v.phone_number; break;
      case "formula":   out[k] = v.formula?.string ?? v.formula?.number ?? v.formula?.boolean ?? null; break;
      case "relation":  out[k] = v.relation.map(r => r.id); break;
      case "rollup":    out[k] = v.rollup?.number ?? v.rollup?.array?.map(i => compactProps({v: i}).v) ?? null; break;
      case "created_time": out[k] = v.created_time; break;
      case "last_edited_time": out[k] = v.last_edited_time; break;
      default: out[k] = null;
    }
  }
  return out;
}


// ─────────────────────────────────────────────
// Markdown → Notion blocks converter
// Supports: h1-h3, bullet, numbered, quote,
//   divider, code fence, paragraph
//   Inline: **bold**, *italic*, `code`
// ─────────────────────────────────────────────
function mkRichText(line) {
  const parts = [];
  // tokenize inline: **bold**, *italic*, `code`
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0, m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push({ type: "text", text: { content: line.slice(last, m.index) } });
    if (m[2] !== undefined) parts.push({ type: "text", text: { content: m[2] }, annotations: { bold: true } });
    else if (m[3] !== undefined) parts.push({ type: "text", text: { content: m[3] }, annotations: { italic: true } });
    else if (m[4] !== undefined) parts.push({ type: "text", text: { content: m[4] }, annotations: { code: true } });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ type: "text", text: { content: line.slice(last) } });
  return parts.length ? parts : [{ type: "text", text: { content: line } }];
}

function mdToBlocks(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // code fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      blocks.push({ object: "block", type: "code",
        code: { rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }], language: lang } });
      i++; continue;
    }
    // headings
    if (line.startsWith("### ")) { blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: mkRichText(line.slice(4)) } }); i++; continue; }
    if (line.startsWith("## "))  { blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: mkRichText(line.slice(3)) } }); i++; continue; }
    if (line.startsWith("# "))   { blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: mkRichText(line.slice(2)) } }); i++; continue; }
    // quote
    if (line.startsWith("> "))   { blocks.push({ object: "block", type: "quote",     quote:     { rich_text: mkRichText(line.slice(2)) } }); i++; continue; }
    // divider
    if (/^---+$/.test(line.trim())) { blocks.push({ object: "block", type: "divider", divider: {} }); i++; continue; }
    // bullet list
    if (/^[-*+] /.test(line))    { blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: mkRichText(line.slice(2)) } }); i++; continue; }
    // numbered list
    if (/^\d+\. /.test(line))    { blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: mkRichText(line.replace(/^\d+\. /, "")) } }); i++; continue; }
    // blank line → skip
    if (line.trim() === "")      { i++; continue; }
    // paragraph
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: mkRichText(line) } });
    i++;
  }
  return blocks;
}

// Resolve date values in a properties map before sending to Notion
function resolvePropDates(properties) {
  if (!properties) return properties;
  const out = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v?.date?.start) {
      out[k] = { date: { ...v.date, start: evalDate(v.date.start), end: v.date.end ? evalDate(v.date.end) : undefined } };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Property shorthand normalizer
// Converts simple values into Notion API property format:
//   "text"           → rich_text
//   123              → number
//   true/false       → checkbox
//   ["a","b"]        → multi_select
//   {title:"text"}   → title
//   {select:"name"}  → select
//   {date:"expr"}    → date  (evalDate applied)
//   {multi_select:["a"]} → multi_select
//   Already-formatted Notion objects pass through unchanged.
// ─────────────────────────────────────────────
function normalizeProperties(properties) {
  if (!properties) return properties;
  const NOTION_KEYS = new Set([
    "rich_text","title","number","select","multi_select",
    "date","checkbox","url","email","phone_number","status",
    "relation","people","files",
  ]);
  const out = {};
  for (const [key, val] of Object.entries(properties)) {
    if (val === null || val === undefined) { out[key] = val; continue; }

    // Object — check if already Notion format or a shorthand wrapper
    if (typeof val === "object" && !Array.isArray(val)) {
      const vKeys = Object.keys(val);
      if (vKeys.some(k => NOTION_KEYS.has(k))) {
        // Shorthand wrappers inside Notion-keyed objects
        if (val.title   && typeof val.title === "string")
          { out[key] = { title: [{ text: { content: val.title } }] }; continue; }
        if (val.select  && typeof val.select === "string")
          { out[key] = { select: { name: val.select } }; continue; }
        if (val.multi_select && Array.isArray(val.multi_select) && typeof val.multi_select[0] === "string")
          { out[key] = { multi_select: val.multi_select.map(n => ({ name: n })) }; continue; }
        if (val.date    && typeof val.date === "string")
          { out[key] = { date: { start: evalDate(val.date) } }; continue; }
        // Already full Notion format — pass through
        out[key] = val; continue;
      }
    }

    // Plain string → rich_text
    if (typeof val === "string")  { out[key] = { rich_text: [{ text: { content: val } }] }; continue; }
    // Number → number
    if (typeof val === "number")  { out[key] = { number: val }; continue; }
    // Boolean → checkbox
    if (typeof val === "boolean") { out[key] = { checkbox: val }; continue; }
    // Array of strings → multi_select
    if (Array.isArray(val) && val.length && val.every(v => typeof v === "string"))
      { out[key] = { multi_select: val.map(n => ({ name: n })) }; continue; }

    // Fallback — pass through
    out[key] = val;
  }
  return out;
}

// ─────────────────────────────────────────────
// Todoist API helper  (429対応: Retry-After尊重 + 指数バックオフ)
// ─────────────────────────────────────────────
async function todoistReq(token, method, path, body, _attempt = 0) {
  const res = await fetch(`https://api.todoist.com/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limited — wait and retry (max 4 attempts)
  if (res.status === 429 && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
    const waitMs = Math.max(retryAfter * 1000, 400 * Math.pow(2, _attempt));
    await sleep(waitMs);
    return todoistReq(token, method, path, body, _attempt + 1);
  }

  // Server error — wait 500ms and retry once.
  // Write ops (POST/DELETE) are idempotent by task_id for update/close/delete/reopen.
  // For create, caller handles dedup (see t_create_task / t_bulk).
  if (res.status >= 500 && _attempt < 1) {
    await sleep(500);
    return todoistReq(token, method, path, body, _attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Todoist ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─────────────────────────────────────────────
// Todoist Sync API helper
// Used for operations the REST API does not support, e.g. item_reorder.
// Sends a batch of commands in one POST to /sync/v9/sync.
// ─────────────────────────────────────────────
async function todoistSync(token, commands, _attempt = 0) {
  const res = await fetch("https://api.todoist.com/api/v1/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commands }),
  });
  if (res.status === 429 && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
    await sleep(Math.max(retryAfter * 1000, 400 * Math.pow(2, _attempt)));
    return todoistSync(token, commands, _attempt + 1);
  }
  if (res.status >= 500 && _attempt < 1) {
    await sleep(500);
    return todoistSync(token, commands, _attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Todoist Sync ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// Tool definitions  (ordered by usage frequency)
// ─────────────────────────────────────────────
const TOOLS = [
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
    description: "Search Notion workspace by title.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["page", "database"] },
        page_size: { type: "number", default: 10 },
      },
      required: ["query"],
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
    description: "Add/remove columns or rename a Notion database. add: {col: schema}, remove: [colNames].",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        add: { type: "object" },
        remove: { type: "array", items: { type: "string" } },
        title: { type: "string", description: "Rename the database" },
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

// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────
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
      const body = { page_size: args.page_size ?? 20 };
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
      const db = await notionReq(nt, "PATCH", `/databases/${id}`, body);
      return { id: db.id, url: db.url, last_edited_time: db.last_edited_time };
  },

  n_create_page: async (args, { nt }) => {
      const id = normalizeId(args.database_id);
      const body = {
        parent: { database_id: id },
        properties: resolvePropDates(normalizeProperties(args.properties)),
      };
      if (args.content) {
        const blocks = mdToBlocks(args.content);
        if (blocks.length) body.children = blocks;
      }
      const p = await notionReq(nt, "POST", "/pages", body);
      return { id: p.id, url: p.url, created_time: p.created_time };
  },

  n_update_page: async (args, { nt }) => {
      const pid = normalizeId(args.page_id);
      // 1. Property / archived update
      if (args.properties || args.archived !== undefined) {
        const body = {};
        if (args.properties) body.properties = resolvePropDates(normalizeProperties(args.properties));
        if (args.archived !== undefined) body.archived = args.archived;
        await notionReq(nt, "PATCH", `/pages/${pid}`, body);
      }
      // 2. replace_content: delete all existing blocks then append new ones
      if (args.replace_content !== undefined) {
        // Paginate through all existing children — page_size=100 is the Notion API max
        const allBlocks = [];
        let cursor;
        do {
          const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : `?page_size=100`;
          const page = await notionReq(nt, "GET", `/blocks/${pid}/children${qs}`);
          allBlocks.push(...page.results);
          cursor = page.has_more ? page.next_cursor : null;
        } while (cursor);
        for (const blk of allBlocks) {
          await notionReq(nt, "DELETE", `/blocks/${blk.id}`, undefined).catch(() => {});
        }
        const newBlocks = mdToBlocks(args.replace_content);
        if (newBlocks.length) {
          await notionReq(nt, "PATCH", `/blocks/${pid}/children`, { children: newBlocks });
        }
      }
      // 3. append_content: append blocks after existing content
      if (args.append_content) {
        const appendBlocks = mdToBlocks(args.append_content);
        if (appendBlocks.length) {
          await notionReq(nt, "PATCH", `/blocks/${pid}/children`, { children: appendBlocks });
        }
      }
      const p = await notionReq(nt, "GET", `/pages/${pid}`);
      return { id: p.id, url: p.url, last_edited_time: p.last_edited_time };
  },

  n_search: async (args, { nt }) => {
      const body = { query: args.query, page_size: args.page_size ?? 10 };
      if (args.type) body.filter = { value: args.type, property: "object" };
      const res = await notionReq(nt, "POST", "/search", body);
      return {
        results: res.results.map(r => ({
          id: r.id, type: r.object, url: r.url,
          title: r.title?.[0]?.plain_text ?? r.properties?.title?.title?.[0]?.plain_text ?? "(untitled)",
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
        if (!pid) return { error: "project_id is required when using section name or section output field" };
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
      if (args.priority)    body.priority = args.priority;
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
      if (rest.priority)    body.priority = rest.priority;
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
      if (args.limit)      params.set("limit", String(args.limit));
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
              if (op.priority)    body.priority = op.priority;
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
              if (op.priority)    body.priority = op.priority;
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
          // Mark affected results as failed
          for (const item of reorderItems) {
            const r = results.find(r => r.task_id === item.id);
            if (r) { r.ok = false; r.error = `Reorder failed: ${e.message}`; }
          }
        }
      }

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

// ─────────────────────────────────────────────
// MCP JSON-RPC handler
// ─────────────────────────────────────────────
async function handleMCP(request, url, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const verified = token ? await verifyToken(token, "access", env).catch(() => null) : null;
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
          serverInfo: { name: "notion-todoist-mcp", version: "1.7.0" },
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

// MCP and /health responses: no CORS wildcard.
// The /mcp endpoint requires a Bearer token, and MCP clients are native
// (not browsers), so advertising `Access-Control-Allow-Origin: *` only
// benefits attackers running JS in a victim's browser tab.
// OAuth discovery/registration/authorize/token endpoints use oauthJson()
// below, which still returns CORS headers since those are legitimately
// called cross-origin by browser-based OAuth clients.
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcErr(id, code, message) {
  return jsonResp({ jsonrpc: "2.0", id, error: { code, message } });
}

// ─────────────────────────────────────────────
// OAuth 2.1 (stateless, HMAC-signed tokens — single-user)
// ─────────────────────────────────────────────
const b64u = {
  enc: (buf) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  encStr: (s) => b64u.enc(new TextEncoder().encode(s)),
  decStr: (s) => new TextDecoder().decode(b64u.dec(s)),
};

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Separate the HMAC signing key from the login password.
// MCP_SIGNING_KEY: HMAC-SHA256 secret used to sign/verify OAuth tokens.
// MCP_LOGIN_SECRET: password the user types on the /authorize login page.
// If either is unset, fall back to MCP_SECRET for backwards compatibility
// with existing single-secret deployments.
function getSigningKey(env) {
  return env.MCP_SIGNING_KEY || env.MCP_SECRET;
}
function getLoginSecret(env) {
  return env.MCP_LOGIN_SECRET || env.MCP_SECRET;
}

async function signToken(payload, env) {
  const secret = getSigningKey(env);
  if (!secret) throw new Error("signing key not configured");
  const key = await hmacKey(secret);
  const body = b64u.encStr(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64u.enc(sig)}`;
}

async function verifyToken(token, expectedTyp, env) {
  const secret = getSigningKey(env);
  if (!secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64u.dec(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64u.decStr(body)); } catch { return null; }
  if (payload.typ !== expectedTyp) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function sha256b64u(input) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64u.enc(hash);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
};

function oauthJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function handleProtectedResourceMetadata(url) {
  return oauthJson({
    resource: `${url.origin}/mcp`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ["header"],
  });
}

function handleAuthServerMetadata(url) {
  return oauthJson({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/authorize`,
    token_endpoint: `${url.origin}/token`,
    registration_endpoint: `${url.origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}

async function handleRegister(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  return oauthJson({
    client_id: "mcp-public-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
}

function loginPage(params, errorMsg) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v ?? "")}">`)
    .join("");
  const err = errorMsg ? `<p style="color:#b00">${escapeHtml(errorMsg)}</p>` : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>MCP Sign-in</title>
<style>body{font-family:system-ui;max-width:420px;margin:80px auto;padding:0 20px}
input[type=password]{width:100%;padding:10px;font-size:16px;box-sizing:border-box}
button{margin-top:12px;padding:10px 20px;font-size:16px;cursor:pointer}</style></head>
<body><h2>MCP Server Sign-in</h2>
<p>Enter your login secret (<code>MCP_LOGIN_SECRET</code>) to authorize this client.</p>
${err}<form method="POST" action="/authorize">${hidden}
<input type="password" name="secret" autofocus required>
<button type="submit">Authorize</button></form></body></html>`,
    { status: errorMsg ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleAuthorize(request, url, env) {
  if (request.method === "GET") {
    const p = Object.fromEntries(url.searchParams);
    if (!p.redirect_uri || !p.code_challenge || p.code_challenge_method !== "S256") {
      return new Response("invalid_request: redirect_uri and PKCE S256 required", { status: 400 });
    }
    return loginPage(p);
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const p = Object.fromEntries(form);
    const expectedLogin = getLoginSecret(env);
    if (!expectedLogin || p.secret !== expectedLogin) {
      return loginPage(p, "Invalid secret");
    }
    const code = await signToken({
      typ: "code",
      exp: Math.floor(Date.now() / 1000) + 300,
      cc: p.code_challenge,
      ru: p.redirect_uri,
    }, env);
    const redirect = new URL(p.redirect_uri);
    redirect.searchParams.set("code", code);
    if (p.state) redirect.searchParams.set("state", p.state);
    return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

async function handleToken(request, env) {
  try {
    return await handleTokenInner(request, env);
  } catch {
    // Never echo request body, headers, or internal error details.
    // Raw token-endpoint bodies contain secrets (authorization_code,
    // code_verifier, refresh_token) and must not reach response bodies
    // or unhandled-exception logs on the Cloudflare runtime side.
    return oauthJson({ error: "server_error" }, 500);
  }
}

async function handleTokenInner(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  const grant = form.get("grant_type");
  const now = Math.floor(Date.now() / 1000);

  if (grant === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const payload = await verifyToken(code ?? "", "code", env).catch(() => null);
    if (!payload) return oauthJson({ error: "invalid_grant" }, 400);
    if (payload.ru !== redirectUri) return oauthJson({ error: "invalid_grant" }, 400);
    const challenge = await sha256b64u(verifier ?? "");
    if (challenge !== payload.cc) return oauthJson({ error: "invalid_grant" }, 400);
    const access = await signToken({ typ: "access", exp: now + 3600 }, env);
    const refresh = await signToken({ typ: "refresh", exp: now + 60 * 60 * 24 * 30 }, env);
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: "mcp",
    });
  }

  if (grant === "refresh_token") {
    const rt = form.get("refresh_token");
    const payload = await verifyToken(rt ?? "", "refresh", env).catch(() => null);
    if (!payload) return oauthJson({ error: "invalid_grant" }, 400);
    const access = await signToken({ typ: "access", exp: now + 3600 }, env);
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp",
    });
  }

  return oauthJson({ error: "unsupported_grant_type" }, 400);
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      return handleProtectedResourceMetadata(url);
    }
    if (p === "/.well-known/oauth-authorization-server") {
      return handleAuthServerMetadata(url);
    }
    if (p === "/register") return handleRegister(request);
    if (p === "/authorize") return handleAuthorize(request, url, env);
    if (p === "/token") return handleToken(request, env);

    if (p === "/" || p === "/mcp") {
      return handleMCP(request, url, env);
    }

    if (p === "/health") {
      return jsonResp({ status: "ok", tools: TOOLS.length });
    }

    return new Response("Notion + Todoist MCP Server", { status: 200 });
  },
};