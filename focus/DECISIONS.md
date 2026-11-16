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
  scheduled (~15 ms coalescing; originally 250 ms, which lost edits on an immediate reload) and is forced on `visibilitychange → hidden`,
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
- (−) A crash between a write and the save can lose at most the last few milliseconds
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

## ADR-012 — Voice capture: online disclosure by default, on-device as an explicit opt-in

**Status:** Accepted (2026-11-16)

Focus uses the Web Speech API. Chrome's default recogniser sends audio to an online service, so Focus explains that
before first use and remembers the user's agreement. The experimental on-device mode (`processLocally`,
`SpeechRecognition.available()/install()`, documented on MDN) is offered as an explicit choice rather than probed
automatically, because calling `available()` crashed the renderer in our Chromium test build. Before probing, Focus
force-saves the database so a browser crash cannot lose data. Native Android speech recognition will be assessed
with the Android build.

## ADR-013 — Secrets in the OS keychain; integration HTTP through Rust

**Status:** Accepted (2026-11-16)

API keys and webhook signing secrets go through a `SecretStore`: the OS credential store (keyring crate v4, v1 API —
Windows Credential Manager, macOS Keychain, Linux Secret Service) in the desktop app, and memory for the current
session only in the browser (browsers have no secure store; re-entering is the honest trade-off). Nothing secret is
written to SQLite (tested). Outbound HTTP for AI providers and webhooks goes through a Rust command (reqwest, rustls)
that only allows http/https GET/POST, so the webview CSP stays strict and local services work without CORS setup.
Mobile secure storage arrives with the mobile builds.

## ADR-014 — Adding tasks from assistants: links that pre-fill, never create

**Status:** Accepted (2026-11-16)

Focus has no server for a cloud assistant to call. Instead it registers the `focus:` URL scheme (tauri-plugin-deep-link
2.6.3; single-instance forwards links on Windows/Linux) and accepts Android text shares, converted to the same
`focus://capture` link in `MainActivity`. A link only pre-fills Quick Add or Capture: links can come from anyone, so
creation always needs a tap, text is sanitised and capped, and unknown actions are ignored. A direct connector for
Claude on the same computer comes with the Phase 4 local API.

## ADR-015 — External calendars through iCalendar (.ics), not provider sign-in

**Status:** Accepted (2026-11-16)

