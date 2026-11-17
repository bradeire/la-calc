# Focus — Feature Status

Status levels (spec §11.7): **Not started** · **In progress** · **Implemented** (code exists, works manually) ·
**Tested** (automated tests pass) · **Verified on device** (physical hardware).

"Browser" below means headless Chromium via Playwright at desktop size and at Pixel 7 emulated size.
**No feature has been verified on a physical device yet.** A native Tauri build exists and has been verified on Linux
(WebKitGTK); Windows and Android builds must be produced on those platforms (see PLATFORM_SUPPORT.md).

_Last updated: 2026-11-16 (session 5 — Phase 4)._

## Phase 1 — Core application

| Feature | Status | Evidence / notes |
|---|---|---|
| SQLite persistence (sql.js + IndexedDB), migrations, integrity check | Tested | `tests/database.test.ts`; reload test in `e2e/core.spec.ts` |
| Pre-migration snapshot, corrupt-DB detection and recovery | Tested | boot tests; nothing is discarded without user choice |
| Single-tab lock (no cross-tab overwrites) | Tested (logic) | Web Locks API; verified via adapter test, not multi-tab E2E |
| Task CRUD, all spec fields, statuses | Tested | `tests/task-service.test.ts` |
| Duplicate, move, soft delete → Trash, restore, purge | Tested | |
| Undo for complete / delete / move / bulk actions | Tested | service tests + E2E undo test |
| Nested subtasks (any depth), collapse, progress, move, promote | Tested | |
| Optional auto-complete of parent (off by default) | Tested | |
| Quick Add with NLP (dates, times, recurrence, priority, project, labels, deadline, duration, start) | Tested | 73 parser tests + E2E |
| Quick Add token highlighting, tap-to-unrecognise, ambiguity choices, manual overrides | Tested | E2E |
| Projects: nested, colour, icon, description, notes, favourites, archive, progress | Tested | |
| Project sections (add, rename, reorder, delete keeping tasks) | Tested | |
| Project layouts: List, Board, Table, Calendar (month) | Implemented | Board/Table covered by E2E; per-project default layout persisted |
| Project notes and attachments | Tested | E2E: add file, reload, still present |
| Labels: CRUD, colours, unique names, Quick Add creation, label view | Tested | |
| Sort and group per view (manual, deadline, scheduled, added, project, name, priority; group by project, label, priority, deadline, scheduled, status), saved per view on this device | Tested | 7 unit tests + E2E (desktop and Pixel 7 emulation) |
| Quick deadline changes: tap the deadline, task menu, swipe, selected tasks, Overdue → Move to today / Reschedule… | Tested | E2E; swipe not tested on hardware |
| Inbox, Today, Upcoming, Search, Trash views | Tested | |
| Full-text search (FTS4: titles, descriptions, comments, project & label names) | Tested | prefix + accent-insensitive |
| Focus mode with start/stop timer and next task | Implemented | timer logic Tested |
| Recurring tasks (daily…yearly, intervals, weekdays, month days, nth weekday, scheduled/completion basis) | Tested | 21 engine tests + service + E2E |
| Comments | Tested | |
| Attachments (stored locally, executables blocked, 50 MB cap) | Tested | |
| Activity history | Tested | |
| Reminder configuration (absolute & relative) | Tested | delivery: see Phase 2 below |
| Time tracking: timer, manual entry, corrections | Tested | reports are Phase 4 |
| Bulk select & bulk actions (desktop: Ctrl/Shift-click, X key) | Implemented | |
| Drag & drop: reorder, move to section/project, reschedule on Upcoming/Calendar | Implemented | desktop mouse only; touch uses menus/swipe |
| Swipe actions on touch (right = complete, left = schedule) | Implemented | not yet tested on hardware |
| Keyboard shortcuts | Implemented | `?` lists them |
| Settings: theme, accent, text size, reduced motion, date format, 12/24h, week start, working hours | Implemented | |
| Onboarding: empty / demo data / import; preferences | Tested | |
| Sample data load and safe removal (user tasks rescued) | Tested | |
| JSON backup (incl. attachments) and SQLite export, verified restore | Tested | full backup suite → Phase 4 |
| PWA: manifest, icons, offline service worker | Tested | E2E offline reload (found and fixed a cache-matching bug) |
| Responsive mobile + desktop layouts, dark mode | Implemented | screenshots reviewed at 1440×900 and Pixel 7 |
| Accessibility (WCAG 2.1 AA automated audit) | Tested | axe-core on 9 screens + task detail, light & dark, desktop & Pixel; manual screen-reader test not yet done |
| Large lists (virtualised over 150 rows) | Tested | 5,000-task Inbox: 0.2 s render; 20,000-task query benchmarks |
| Native shell (Tauri 2): atomic file storage, single instance, flush on close | Tested (Linux) | Rust unit tests + native persistence round trip under Xvfb |

