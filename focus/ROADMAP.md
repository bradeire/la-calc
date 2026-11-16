# Focus — Roadmap and Development Plan

Phases are completed sequentially. A phase is done only when its features are
implemented, persisted, validated, tested and documented — see FEATURES.md for
per-feature status.

## Session 1 plan (initial implementation priorities)

1. ✅ Inspect environment and repository (existing LASTCalc app left untouched — ADR-001).
2. ✅ Confirm architecture (ADR-002 … ADR-008).
3. ✅ Create repository structure in `focus/`.
4. ✅ Initialise React + TypeScript + Vite + Tailwind application.
5. ✅ Design system: tokens, light/dark themes, accent colours, primitives.
6. ✅ Database: sql.js driver, migrations, IndexedDB persistence, integrity check, single-tab lock.
7. ✅ Task, project, section, label models and repositories.
8. ✅ Primary navigation (sidebar desktop / bottom nav mobile, hash routing, back button).
9. ✅ Working Quick Add with natural-language parsing and token correction.
10. ✅ First complete task workflow: capture → organise → schedule → complete → undo.

## Phase 1 — Core application

**Status after session 2:** Phase 1 complete in the browser and in a native Linux build. Done in session 2:
project attachments, offline reload test, virtualised lists (20k-task benchmarks), automated WCAG AA audit, and a
Tauri native shell with atomic file storage, verified end to end on Linux.

Carried forward (need hardware or a platform toolchain, not more code):
- Build and smoke-test the Windows installer on a Windows 11 PC.
- `tauri android init` + run on a physical Pixel.
- Manual screen-reader pass (NVDA on Windows, TalkBack on Pixel).
- Touch drag-and-drop on boards (touch users currently move cards via the project/section picker).

**Phase 2 completed in session 3; Phase 3 in session 4** — see FEATURES.md. **Next: Phase 4.**

| Work item | Notes |
|---|---|
| Task CRUD, duplicate, move, soft-delete + Trash, complete/reopen, undo | services + repositories |
| Statuses: inbox, active, in progress, waiting, completed, cancelled, archived | |
| Nested subtasks: unlimited depth, collapse, progress, move, promote | optional auto-complete parent |
| Quick Add NLP: dates, times, recurrence, priority, project, labels, deadline, duration | offline, UK defaults |
| Projects: nested, sections, colour, icon, description, notes, archive, progress, default layout | templates → Phase 2 |
| Project layouts: list, board, table (calendar layout with Phase 2 calendar) | |
| Labels: CRUD, colours, suggestions in Quick Add, label view | |
| Views: Inbox, Today, Upcoming, Project, Label, Search, Focus mode, Trash | |
| Recurrence engine | scheduled/completion basis, nth weekday, month days |
| Comments, attachments (local), activity history | |
| Time tracking start/stop in Focus mode | full reports → Phase 4 |
| Settings: theme, accent, date/time locale, working hours, sample data | |
| Onboarding: empty / demo data / import backup | |
| JSON backup export/import | full backup suite → Phase 4 |
| Bulk operations on desktop | multi-select |
| Keyboard shortcuts | |

## Phase 2 — Advanced planning
Calendar (day, 3-day, week, month, agenda) with drag/resize; start/scheduled/deadline
independence in UI; available-time and workload calculation; smart scheduling
suggestions (accept/reject); dependencies with cycle prevention; filter engine
(AND/OR/nested, visual builder + query language, saved/pinned); reminders with
native notification scheduling; project templates with relative dates.

## Phase 3 — Intelligence and automation
Locale-configurable NLP refinements; voice capture (Android SpeechRecognizer via
native plugin, Web Speech API in browser with online-only warning); optional AI
provider interface (Ollama, OpenAI-compatible) with explicit consent and
confirmation of all changes; trigger-condition-action automation engine with
history, loop prevention, limits and test mode; Home Assistant webhooks; text,
email and meeting-note task extraction as suggestions.

## Phase 4 — Productivity and integrations
Insights dashboard (completion, trends, distribution, recurring completion);
time tracking reports and log correction; goals and streaks; external calendar
integration layer (read-only display + availability, optional export);
integration framework with secure credential storage; JSON/CSV import/export,
full backup including attachments with verification; authenticated local API
(off by default, localhost only by default).

## Phase 5 — Polish, mobile experience and release
Tauri Android build (adaptive icon, splash, notifications + actions, shortcuts,
share sheet, haptics, dynamic colour, back navigation, battery); Windows
installer (tray, startup, window state, notifications); macOS/iOS build
configuration (documented as requiring macOS + Xcode); accessibility audit;
virtualised lists and 50k-task performance testing; migration and integrity
testing; release documentation.

## Synchronisation (post-release)
Local-network device-to-device sync over an encrypted channel using `change_log`,
with optional self-hosted relay. Not started until the core is stable.
