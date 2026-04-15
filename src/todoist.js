import { sleep } from "./utils.js";

// ─────────────────────────────────────────────
// Todoist compact & TSV helpers
// ─────────────────────────────────────────────
export const TASK_COMPACT_DEFAULTS = ["id", "section", "co", "content", "labels", "due"];

export function compactTask(t, fields, sectionMap) {
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
export async function buildSectionMap(token, projectId) {
  const raw = await todoistReq(token, "GET", `/sections?project_id=${projectId}`);
  const sections = Array.isArray(raw) ? raw : (raw?.results ?? []);
  const map = {};
  for (const s of sections) map[s.id] = s.name;
  return { map, sections };
}

export function compactSection(s) {
  return { id: s.id, name: s.name, order: s.section_order ?? s.order ?? 0 };
}

export function compactProject(p) {
  return { id: p.id, name: p.name };
}

export function toTSV(rows) {
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
export function formatTodoistList(items, compactFn, args) {
  const compact = args.compact !== false; // default true
  const rows = compact ? items.map(i => compactFn(i)) : items;
  if (args.format === "json") return { results: rows, count: rows.length };
  return toTSV(rows); // default: tsv
}

// ─────────────────────────────────────────────
// Todoist API helper  (429対応: Retry-After尊重 + 指数バックオフ)
// ─────────────────────────────────────────────
export async function todoistReq(token, method, path, body, _attempt = 0) {
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
    // Retry-After may be delta-seconds or an HTTP-date; guard against NaN so
    // a non-numeric header doesn't collapse the wait to zero.
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "", 10);
    const headerMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
    const waitMs = Math.max(headerMs, 400 * Math.pow(2, _attempt));
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
    // Truncate to bound any echo of caller-supplied content in the response
    // body before it reaches the MCP error channel.
    const msg = (text || res.statusText || "").slice(0, 200);
    throw new Error(`Todoist ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─────────────────────────────────────────────
// Todoist Sync API helper
// Used for operations the REST API does not support, e.g. item_reorder.
// Sends a batch of commands in one POST to /sync/v9/sync.
// ─────────────────────────────────────────────
// Note: retries reuse the same command `uuid` so Todoist deduplicates them
// server-side — this keeps item_reorder idempotent across 5xx retries.
export async function todoistSync(token, commands, _attempt = 0) {
  const res = await fetch("https://api.todoist.com/api/v1/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commands }),
  });
  if (res.status === 429 && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "", 10);
    const headerMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
    await sleep(Math.max(headerMs, 400 * Math.pow(2, _attempt)));
    return todoistSync(token, commands, _attempt + 1);
  }
  if (res.status >= 500 && _attempt < 1) {
    await sleep(500);
    return todoistSync(token, commands, _attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = (text || res.statusText || "").slice(0, 200);
    throw new Error(`Todoist Sync ${res.status}: ${msg}`);
  }
  return res.json();
}
