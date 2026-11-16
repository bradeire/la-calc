# Focus — Testing

```bash
npm run typecheck   # TypeScript strict
npm run lint        # ESLint
npm test            # Vitest: unit + integration against the real SQLite engine
npm run e2e         # Playwright: builds, serves on :4174, runs desktop + Pixel 7 projects
npm run check       # typecheck + lint + test + build
```

## What is covered

| Suite | Files | Count (2026-11-16) |
|---|---|---|
| Recurrence engine | `src/core/recurrence/engine.test.ts` | 21 |
| NLP parser | `src/core/nlp/parser.test.ts` | 73 |
| Filters engine + query language | `src/core/filters/filters.test.ts` | 18 |
| Scheduling engine | `src/core/scheduling.test.ts` | 12 |
| Calendar layout | `src/core/calendar-layout.test.ts` | 3 |
| Capture extraction | `src/core/capture.test.ts` | 7 |
| Tap-to-add links | `src/core/links.test.ts` | 6 |
| Reports (completion, due dates, recurring, time) | `src/core/insights.test.ts` | 8 |
| Goals and streaks | `src/core/goals.test.ts` | 3 |
| iCalendar import/export, busy time | `src/core/ics.test.ts` | 7 |
| Database, migrations, boot, recovery | `tests/database.test.ts` | 12 |
| Task service (lifecycle, subtasks, recurrence, views, time) | `tests/task-service.test.ts` | 22 |
| Projects, labels, sample data, backup/restore | `tests/data-service.test.ts` | 12 |
| Performance (20,000 tasks; blocked lookup at 5,000) | `tests/performance.test.ts` | 2 |
| Dependencies, reminders, templates, saved filters, scheduler, planning | `tests/phase2.test.ts` | 14 |
| Automation engine and webhooks | `tests/automation.test.ts` | 13 |
| AI service (fake provider) and capture service | `tests/ai-capture.test.ts` | 12 |
| Insights service, time corrections, long-timer check | `tests/insights.test.ts` | 3 |
| External calendars (subscribe, busy time, clashes, export) | `tests/calendars.test.ts` | 4 |
| CSV / Todoist / project-file import and export | `tests/transfer.test.ts` | 7 |
| Local API request handling | `tests/api.test.ts` | 5 |
| Claude connector (MCP) as a real subprocess | `tests/mcp.test.ts` | 2 |
| Sync: crypto, two devices, field merge, clocks, compaction, files, licences | `tests/sync.test.ts` | 18 |
| Relay worker: auth, quota, rate limits, licences, snapshots, files, upgrade | `tests/relay.test.ts` | 8 |
| Shared vectors TS ↔ Rust (keys, envelopes, exact merge result) | `tests/sync-vectors.test.ts` | 1 |
| Rust background engine with TS devices through the relay over HTTP (opt-in: `BGSYNC_E2E=1`) | `tests/bgsync-e2e.test.ts` | 1 (skipped by default) |
| **Total Vitest** | | **294 passing**, 1 opt-in |
| Rust: storage, secrets, HTTP, exports, local API, background sync engine (shared vectors) | `src-tauri/src/*.rs` | 13 (+1 driven by the opt-in E2E) |
| End-to-end (desktop + Pixel 7 emulation) | `e2e/core.spec.ts` | 26 (13 × 2) |
| Offline reload, accessibility audit (incl. Insights, Time log) | `e2e/quality.spec.ts` | 3 |
| 5,000-task rendering | `e2e/performance.spec.ts` | 1 |
| Phase 2 | `e2e/phase2.spec.ts` | 11 |
| Phase 3 | `e2e/phase3.spec.ts` | 16 |
| Phase 4: insights, goals, customise, time log, long timer, calendars, CSV/Todoist import | `e2e/phase4.spec.ts` | 14 (7 × 2) |
| Sync: desktop + phone browser profiles through the relay | `e2e/sync.spec.ts` | 1 (runs once) |
| **Total Playwright** | | **70 passing**, 4 skipped (desktop-only tests on Pixel) |