Google, Outlook and Apple all publish a private .ics address and export .ics files, so one read-only path covers
all three without OAuth apps, client secrets or cloud accounts, in keeping with local-first. Parsing uses ical.js
(MPL-2.0) for time zones (including Outlook's Windows zone definitions), repeat rules and exceptions. Occurrences
are expanded into `external_events` (two months back, a year ahead) and refreshed every 30 minutes; the address
is a secret and lives in the SecretStore. Export is a .ics file (floating local times) rather than writing into
external calendars. Live two-way sync would need each provider's API and sign-in; it is not planned.

## ADR-016 — Local API: the webview does the work, Rust only guards the door

**Status:** Accepted (2026-11-16)

The database lives in the webview (sql.js), so the desktop app's Rust side runs a small HTTP server (tiny_http)
that authenticates and forwards each request to the webview as an event and waits for the answer. The API thus
has exactly the same validation, events and undo-free safety as the UI. Off by default; 127.0.0.1 unless the user
opts into their network; bearer token (keychain, constant-time comparison); Host header checked against DNS
rebinding; any request with a browser Origin refused; 1 MB bodies; no delete endpoints; dependency warnings
return 409 and need `?force=true`. Not available on Android (the OS suspends background apps; the webview can't
serve requests reliably). The Claude connector is a dependency-free MCP stdio script calling this API.

## ADR-017 — Exports go through the platform

**Status:** Accepted (2026-11-16)

Browser-style downloads don't work in Android WebView and are unreliable in desktop webviews. `Platform.exportFile`
downloads in the browser, writes to the Downloads folder on desktop (safe, non-overwriting names) and opens the
Android share sheet (FileProvider) on Android.

## ADR-018 — Android secrets: Keystore-encrypted preferences via an in-app plugin

**Status:** Accepted (2026-11-16)

A small Tauri plugin in the app (`SecureStorePlugin.kt`) encrypts secrets with an AES-256-GCM key generated in the
Android Keystore; only IV and ciphertext are stored in private SharedPreferences. If the key is lost (restore to a
new phone), values read as missing and the user re-enters them. Avoids the deprecated androidx security-crypto
library and a third-party plugin.

## ADR-019 — Sync: end-to-end encrypted, row-level last-writer-wins, through the user's own relay

**Status:** Accepted (2026-11-16)

The user accepted a free cloud account provided everything is encrypted. A random 256-bit sync key never leaves
the devices; HKDF derives a vault id, a relay access token (stored hashed on the relay) and an AES-256-GCM data
key. Changes are captured by SQLite triggers into `sync_changes` with a per-row version (`time|device`) in
`sync_versions`; triggers are off until sync is enabled and while remote changes are applied, so nothing echoes.
A sync pulls encrypted batches (gzip, then AES-GCM with the vault id as AAD), applies rows whose version is newer
(upsert, never REPLACE, so foreign-key cascades can't fire), then pushes local changes in ≤700 KB batches.
Applied rows raise no domain events, so automations don't run twice; time-based automations run on one chosen
device. Rows that arrive before their parent wait for a later sync instead of blocking it.

Trade-offs: row-level last-writer-wins (not field-level merge) — two devices editing the same task offline keep
the later edit; device clocks matter. The relay keeps every batch (no compaction yet); a new device downloads the
whole history once. The relay is a single-file Cloudflare Worker with D1 that the user deploys in the dashboard.

## ADR-020 — Sync v2: field-level last-writer-wins with hybrid logical clocks

**Status:** Accepted (2026-11-16). Supersedes the merge rule in ADR-019.

Every field of a synced row carries the version of its last change (`sync_fields`); deletions carry their own
(`sync_tombstones`); a row exists if its newest field is newer than its deletion. Versions are hybrid logical clock
stamps `<ms>-<counter>-<device>` maintained in `sync_control`: local changes take max(wall clock, last seen) and
bump the counter on ties; received versions advance the clock. So two devices editing different fields both keep
their edits, and an edit made after seeing another device's change wins even if this device's clock is behind.
Triggers are generated from the column lists in `src/core/sync/tables.ts` (checked against the schema by a test);
a migration that adds a column to a synced table must regenerate them. v1 row versions are converted in place and
v1 items are still accepted.

## ADR-021 — A relay fit for a hosted service

**Status:** Accepted (2026-11-16)

The same single-file Worker can run as the publisher's hosted relay. Per-vault storage quota, per-IP and per-vault
rate limits and a cap on new vaults per IP are configurable variables. With `LICENCE_SECRET` set, creating a vault
needs an HMAC-signed licence (`id.expiry.signature`, minted offline), each licence can create a limited number of
vaults, and an expired licence pauses writes but keeps data readable. Clients can't be authenticated as "the real
app" (any client can be copied); quotas, limits and licences are the defence. Devices upload a snapshot once
history passes a threshold (only when nothing is unsent or waiting); a complete snapshot deletes the batches it
covers, and devices behind it load it first. Attachment files are stored encrypted in parts (blob id as AAD).

## ADR-022 — Android background sync through a Rust port of the engine

**Status:** Accepted (2026-11-16)

The TypeScript engine runs inside the WebView, which Android doesn't keep alive. A Rust port (`bgsync.rs`,
rusqlite with bundled SQLite) runs from a WorkManager job every ~15 minutes with a network: it syncs a copy of the
database file and replaces the original atomically only if the app wasn't opened meanwhile (MainActivity flags
itself to Rust over JNI). Compaction and files are left to the foreground app. Two engines risk drifting, so they
share test vectors generated by the TypeScript engine: key derivation, envelopes in both directions, and a merge
whose result must match exactly; plus an end-to-end run of both engines through the real relay over HTTP.
