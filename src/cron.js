// ─────────────────────────────────────────────
// Daily "next" label maintenance
// ─────────────────────────────────────────────
// Fires once per day (see `[triggers].crons` in wrangler.toml) and walks
// active Todoist tasks to keep the `next` label consistent with due-date
// state. The webhook in src/webhook.js owns sequential (#N) sections; the
// cron owns everything else. Together they mean `@next` in Todoist is a
// reliable filter for "what can I actually work on right now."
import { evalDate } from "./utils.js";
import { todoistReq, todoistSync } from "./todoist.js";

// A task whose content starts with "#N " (e.g. "#1 buy milk") belongs to a
// user-maintained sequential list. The webhook handler manages `next` on
// those as part of its renumber pass — the cron must leave them alone to
// avoid the two pipelines fighting over the same label.
const SEQUENTIAL_PREFIX_RE = /^#\d+\s/;

// Todoist due.date may be a bare date ("2026-04-16") or a datetime
// ("2026-04-16T10:00:00+09:00"). String comparison with today's JST date
// is only safe after trimming to the date portion.
function dueDate(t) {
  return t.due?.date ? t.due.date.slice(0, 10) : null;
}

// Decide the per-task label mutation.
//   due ≤ today, no next, no waiting, no scheduled, not #N → add `next`
//   due >  today, has next                                → drop `next`
// `waiting` and `scheduled` are user-asserted blockers — neither should
// surface in @next queries, so we never add the label while either is on.
export function planLabelOps(tasks, today) {
  const ops = [];
  for (const t of tasks) {
    if (!t.id || typeof t.content !== "string") continue;
    if (SEQUENTIAL_PREFIX_RE.test(t.content)) continue;
    const due = dueDate(t);
    if (!due) continue;

    const labels = Array.isArray(t.labels) ? t.labels : [];
    const hasNext = labels.includes("next");
    const hasWaiting = labels.includes("waiting");
    const hasScheduled = labels.includes("scheduled");

    if (due <= today && !hasNext && !hasWaiting && !hasScheduled) {
      ops.push({ id: t.id, labels: [...labels, "next"] });
    } else if (due > today && hasNext) {
      ops.push({ id: t.id, labels: labels.filter(l => l !== "next") });
    }
  }
  return ops;
}

// Walk the active-task list with cursor paging. 20-page cap is a safety
// bound — in practice a personal workspace returns everything in one page.
async function listAllTasks(token) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const raw = await todoistReq(token, "GET", `/tasks${qs}`);
    const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
    out.push(...items);
    cursor = raw?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Entry point wired to the `scheduled` export in worker.js.
// Returns a summary object for logging/tests. No-op (not an error) when
// TODOIST_TOKEN is unset so deploys without the secret don't page oncall.
export async function runDailyNextLabels(env) {
  const token = env.TODOIST_TOKEN;
  if (!token) {
    console.log("cron: TODOIST_TOKEN not set, skipping");
    return { skipped: true };
  }

  const today = evalDate("today");
  const tasks = await listAllTasks(token);
  const ops = planLabelOps(tasks, today);

  if (!ops.length) {
    console.log(`cron: today=${today} scanned=${tasks.length} ops=0`);
    return { today, scanned: tasks.length, applied: 0 };
  }

  // Batch via Sync API. Using a stable uuid per command lets Todoist
  // deduplicate on 5xx retries inside todoistSync, so re-runs stay safe.
  const commands = ops.map(op => ({
    type: "item_update",
    uuid: crypto.randomUUID(),
    args: { id: op.id, labels: op.labels },
  }));

  for (const batch of chunk(commands, 100)) {
    await todoistSync(token, batch);
  }

  console.log(`cron: today=${today} scanned=${tasks.length} ops=${ops.length}`);
  return { today, scanned: tasks.length, applied: ops.length };
}
