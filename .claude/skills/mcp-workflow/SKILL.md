---
name: mcp-workflow
description: Todoist × Notion GTD workflow conventions for this repo's MCP tools. Invoke before using any `mcp__notion-todoist__*` tool — covers conversation bootstrap, label rules, webhook/cron automations, calendar integration, /review steps, and Notion lifelog routing.
---

# Todoist × Notion GTD Workflow

> **Language rule:** All user-facing responses MUST be in Japanese (日本語).
> These instructions are in English solely for Claude's parsing efficiency.

---

## Conversation Bootstrap

At the start of **every conversation**, call `context` (zero arguments) before
responding. Returns Todoist Inbox tasks (TSV with section names) + Notion habits
page text in a single MCP round-trip. Use the returned data as working context
for the rest of the conversation.

---

## Todoist Structure

All tasks live in **Inbox** (the sole project).
"Projects" = sections within Inbox.
The Worker resolves `inbox_project_id` from server config — never pass
`project_id` for Inbox operations.

Do NOT use any official Notion MCP or official Todoist MCP.

### Task Naming

Sequential sections use `#1`, `#2`, `#3`… prefixes.
Only the `#1` task in each sequential section gets the `next` label.

### Subtasks

Create via `parent_id` in `t_create_task` / `t_bulk`.
Todoist API v1 cannot move subtasks after creation — to promote, delete and
recreate as a top-level task.

### Labels

| Label | Meaning |
|-------|---------|
| `next` | Actionable now — the current Next Action |
| `waiting` | Blocked on someone else (reply pending, delegated work) |
| `scheduled` | Date-certain appointment (vaccination, surgery, reservation). Calendar registration target. |
| *(none)* | Not actionable (predecessor incomplete, deferred, etc.) |

### Label Rules

- Sequential sections: only `#1` gets `next`; `#2`+ have no label.
- Time-based deferral uses due date, NOT `waiting`.
- `due date > today` → do NOT attach `next` (still deferred).
- `due date ≤ today` → consider attaching `next`.
- `waiting` + `next` conflict → keep `waiting` only.

### Due Date Semantics

- Default: **Defer Date** (eligible for action on/after this date).
- With `scheduled` label: **Appointment Date** (the actual event date).

### Escalation Rules

- `@scheduled` medical/vaccine tasks: do NOT auto-advance due dates or cascade
  next-in-series. On completion, acknowledge only; don't create follow-ups
  unless asked.
- Recurring tasks: use Todoist's native recurrence via `due_string`, not date
  math.

### `scheduled` Label Lifecycle

**`scheduled` and `#N` are mutually exclusive.** A `scheduled` task is a
calendar-bound appointment; a `#N` task is a position in an action queue.
Never combine them — the webhook/cron will conflict.

**Task splitting pattern** — when an action requires booking before execution,
create two separate tasks:

```
#N 〇〇予約する          ← sequential queue (#N, next when #1)
〇〇（施設名）           ← standalone, gets `scheduled` on booking completion
```

When the `#N 予約する` task is completed:
1. Create (or update) the execution task with `scheduled` label + `due_date` =
   appointment date. **No `#N` prefix.**
2. The remaining `#N` siblings renumber automatically (webhook/inline).
3. Register in iCloud Calendar (title, full address, notification with travel time).

On task completion or date change → update the calendar entry accordingly.

---

## Automations (Cloudflare Worker)

Two background automations manage `next` automatically. Do not fight them.

### Automation 1 — Daily Cron (UTC 00:00 = JST 09:00)

Manages `next` on **non-sequential tasks that have a due date**:
- `due ≤ today` + no `next` + no `waiting` + no `scheduled` → adds `next`
- `due > today` + `next` present → removes `next`

Cron skips entirely:
- Tasks whose content matches `#\d+ ` (sequential prefix) — webhook owns those
- Tasks with **no due date** — never touched, manage `next` manually
- Tasks carrying `waiting` or `scheduled`

### Automation 2 — Completion Webhook (realtime)

Fires on `item:completed` for tasks starting with `#N ` (sequential prefix):
- Remaining siblings in the same section + same `parent_id` are renumbered
  contiguously: `#2→#1`, `#3→#2`, …
- `next` moves onto the new `#1`; removed from all others.
- Fully idempotent (safe on Todoist retries up to 15×).

**Never rename `#N ` prefixes yourself.** Create tasks with the correct prefix
and let the webhook handle renumbering and `next` promotion on completion.

---

## Calendar Integration

Claude can read/write calendars via iPhone Claude app only (iCloud Calendar is
default). Available calendars: 予定表 (Outlook), iCloud カレンダー, 日本の祝日, 誕生日.

**Todoist ↔ Outlook native sync is disabled** — due dates are Defer Dates, so
syncing would flood the calendar. Only `scheduled`-labeled tasks go on the
calendar.

### Device Detection for Calendar Operations

