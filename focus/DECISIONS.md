# Architecture Decision Records

Each record states the context, the decision, and its consequences. Records are
append-only; a superseded decision is marked as such rather than deleted.

---

## ADR-001 — Location of the Focus project inside this repository

**Status:** Accepted (2026-11-14)

**Context.** The repository `la-calc` already contains a live, unrelated clinical
PWA (LASTCalc) at its root, served from `app.periopdigital.uk`, with
`.well-known/assetlinks.json` used for Play Store verification. The specification
forbids blindly overwriting existing files.

**Decision.** Focus lives entirely inside `focus/`. Nothing at the repository
root is modified. Focus has its own `package.json`, documentation, tests and
build output (`focus/dist`).

**Consequences.** The existing deployment is unaffected. If Focus is later moved
to its own repository, `focus/` can be extracted with `git subtree split`
without rewriting history.

---

## ADR-002 — Application stack

**Status:** Accepted

| Concern | Choice | Version pinned |
|---|---|---|
| UI | React | 19.3.1 |
| Language | TypeScript (strict) | 6.0.3 |
| Build | Vite | 8.3.5 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) | 4.3.5 |
| State | Zustand | 5.1.0 |
| Validation | Zod | 4.6.7 |
| Dates | date-fns | 4.4.0 |
| Icons | lucide-react | 1.73.0 |
| Database engine | SQLite via sql.js (WASM) | 1.16.0 (SQLite 3.54.1) |
| Unit/integration tests | Vitest | 5.1.0 |
| E2E tests | Playwright | 1.63.0 (matches the pre-installed browser) |
| Native shell | Tauri 2 (desktop + Android + iOS) | 2.12.x — Phase 5 |

**Notes on version choice.**
- TypeScript 7.0 (the native Go compiler) is the current `latest` tag, but
  `typescript-eslint` 8.72 only supports `>=4.8.4 <6.1.0`. TypeScript 6.0.3 is
  therefore pinned until the lint toolchain supports 7.x.
- Vite 8.3.8 was published three days before this decision; 8.3.5 (three weeks
  old) is pinned instead.
- **shadcn/ui is not used.** It is a code generator for Radix primitives, and
  adding Radix + class-variance-authority + tailwind-merge for the small set of
  primitives Phase 1 needs (button, dialog, menu, popover, toast) costs more
  than it saves. Focus ships its own accessible primitives in `src/ui/primitives`
  built on native elements (`<dialog>`, `<button>`, `<input>`), which also
  behave correctly inside Android/iOS webviews. This can be revisited if the
  primitive set grows large.
- **FullCalendar is deferred** to Phase 2 and will be re-assessed then. Its
  premium (paid) licence is required for resource/timeline views; the views the
  spec requires (day, 3-day, week, month, agenda) are in the MIT core, but its
  touch drag-and-drop on Android webviews needs verification before adoption.
  Phase 1 ships a lightweight month grid built in-house.

---

## ADR-003 — One SQLite engine on every platform (sql.js), platform-specific persistence

**Status:** Accepted

**Context.** The spec asks for SQLite natively and IndexedDB in the browser, with
**no duplicated business logic**. Two engines (SQLite natively, IndexedDB object
stores in the browser) would mean two query implementations for every
repository method, two migration systems, and divergent behaviour — exactly the
duplication the spec forbids.

The obvious native option, `@tauri-apps/plugin-sql`, runs SQL through `sqlx`
with a connection pool behind an async IPC bridge. `BEGIN … COMMIT` issued as
separate `execute` calls is not guaranteed to run on the same pooled
connection, so multi-statement transactions from the frontend are unreliable.
That conflicts with the spec's requirement for transactional related changes.

**Decision.**
1. **The database engine is SQLite compiled to WebAssembly (sql.js) on every
   platform.** The repository layer, migrations, FTS search index and all SQL
   are written once and are identical everywhere.
2. **Persistence is a platform adapter** (`src/platform/persistence`) that stores
   the SQLite database file:
   - Browser/PWA: the database image in **IndexedDB** (satisfies the spec's
     IndexedDB requirement while keeping a single engine).
   - Tauri (Windows/macOS/Android/iOS): a real `.sqlite` file in the app-data
     directory, written atomically (write temp → fsync → rename) through a
     small Rust command. Phase 5.
   - Tests: in-memory.
3. The driver interface (`src/data/db/driver.ts`) is synchronous. Because the
   whole database is in memory, reads are sub-millisecond and the UI can query
   synchronously without loading spinners for local data.