**Relay in Cloudflare's runtime:** `worker.js` was also run with `wrangler dev --local` (workerd + local D1):
upload, paging, wrong-token refusal and CORS preflight behaved as in the tests.

**Native check (Linux desktop app under Xvfb, with a Secret Service keyring):** local API refuses requests
without the token or from a web page; creates and filters tasks; the Claude connector adds a task through it;
the task is in the SQLite file after the app exits. Script: run the debug build in `dbus-run-session` with
`gnome-keyring-daemon`, then curl `http://127.0.0.1:47615/v1/…`.

Integration tests run on sql.js in Node, i.e. the same SQLite engine the app ships, not a mock.
The in-memory platform (`src/platform/memory.ts`) is used only in tests.

## Notable regressions caught by tests

- Zod 4's `.partial()` applies `.default()` values, which made every partial update reset other fields
  (e.g. clearing a deadline when changing the date). Patch schemas are now built from default-free fields.
- Undoing a move did not move subtasks back (`??` treated `null` as "unchanged").
- `DROP TABLE` with foreign keys enabled fires delete triggers; the down-migration now drops triggers first.
- Quick Add measured its textarea before the native dialog opened (height 0).
- Menus opened from Quick Add rendered behind the modal dialog (browser top layer); popovers now render inside an open dialog.
- Every task insert scanned all top-level tasks (missing index) — 5.5× faster after migration 002.
- 5,000-row lists took 4.8 s to render — now virtualised (0.2 s).
- The installed PWA did not work offline: cached modules never matched because of `Vary: Origin`.
- "Add file" did nothing while the attachments section was collapsed.
- A new database was not written to storage until the first edit, so migrations repeated on every launch.
- Snoozing a reminder left it on screen (void return treated as failure); manual time "Log" never cleared.
- "Waiting on…" picker did nothing while its section was collapsed; it suggested nothing for Inbox tasks.
- The blocked-task lookup took 1.4 s for 5,000 tasks (huge SQL IN list) — now ~1 ms.
- Weekend tasks were reported as "overload" and moved to Monday.
- **Edits were lost on an immediate reload**: the 250 ms save debounce left a window in which reloading or closing
  the page dropped changes. Saves now follow each change within ~15 ms; a regression test reloads straight after
  an edit.
- Chromium's experimental `SpeechRecognition.available()` crashed the page; the on-device probe is now opt-in and
  data is saved before it runs (ADR-012).
- Settings form would have wiped AI consent on save; automations test clock mismatch.
- Exports did nothing in the native apps (Android WebView ignores browser downloads): exports now go through the
  platform (Downloads folder on desktop, share sheet on Android).
- The Claude connector exited before finishing a call when its input closed (found in the native run).
- Sync v2 found: joining after compaction failed; the relay returned one batch per page without `limit`; the
  Rust engine wrote whole-number REALs as `1.0` (JavaScript writes `1`).
- Sync review found: enabling sync checked the relay before its address was saved; a first device with no data
  left nothing for the second to join; the relay cached its schema across databases.
- "Edit survives an immediate reload" became flaky (2 in 12) as the app grew; the browser now keeps a synchronous
  unload-time copy for the reload (30/30 afterwards).
- Workload counted weekend capacity as "Available" bars that hid planned work (chart redesigned after review).

## Manual checks per release

1. Fresh install → onboarding → demo data; check Today/Upcoming/Calendar.
2. Create tasks via Quick Add with dates, `#project`, `@label`, `p1`, recurrence; tap a token to un-parse.
3. Complete a recurring task; confirm exactly one next occurrence; undo.
4. Reload; confirm data persists. Go offline (DevTools) and reload the installed PWA.
5. Export JSON + SQLite backup; restore into a fresh profile.
6. Dark mode, 130 % text size, reduced motion, keyboard-only navigation.

## Native checks (Linux, under Xvfb)

```bash
cd src-tauri && cargo test          # storage unit tests
npx tauri build --debug --no-bundle # then launch, add a task, kill, relaunch: task must persist
```

## Not yet tested

Physical devices (any), Windows and Android native builds, multi-tab lock in a real browser,
manual screen-reader testing (TalkBack/NVDA/VoiceOver).
