// ─────────────────────────────────────────────
// Todoist webhook — sequential (#N) section renumbering
// ─────────────────────────────────────────────
// Fires on `item:completed`. When a task whose content starts with `#N `
// is closed, the handler re-numbers the remaining siblings in the same
// section so they run 1..K contiguously, and moves the `next` label onto
// whichever task is now `#1`.
//
// Design is fully idempotent: it never derives state from the webhook
// payload alone, only from a fresh /tasks fetch of the section, then
// writes the delta. Re-delivery of the same event (Todoist retries up to
// 15× on non-2xx) produces no further changes.
import { assertTodoistId } from "./utils.js";
import { todoistReq, todoistSync } from "./todoist.js";

// Capture group 1 = the number; group 2 = the rest (preserves the exact
// whitespace/content so renames don't eat or insert spacing).
const SEQ_CONTENT_RE = /^#(\d+)(\s.*)$/;

// Todoist signs the raw body with the app's client_secret using HMAC-SHA256
// and sends the digest base64-encoded in X-Todoist-Hmac-SHA256. Rejecting
// unsigned / bad-signature requests here is the only thing standing between
// a public URL and unauthenticated writes to the user's account.
async function verifyTodoistSig(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleItemCompleted(event, token) {
  const data = event?.event_data ?? {};
  const content = data.content;
  if (typeof content !== "string" || !SEQ_CONTENT_RE.test(content)) {
    return { ok: true, note: "not sequential" };
  }
  const sectionId = data.section_id;
  if (!sectionId) return { ok: true, note: "no section" };
  assertTodoistId(sectionId, "section_id");

  // Scope renumbering to siblings of the completed task so top-level tasks
  // and subtasks don't collide — a `#1` top-level and a `#1` subtask can
  // legitimately coexist under the same section.
  const parentId = data.parent_id ?? null;
  if (parentId) assertTodoistId(parentId, "parent_id");

  const raw = await todoistReq(
    token,
    "GET",
    `/tasks?section_id=${encodeURIComponent(sectionId)}`,
  );
  const items = Array.isArray(raw) ? raw : (raw?.results ?? []);

  const seq = [];
  for (const t of items) {
    if ((t.parent_id ?? null) !== parentId) continue;
    const m = typeof t.content === "string" ? t.content.match(SEQ_CONTENT_RE) : null;
    if (!m) continue;
    seq.push({
      id: t.id,
      n: parseInt(m[1], 10),
      rest: m[2],
      labels: Array.isArray(t.labels) ? t.labels : [],
    });
  }
  seq.sort((a, b) => a.n - b.n);

  const commands = [];
  for (let i = 0; i < seq.length; i++) {
    const target = i + 1;
    const task = seq[i];
    const newContent = `#${target}${task.rest}`;
    const shouldHaveNext = target === 1;
    const hasNext = task.labels.includes("next");
    const contentChanged = task.n !== target;
    const needsLabelChange = shouldHaveNext !== hasNext;
    if (!contentChanged && !needsLabelChange) continue;

    const labels = shouldHaveNext
      ? (hasNext ? task.labels : [...task.labels, "next"])
      : task.labels.filter(l => l !== "next");

    commands.push({
      type: "item_update",
      uuid: crypto.randomUUID(),
      args: {
        id: assertTodoistId(task.id, "task_id"),
        content: newContent,
        labels,
      },
    });
  }

  if (!commands.length) return { ok: true, renumbered: 0 };

  for (let i = 0; i < commands.length; i += 100) {
    await todoistSync(token, commands.slice(i, i + 100));
  }
  return { ok: true, renumbered: commands.length };
}

export async function handleTodoistWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = env.TODOIST_WEBHOOK_SECRET;
  const token = env.TODOIST_TOKEN;
  if (!secret || !token) {
    // 200 — an unconfigured deploy would otherwise accumulate Todoist
    // retries (up to 15× with backoff) against an endpoint that can't
    // meaningfully succeed.
    return new Response("not configured", { status: 200 });
  }

  const rawBody = await request.text();
  const sig = request.headers.get("X-Todoist-Hmac-SHA256") ?? "";
  const ok = await verifyTodoistSig(rawBody, sig, secret);
  if (!ok) return new Response("invalid signature", { status: 401 });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response("bad json", { status: 400 }); }

  // Always 200 on a signed event. Todoist's retry policy amplifies any
  // non-2xx into repeat fires; we'd rather log an internal failure and
  // absorb it than process the same "#1 complete" five times.
  try {
    if (event?.event_name === "item:completed") {
      const result = await handleItemCompleted(event, token);
      console.log("webhook: item:completed", JSON.stringify(result));
    } else {
      console.log("webhook: ignoring", event?.event_name);
    }
  } catch (e) {
    console.log("webhook error:", e?.message ?? String(e));
  }
  return new Response("ok", { status: 200 });
}