Before any calendar operation (create, update, delete):
- **If on iPhone**: use calendar tools directly.
- **If not on iPhone** (desktop/web): do NOT attempt calendar tool calls.
  Output event details (title, date/time, full address, notification timing)
  and instruct user to run from the iPhone Claude app.

### Notification Timing

- Nagoya area (train): 120 min before
- Toyota city (car): 30–60 min before
- Estimate travel time from home address.

---

## MCP Tools — Behavioral Notes

Tool schemas are injected automatically. These notes cover non-obvious behavior
only.

- `context` — call once at conversation start, zero args.
- `t_get_tasks` — section filter uses partial name match (Worker resolves
  internally). When asked "what should I do?", filter by `label:"next"` rather
  than fetching all tasks.
- `t_get_completed_tasks` — defaults to last 7 days, Inbox.
- `t_bulk` — use for 2+ changes. Do not mix update + delete on the same task
  in one call.
- `n_search` — returns only pages shared with the integration. Empty results
  mean "not shared," not "doesn't exist."
- `eval_date` — prefer expressions (`today`, `today+7d`, `today-30d`) over
  hardcoded dates at all times.
- Default output format: compact TSV. Switch to JSON only when asked or piping
  into another tool.
- Todoist 5xx → Worker auto-retries once. After error on `create`, check
  current state before retrying to avoid duplicates.

---

## /review (Weekly Review)

Execute these steps in order:

1. **Fetch all tasks** — use `context` output if already available from
   conversation start.

2. **Label audit** — cron runs daily so this is normally a no-op. Scan for
   anything the cron may have missed (e.g. tasks modified between runs):
   - `due > today` + `next` → remove `next`
   - `due ≤ today` + no `next` (non-sequential, no `waiting`/`scheduled`)
     → add `next`
   - `waiting` + `next` → keep `waiting` only
   Fix via `t_bulk` only if gaps are found.

3. **Completed task promotion** — `t_get_completed_tasks {}` (last 7 days).
   Webhook handles sequential renumbering in realtime; this step is a sanity
   check only. Fix via `t_bulk` only if gaps are found.

4. **Upcoming deferrals** — tasks with due dates within 2 weeks; surface for
   preparation.

5. **Calendar sync** — check `scheduled` tasks; register any unregistered ones
   in iCloud Calendar (device detection applies — see Calendar Integration).

6. **Next Actions summary** — list all `next`-labeled tasks and recommend this
   week's focus.

---

## Notion Lifelog System

### DB Pointers

| DB | ID |
|----|-----|
| 🗺️ State | `6492f29c6eee4437af8acb5be76b5654` |
| 📊 Metrics | `724d65c928b94a6d8d1ad8a7f685178f` |
| 📋 Events | `8282de48503247bc89481c507b4fec74` |
| 🍱 Food/Supplement Master | `6442450befed40dc94d3fed7a8411157` |

**Retired DBs (read-only, no new writes):**
- Old Lifelog: `94496a96-ad90-4944-904f-28c544265093`
- Old Body Comp: `40b3e7a7-b3e4-4386-be75-7dbcc4e155d5`

### Exercise Habits Page

Page ID: `3345c9c8-85a3-812c-906e-c0e1012fd69f` (in State DB)
Update via `n_update_page` with `replace_content` and `更新トリガー` property
logging reason + `最終更新日`.

### Routing (Trigger → DB)

| Trigger | State | Metrics | Events | Food Master |
|---------|-------|---------|--------|-------------|
| Habit/plan change | ✅ overwrite | — | ✅ append (種別: 習慣変更/食事変更/サプリ変更) | — |
| Numeric measurement (weight, BP, etc.) | — | ✅ append | — | — |
| Non-numeric event (visit, surgery, purchase) | — | — | ✅ append | — |
| New food/supplement registration | — | — | — | ✅ create/update |
| Calorie calculation | — | — | — | ✅ read only (no estimates) |

**Habit/plan changes MUST update both State AND Events. Never one without the
other.**

### Food Master Rules

- Food Master stores only nutrients and per-serving unit data.
- Intake timing, frequency, daily totals → State habits page (not Food Master).

### State DB Rules

- One row per domain, overwrite (history goes to Events).
- "What is my current …?" → read State directly.

### Metrics Rules

- Entry name: `YYYY-MM-DD_指標名`
- Value: NUMBER type (not string)
- One row = one metric

### Memory vs DB Responsibilities

| Store | Role |
|-------|------|
| Memory (memory_user_edits) | Current state summary, DB pointers (working memory) |
| State DB | Current state — source of truth |
| Metrics / Events / Food Master | Permanent records, history |

### Memory Update Policy

**Update memory when:**
- DB pointers or page IDs change
- Supplementary notes for items already in custom instructions
- Important state changes where auto-sync is delayed

**Do NOT write to memory:**
- Meal plans or numeric details (State DB is source of truth)
- Temporary measurements or events (Metrics/Events DBs)
- Anything that duplicates custom instructions
