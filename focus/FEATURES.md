# Focus — Feature Status

Status levels (spec §11.7): **Not started** · **In progress** · **Implemented** (code exists, works manually) ·
**Tested** (automated tests pass) · **Verified on device** (physical hardware).

"Browser" below means headless Chromium via Playwright at desktop size and at Pixel 7 emulated size.
**No feature has been verified on a physical device yet. No native (Tauri) build exists yet.**

_Last updated: 2026-11-14 (session 1)._

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
| Project attachments | Not started | Schema + service support exist; no UI yet |
| Project templates | Not started | Phase 2 (table exists) |
| Labels: CRUD, colours, unique names, Quick Add creation, label view | Tested | |
| Inbox, Today, Upcoming, Search, Trash views | Tested | |
| Full-text search (FTS4: titles, descriptions, comments, project & label names) | Tested | prefix + accent-insensitive |
| Focus mode with start/stop timer and next task | Implemented | timer logic Tested |
| Recurring tasks (daily…yearly, intervals, weekdays, month days, nth weekday, scheduled/completion basis) | Tested | 21 engine tests + service + E2E |
| Comments | Tested | |
| Attachments (stored locally, executables blocked, 50 MB cap) | Tested | |
| Activity history | Tested | |
| Reminder configuration (absolute & relative) | Implemented | **Stored only — notifications are not delivered yet (Phase 2)** |
| Time tracking: timer, manual entry, corrections | Tested | reports are Phase 4 |
| Bulk select & bulk actions (desktop: Ctrl/Shift-click, X key) | Implemented | |
| Drag & drop: reorder, move to section/project, reschedule on Upcoming/Calendar | Implemented | desktop mouse only; touch uses menus/swipe |
| Swipe actions on touch (right = complete, left = schedule) | Implemented | not yet tested on hardware |
| Keyboard shortcuts | Implemented | `?` lists them |
| Settings: theme, accent, text size, reduced motion, date format, 12/24h, week start, working hours | Implemented | |
| Onboarding: empty / demo data / import; preferences | Tested | |
| Sample data load and safe removal (user tasks rescued) | Tested | |
| JSON backup (incl. attachments) and SQLite export, verified restore | Tested | full backup suite → Phase 4 |
| PWA: manifest, icons, offline service worker | Implemented | build verified; offline reload not yet E2E-tested |
| Responsive mobile + desktop layouts, dark mode | Implemented | screenshots reviewed at 1440×900 and Pixel 7 |

## Not yet started (later phases)

Filters (Phase 2) · Insights/dashboard widgets (Phase 4) · Calendar day/3-day/week/agenda with time blocks (Phase 2) ·
dependencies UI (Phase 2; table exists) · smart scheduling (Phase 2) · notification delivery (Phase 2) · templates (Phase 2) ·
voice capture, AI, automations, Home Assistant, email/document capture (Phase 3) · reports, goals, integrations, CSV,
local API (Phase 4) · native Android/Windows/macOS/iOS builds (Phase 5).

**Navigation note:** the spec lists Filters and Insights as primary sections. They are deliberately *absent* from
navigation until they work, rather than shown as placeholder screens.