## Phase 2 — Advanced planning

| Feature | Status | Evidence / notes |
|---|---|---|
| Calendar: day, 3-day, week (time grid), month, agenda | Tested | E2E: click slot to add, drag to move, drag edge to resize |
| Calendar: deadlines shown separately, projected repeats, overdue highlight, working-hours shading, now line | Implemented | reviewed in screenshots |
| Calendar: filter by project (incl. sub-projects) and label | Implemented | |
| Calendar drag on touch (press and hold) | Implemented | not yet tested on hardware |
| Start date / scheduled / deadline independence | Tested | start-date chip; Today hides not-yet-started pinned tasks |
| Workload: capacity from working hours, per-day load bars, default estimate setting | Tested | engine tests + UI |
| Conflict detection: overload, overlaps, after deadline, before start, dependency order, deadlines at risk, overdue | Tested | 12 engine tests |
| Suggested rescheduling with Accept / Reject / Accept all (undoable) | Tested | E2E + service test; never moves fixed-time tasks |
| Dependencies: multiple, cycle and self-link prevention, blocked badges, "waiting on / blocks" in details | Tested | |
| Dependency enforcement: confirm before completing a blocked task or scheduling out of order | Tested | E2E "Complete anyway" |
| Dependency visualisation | Implemented (lists) | chain shown in task details and badges; a graph view is not built |
| Filter engine: AND/OR/NOT, nesting, labels, dates & ranges, priority, status, project, duration, deadline, dependencies, text | Tested | all 7 spec example filters |
| Visual filter builder + advanced query language, kept in sync | Tested | E2E |
| Saved filters, pinned to sidebar | Tested | |
| Reminders delivered in-app (Complete / Snooze / Dismiss), exactly once, re-armed on reschedule | Tested | E2E with controlled clock |
| System notifications: web (with Complete/Snooze actions via service worker), desktop (Tauri plugin) | Implemented | desktop notification path compiled, not exercised on hardware |
| Missed reminders summarised on next launch | Tested (logic) | |
| Reminders while the app is fully closed | Not started | needs Android native scheduling (see PLATFORM_SUPPORT.md) |
| Project templates: save project as template, create from template, relative dates, subtasks, labels, dependencies | Tested | built-in "Holiday planning" |

## Phase 3 — Intelligence and automation

| Feature | Status | Evidence / notes |
|---|---|---|
| Offline NLP with configurable date order, 12/24 h, week start (UK default) | Tested | Phase 1 parser + settings |
| Voice capture in Quick Add (Web Speech API), dictated text parsed like typing | Tested (browser, simulated recogniser) | real microphone not tested; see ADR-012 |
| Online-recognition disclosure; on-device recognition opt-in (experimental) | Implemented | probe crashes headless Chromium → opt-in, data saved first |
| AI provider interface: Ollama, OpenAI-compatible; off by default | Tested | fake provider in unit + E2E tests |
| AI consent tied to address; "what will be sent" preview; descriptions opt-in; keys in OS keychain / session only | Tested | |
| AI features: subtasks, priority/project/labels/estimate/description, project summary, filter from words, template draft, plan review, capture | Tested (unit) / Implemented (UI) | breakdown flow E2E-tested |
| Automation engine: 12 triggers, filter-tree conditions, 14 actions | Tested | 13 tests |
| Automations: enable/disable, history with errors, duplicate prevention, hourly limit, loop prevention (depth 3), test mode | Tested | |
| Example automations (overdue → notify, waiting > 3 days → follow-up, project done → archive, project created → template, deadline tomorrow) | Tested | the "next recurring instance" example is built into recurrence |
| Webhooks: configurable, HMAC-SHA256 signed, minimal payload, test button; secrets never in the database | Tested | E2E with intercepted receiver |
| Home Assistant: outgoing webhooks documented with YAML | Implemented | inbound (HA → Focus) needs the Phase 4 local API |
| Capture from pasted email / notes / .txt .md .eml .html; suggestions confirmed before creation | Tested | PDF/Word not supported |
| Android share-sheet target (installed PWA) | Implemented | not tested on hardware |
| Tap-to-add links `focus://add` / `focus://capture` (pre-fill only, confirm to create); Settings instructions for Claude, through the relay's `/open` page when sync is set up | Tested (browser flow, parser, relay page in Chromium) | Claude's app doesn't make `focus://` tappable (seen on the Pixel); the relay-page route is not yet tried on hardware |
| Android "Share → Focus" for text (Claude, Gmail, Outlook, Teams…) opens Capture | Implemented | in APK manifest; not tried on hardware |
| Native HTTP and keychain commands (Tauri) | Tested (Rust unit tests, compiled) | keychain not exercised on Windows/macOS hardware |