**Durability rules.**
- Every committed write transaction marks the database dirty; a flush is
  scheduled (250 ms debounce) and is forced on `visibilitychange → hidden`,
  `pagehide` and app-lifecycle pause events (Android backgrounding).
- Two rotating snapshots are kept (`current`, `previous`). On start-up the
  current snapshot is integrity-checked (`PRAGMA integrity_check`); if it fails
  the previous snapshot is offered for recovery. The user is told — data is
  never silently replaced.
- A Web Lock (`navigator.locks`) ensures only one browser tab owns the database.
  A second tab shows an explanatory screen instead of overwriting the first
  tab's data.
- `db.export()` in sql.js closes and re-opens the database, which resets
  pragmas; the driver re-applies `PRAGMA foreign_keys = ON` after every export.

**Consequences.**
- (+) One schema, one migration path, one test suite against the real engine.
- (+) True multi-statement transactions with rollback, foreign keys, FTS4, JSON1.
- (−) The whole database is held in memory. At 50,000 tasks this is roughly
  20–40 MB, acceptable on a Pixel and on desktop. Revisit if users exceed that.
- (−) A crash between a write and the debounced flush can lose at most ~250 ms
  of changes. Mitigated by lifecycle-triggered flushes.
- **Upgrade path:** if memory or durability becomes a problem, the driver can be
  replaced by (a) `wa-sqlite` with an OPFS/IndexedDB page-level VFS in the
  browser, or (b) a Rust `rusqlite` command layer in Tauri that executes whole
  transactions natively. The repository layer does not change in either case.

---

## ADR-004 — Data conventions

**Status:** Accepted

- **Identifiers:** UUID v4 strings (`crypto.randomUUID`) for every entity, to
  allow future multi-device synchronisation without ID collisions.
- **Timestamps** (created, updated, completed, deleted, activity) are stored as
  UTC ISO-8601 strings (`2026-11-14T20:17:00.000Z`) and converted to local time
  for display.
- **Calendar dates** (start date, scheduled date, deadline) are stored as
  floating local calendar dates `YYYY-MM-DD`, and scheduled time as local
  `HH:mm`. A task scheduled for "Friday" must stay on Friday when the user
  travels across time zones; converting it to a UTC instant would move it. This
  is the same convention used by iCalendar `VALUE=DATE`.
- **Soft deletion:** user-facing entities have `deleted_at`. Deleted items go to
  Trash and can be restored; purging Trash is an explicit user action.
- **Change tracking:** every insert/update/delete writes a row to `change_log`
  (entity, id, operation, timestamp, device id). This is the foundation for
  incremental sync (Phase 5+). It is not yet consumed.
- **Activity history:** user-meaningful task events (created, completed,
  rescheduled, moved, …) go to `activity_log` with a JSON payload, shown in the
  task detail panel and used later by Insights.
- **Priorities:** stored as integers 1–4 where **1 is highest (P1)**, matching
  user-visible labels.

---

## ADR-005 — Recurrence model: completed instances are kept, next instance created once

**Status:** Accepted

**Context.** Two common models exist: (a) a single task whose date rolls forward
on completion, or (b) each occurrence is its own task. Model (a) loses history
and makes reporting ("recurring task completion") inaccurate.

**Decision.** Recurring tasks belong to a *series* (`series_id`). Completing an
occurrence keeps that row as a completed record and creates the next occurrence
as a new task in the same series, copying title, description, labels, priority,
project, section, duration, reminders (re-based) and open subtask structure.

- **Duplicate prevention:** before creating a next occurrence the service checks
  for an open task in the same series; if one exists, nothing is created. The
  check and insert run in one transaction.
- **Basis:** `scheduled` (next date follows the pattern from the series anchor)
  or `completion` (next date counts from the completion day).
- **Overdue handling (scheduled basis):** the next occurrence is the first date
  in the pattern strictly after `max(scheduled date, today)`. Completing a daily
  task that is five days overdue schedules it for tomorrow, not for four more
  overdue days. Interval alignment is preserved because occurrences are
  generated from the series anchor, so "every 2 weeks on Tuesday" stays on the
  same fortnightly cycle.
- **Rules are structured JSON with a version field** (`{ "v": 1, ... }`), stored
  in `recurrence_rules`, never as free text. The original natural-language text
  is kept alongside for display only.
- Undoing a completion reopens the occurrence and soft-deletes the generated
  next occurrence if it has not been modified.

---

## ADR-006 — Deterministic, local natural-language parsing

**Status:** Accepted

