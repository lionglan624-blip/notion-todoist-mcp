import { sleep, evalDate } from "./utils.js";

// ─────────────────────────────────────────────
// Notion API helper  (429対応: Retry-After尊重 + 指数バックオフ)
// ─────────────────────────────────────────────
export async function notionReq(token, method, path, body, _attempt = 0) {
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
    // Retry-After can be delta-seconds or an HTTP-date (RFC 7231).
    // parseInt on a date string yields NaN → fall back to exponential backoff
    // instead of retrying immediately, which would defeat rate-limit handling.
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "", 10);
    const headerMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
    const waitMs = Math.max(headerMs, 400 * Math.pow(2, _attempt));
    await sleep(waitMs);
    return notionReq(token, method, path, body, _attempt + 1);
  }

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Notion ${res.status}: ${e.message || res.statusText}`);
  }
  return res.json();
}

// Compact property extractor: Notion property JSON → simple value (token saver)
export function compactProps(properties) {
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
      case "formula":   out[k] = v.formula?.string ?? v.formula?.number ?? v.formula?.boolean ?? v.formula?.date?.start ?? null; break;
      case "relation":  out[k] = v.relation.map(r => r.id); break;
      case "rollup": {
        // Rollup payloads are either a scalar or an array of property-shaped
        // items. Extract each array element by temporarily wrapping it so we
        // can reuse the same switch — but do it via a clearer helper.
        const rollupItem = (item) => {
          if (!item || typeof item !== "object") return item;
          const wrapped = compactProps({ __: item });
          return wrapped.__;
        };
        out[k] = v.rollup?.number
          ?? v.rollup?.array?.map(rollupItem)
          ?? v.rollup?.date?.start
          ?? null;
        break;
      }
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
// Notion rejects any single rich_text `text.content` longer than 2000 chars
// with a validation_error. Split oversize segments into multiple rich_text
// items (the block itself can hold many segments).
const NOTION_TEXT_LIMIT = 2000;

function splitLongRichText(parts) {
  const out = [];
  for (const p of parts) {
    const content = p.text?.content ?? "";
    if (content.length <= NOTION_TEXT_LIMIT) { out.push(p); continue; }
    for (let i = 0; i < content.length; i += NOTION_TEXT_LIMIT) {
      out.push({ ...p, text: { ...p.text, content: content.slice(i, i + NOTION_TEXT_LIMIT) } });
    }
  }
  return out;
}

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
  const final = parts.length ? parts : [{ type: "text", text: { content: line } }];
  return splitLongRichText(final);
}

// Notion caps "Append block children" and page-create `children` at 100
// blocks per request. Longer markdown must be appended in successive
// batches or the API returns 400 validation_error.
export const NOTION_CHILDREN_BATCH = 100;

export async function appendBlocksChunked(token, parentId, blocks) {
  for (let i = 0; i < blocks.length; i += NOTION_CHILDREN_BATCH) {
    const chunk = blocks.slice(i, i + NOTION_CHILDREN_BATCH);
    await notionReq(token, "PATCH", `/blocks/${parentId}/children`, { children: chunk });
  }
}

export function mdToBlocks(md) {
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
      const codeContent = codeLines.join("\n");
      blocks.push({ object: "block", type: "code",
        code: { rich_text: splitLongRichText([{ type: "text", text: { content: codeContent } }]), language: lang } });
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
export function resolvePropDates(properties) {
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
export function normalizeProperties(properties) {
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
        if (val.multi_select && Array.isArray(val.multi_select) && val.multi_select.every(v => typeof v === "string"))
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