## Phase 4 — Productivity and integrations

| Feature | Status | Evidence / notes |
|---|---|---|
| Insights: created vs completed (day/week/month), by project, by label, priority distribution, due dates met/missed, workload, recurring completion vs pattern, project progress | Tested | from stored timestamps only; definitions shown on each card |
| Date ranges (presets and custom); charts with table view; configurable widgets (show/hide, order, width) | Tested | E2E; axe audit |
| Dashboard widgets: today, overdue, deadlines, waiting, recent, quick capture, stats | Tested | |
| Time: totals by day/week/project/task, estimate vs actual, time log with correction/deletion | Tested | |
| Running timer not counted as worked time; prompt after 4 h with "stop at" an earlier time | Tested | E2E with controlled clock |
| Goals: daily/weekly task and time targets, streaks (non-working days optional), 12-week history | Tested | no points or badges |
| External calendars: Google/Outlook/Apple by private .ics address, or .ics file; read-only display in all calendar views | Tested | time zones, repeats, moved/cancelled occurrences |
| Calendar events reduce available time; tasks scheduled over an event flagged; shown/hidden per calendar | Tested | |
| Export scheduled tasks (all or a project) as .ics | Tested | re-import round trip |
| Calendar addresses, API token, AI keys, webhook secrets in secure storage (desktop keychain; Android Keystore) | Tested (desktop, Linux keyring) / Implemented (Android) | Android plugin compiled, not run on hardware |
| CSV export (all fields) and import (Focus, spreadsheets, Todoist project CSV) with preview, duplicate skip, undo | Tested | imports don't trigger automations |
| Project export/import and single-task export (JSON) | Tested | |
| Full backup with attachments, SQLite copy, verification, restore | Tested | Phase 1–2; now saved via platform export |
| Native exports: Downloads folder (desktop), share sheet (Android) | Tested (Rust) / Implemented (Android) | |
| Local API (desktop): tasks, projects, labels, approved automations; token, localhost by default, no deletion | Tested | real Linux app under Xvfb |
| Claude connector (MCP) for Claude Desktop / Claude Code | Tested | against a stand-in API and against the real app; not yet with Claude Desktop itself |

## Sync (post-Phase 4, requested early)

| Feature | Status | Evidence / notes |
|---|---|---|
| End-to-end encrypted sync via a relay (Cloudflare Worker + D1): yours, or a hosted one in release builds | Tested | two app instances; two browser profiles in E2E; relay also run in workerd |
| Field-level merge with hybrid logical clocks (different-field edits both survive; skewed clocks can't win later) | Tested | fast-clock test confirms the stored clock really was ahead |
| Deletes, Trash purges, edit-after-delete, same-named labels, duplicate repeat rules | Tested | |
| Joining merges both devices' existing data; works after compaction | Tested | compaction bug found and fixed |
| Compaction via snapshots; late joiners load the snapshot | Tested | |
| Attachment files sync encrypted (per-run budget) | Tested | |
| Relay: quotas + usage, rate limits, new-vault limits, licences with expiry, upgrade in place | Tested | |
| Recovery sheet; set-up requires confirming the key is saved | Tested (browser) | |
| Android background sync (WorkManager + Rust engine) | Tested (engine) / Implemented (Android) | Rust engine matches TS on shared vectors and in a cross-engine run; the Android job is compiled into the APK but not run on a phone yet |
| Set-up: key, QR, focus://sync link; licence field; default hosted relay per build | Tested (browser) | QR scanning by a phone camera not verified |
| Not synced: external calendars, webhooks, AI settings, theme/layout, local API | — | per-device secrets |

## Not yet started (later phases)

Android/Windows release builds verified on hardware, background reminders on Android, touch drag-and-drop,
iOS secure storage (Phase 5).

**Navigation note:** Insights is in the sidebar (desktop) and the More menu (phone).