Quick Add uses an in-house deterministic parser (`src/core/nlp`), not a cloud
service or an LLM, so it is instant and offline. `chrono-node` was considered,
but it does not parse priorities, projects, labels, durations or recurrence,
and its date output would still need UK-specific post-processing. The in-house
parser:
- returns recognised **token spans** so the input can highlight them and the user
  can tap a highlighted token to un-recognise it (manual correction);
- returns **ambiguities with alternatives** (e.g. "every second Tuesday" =
  fortnightly *or* the 2nd Tuesday of each month);
- defaults to UK conventions (DD/MM/YYYY, 24-hour time, Monday week start), with
  the locale configurable in Settings.

---

## ADR-007 — Routing and navigation

**Status:** Accepted

A small hash router (`#/today`, `#/project/<id>`, `#/task/<id>`) is used instead
of React Router. Hash URLs work identically from a web server, a `file://`
origin and Tauri's custom protocol, and each navigation is a real history entry,
so Android's system back gesture works without extra native code. Open dialogs
and the task-detail sheet push history entries, so "back" closes them first.

---

## ADR-008 — Native shell: Tauri 2 first, Capacitor as the fallback

**Status:** Accepted (re-assess at Phase 2 for notifications, Phase 5 for release)

Tauri 2 targets Windows, macOS, Linux, Android and iOS from one project and keeps
installers small. Its official plugins needed by Focus — `notification`, `fs`,
`dialog`, `deep-link`, `stronghold`/OS keychain — must each be checked for
**Android support of the specific feature** (e.g. scheduled notifications with
action buttons) before relying on them. If Android notification scheduling or
share-sheet intents prove inadequate, Capacitor 8 (`@capacitor/local-notifications`,
mature Android support) becomes the Android/iOS wrapper while Tauri remains the
desktop wrapper. Because all business logic is in the shared TypeScript core and
platform code sits behind `src/platform` interfaces, that switch would only
touch adapters.

**Environment limitation (2026-11-14).** The development container has Rust 1.97
but no Android SDK/NDK and no WebKitGTK, and cannot build Windows binaries.
Native builds are therefore *not* produced or claimed in this session; see
PLATFORM_SUPPORT.md.

---

## ADR-009 — Native storage via custom Tauri commands with raw binary IPC

**Status:** Accepted (2026-11-16)

**Decision.** The Tauri shell exposes a small set of Focus-specific commands (`db_load`, `db_save`,
`db_snapshot`, `file_put/get/delete/keys`) implemented in `src-tauri/src/storage.rs`, rather than granting the
webview the general `fs` plugin. Bytes travel as raw IPC bodies (`tauri::ipc::Request`/`Response`), not JSON arrays,
so a 20 MB database saves in one copy.

**Why.** (1) Least privilege: the webview can only touch Focus's own data folder, and every name is validated
against path traversal. (2) Atomic writes and rotation live in one audited place. (3) Avoids JSON-encoding large
byte arrays.

**Verified.** Linux/WebKitGTK build: create task → kill process → relaunch → task present (session 2).

---

## ADR-010 — Reminder delivery model

**Status:** Accepted (2026-11-16)

Reminders are computed from stored data (`src/core/reminders.ts`) and delivered by a scheduler that runs while
Focus is running (`src/app/reminder-scheduler.ts`): it wakes exactly at the next due time (and at least every
minute), marks each reminder delivered *before* showing it (so it never fires twice), and shows it in-app with
Complete / Snooze / Dismiss. System notifications are an optional extra via the platform `NotificationAdapter`
(web Notification API with service-worker actions; Tauri notification plugin on desktop). Reminders that came due
while the app was closed are shown together on the next launch, not as a burst.

**Limitation (honest):** neither a browser tab nor the desktop app can fire reminders while fully closed. True
background delivery needs OS scheduling (Android `AlarmManager` via a native plugin) and will be built and tested
with the Android app. A desktop tray mode (Phase 5) will keep the desktop app running when its window is closed.

## ADR-011 — Calendar built in-house instead of FullCalendar

**Status:** Accepted (2026-11-16) — supersedes the deferral in ADR-002

The time grid, month and agenda views are built in-house (~600 lines plus a tested layout helper). FullCalendar's
drag/resize uses its own event system, which would need adapters for Focus's undo, confirmation (dependency) and
deadline semantics, and its touch interaction on Android webviews is unverified. The in-house grid uses pointer
events with press-and-hold on touch, snaps to 15 minutes, and goes through the same services as every other edit.
