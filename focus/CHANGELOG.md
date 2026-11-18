# Changelog

## 0.9.0 — 2026-11-18

### Removed
- **The web / installable PWA version.** Focus now ships only as native apps: Android and Windows (and Linux). The
  service worker (offline cache), web app manifest, browser share target and service-worker notification actions are
  gone; a browser that installed an earlier version has its offline cache unregistered on next visit. The browser
  build remains for automated tests and development only, and no web zip is produced.

## 0.8.1 — 2026-11-17

### Fixed
- Imported tasks (Capture, Claude links, Share, the local API) read dates conservatively: nothing inside (brackets)
  or [brackets] is taken as a date, time, priority or label, so references like "(5 and 11 Nov)" stay in the title;
  and a day and month without a year that has just passed (e.g. "11 Nov" on 17 Nov) stays text instead of being
  scheduled for next year, so a later "tomorrow" is used. Typing in Quick Add is unchanged.

## 0.8.0 — 2026-11-17 (sorting, grouping, easier deadlines)

### Added
- **Sort and group** (the **Sort** button in the view header) in Inbox, Today, projects (list layout), labels,
  saved filters and search; Upcoming sorts within each day. Sort by your manual order, deadline, scheduled date,
  date added, project, name or priority, ascending or descending (tasks without the date always last). Group by
  project, label (a task with two labels appears under both), priority, deadline or scheduled date (Overdue, Today,
  Tomorrow, This week, Next week, Later, No date) or status. Subtasks stay with their parent. Each view remembers
  its choice on this device; drag-to-reorder works when the manual order is shown. In a project, grouping replaces
  sections on screen without changing them.
- **Deadlines are quick to change:** tap a task's deadline to reschedule it; "Schedule…" and "Change deadline…" in
  the task menu; swiping left on a task whose only date is a deadline moves the deadline; a deadline button for
  selected tasks. Date pickers offer "1 day / 1 week / 1 month later" relative to the current date.
- Today → Overdue: **Reschedule…** moves every overdue date to a day you pick.

### Changed
- **Calmer task details:** Project, Priority, Scheduled and Deadline always show; Labels, Estimate, Repeat, Start
  date, Pin to Today and Status appear only when set, or after tapping their "+" chip.

### Fixed
- Phone layout: the Upcoming title was cut off by its buttons (header buttons now wrap onto a second line); the
  search box sat under the header; settings rows (e.g. Working hours) squeezed their labels instead of wrapping.
- Today → Overdue → "Move to today" ignored tasks whose only overdue date was a deadline (and was greyed out when
  all of them were).

## 0.7.5 — 2026-11-17

### Changed
- **Imported tasks always go to the Inbox.** Tasks from Claude links, Share, Capture and the local API's `text` field
  no longer choose or create a project from a `#Project` tag; the tag is kept in the task's description as
  "Suggested project: …" for you to file the task yourself. Dates, priorities and @labels still apply. (An explicit
  `projectId`/`project` in the local API, or the project picked in the Capture dialog, is still honoured.)
- The instructions for Claude no longer ask for `#project` tags (paste the new version into Claude).

### Fixed
- Capture created a new project for every task with the same new `#Project` (it looked the projects up once per
  import), e.g. four "Home" projects from one daily brief.

### Added
- Project menu → **Delete project, move tasks to Inbox** (the existing Delete still sends tasks to Trash).

## 0.7.4 — 2026-11-17

### Fixed
- **Android never saved anything** (since the first Android build): every launch started at set-up with no data.
  Android's WebView can't pass raw binary to the native side, so Tauri sent the database as JSON, which the save
  command rejected. The app now sends base64 on Android, and the native side accepts raw bytes, base64 or a byte
  array. Attachments and snapshots had the same fault.
- Save failures were only shown by a small icon in the sidebar, which phones don't show. A red bar now appears on
  every screen while changes aren't being saved.

## 0.7.3 — 2026-11-17

### Fixed
- Tap-to-add links from Claude didn't open: Claude's apps only make web links tappable. With sync set up, the
  instructions now use a page on your relay (`/open#…`, relay version 3) with an "Open in Focus" button; the task text
  stays in the part after `#`, which never reaches the relay. Settings → Sync shows how to update the relay's code.
- Capture found no tasks in a plain list or in a pasted Claude reply. It now reads Focus links in pasted text, takes a
  plain list one task per line, and Capture opened from a link goes straight to the review with every line ticked.
- Calendar all-day cells had an accessibility label without a role.

## 0.7.0 — 2026-11-16 (sync ready for release)

### Added
- Field-level merging with hybrid logical clocks: edits to different fields on two devices both survive, and a
  device with a wrong clock can't override later edits.
- Relay hardening for a hosted service: storage quotas and usage, rate limits, limits on new vaults, optional
  sync licences (with expiry), snapshots that compact history, encrypted attachment files.
- Attachment files now sync (encrypted).
- Recovery sheet for the sync key, and a required "I've saved my key" step.
- Android background sync every ~15 minutes while Focus is closed (Rust engine + WorkManager).
- Builds can offer a default hosted relay (`VITE_SYNC_RELAY_URL`).

### Fixed
- Joining failed after the relay had compacted history; the relay returned one batch per page when no limit was
  given.

## 0.6.0 — 2026-11-16 (sync between devices)

### Added
- End-to-end encrypted sync between desktop, Android and browser through a relay on your own free Cloudflare
  account: tasks, projects (with notes), sections, labels, comments, reminders, time entries, dependencies,
  filters, templates, automations and shared preferences. Set up with a sync key, QR code or join link.
- Relay code (`tools/focus-sync-relay`) with in-app setup steps.

### Fixed
- An edit made just before reloading the browser tab could occasionally still be lost; a synchronous copy is now
  kept for the reload.

## 0.5.0 — 2026-11-16 (Phase 4: productivity and integrations)

### Added
- Insights: completion, project/label, priority, due-date, recurring, workload and project reports with date
  ranges, charts and tables; customisable widgets.
- Time log with corrections; estimate vs actual; a prompt when a timer has run for hours.
- Goals and streaks (daily/weekly tasks or time).
- External calendars (Google, Outlook, Apple via .ics address or file): shown read-only, counted as busy time,
  clashes flagged; export tasks as .ics.
- CSV export/import, Todoist CSV import, project and task files; previews, duplicate skipping and undo.
- Local API and a Claude connector for Claude Desktop / Claude Code (desktop app, off by default).
- Android: secrets encrypted with the Android Keystore; exports through the share sheet.

### Fixed
- Exports and backups did nothing inside the native apps.

## 0.4.0 — 2026-11-16 (Phase 3: intelligence and automation)

### Added
- Automations: trigger → conditions (filter builder) → actions, with examples, history, test mode, hourly limits,
  duplicate and loop prevention.
- Webhooks with HMAC-SHA256 signing; Home Assistant guide (INTEGRATIONS.md).
- Capture tasks from pasted emails, meeting notes and text files; Android share target.
- Optional AI assistant (Ollama or OpenAI-compatible) with consent, payload preview and confirm-before-apply:
  subtasks, task suggestions, project summary, filter from words, template drafts, plan review, AI capture.
- Voice dictation in Quick Add with clear online/on-device disclosure.
- Native: OS keychain for secrets and Rust-side HTTP for integrations.
- Tap-to-add links (`focus://add?text=…`) for adding tasks from Claude, with copyable instructions in Settings;
  Android "Share → Focus" for text.
- First Android build: signed arm64 release APK (Tauri Android project in `src-tauri/gen/android`).

### Fixed
- Edits could be lost when the page was reloaded or closed immediately after a change.

## 0.3.0 — 2026-11-16 (Phase 2: advanced planning)

### Added
- Calendar day, 3-day, week (time grid with drag-to-move, drag-to-resize, click-to-add), month and agenda views,
  with project/label filters, deadlines, projected repeats, working-hours shading and a current-time line.
- Task dependencies with cycle prevention, blocked badges and "Complete anyway" / "Schedule anyway" confirmations.
- Filters: visual builder and query language kept in sync; saved and pinned filters; quick-start presets.
- Workload bars, conflict detection and suggested rescheduling with accept/reject (Upcoming → Review plan).
- Reminders delivered in-app with Complete/Snooze/Dismiss, plus optional system notifications (web and desktop).
- Project templates: save any project as a template; built-in "Holiday planning".
- Settings: notifications, default estimate.

### Fixed
- Weekend tasks counted as overload; blocked-task lookup slow on large lists; several collapsed-section controls.

## 0.2.0 — 2026-11-16 (Phase 1 completion)

### Added
- Native desktop/mobile shell (Tauri 2): SQLite stored as a real file with atomic saves, rotation and snapshots;
  single-instance guard; flush before window close; per-user Windows installer configuration; app icons.
- Project notes and attachments.
- Virtualised task lists for large views.
- Automated accessibility audit, offline test, performance tests.

### Changed
- Higher-contrast secondary text, accessible accent palette, readable label colours, calendar ARIA structure.
- Database migration 002 (sibling-order index).

### Fixed
- Quick Add menus appeared behind the dialog.
- Installed web app failed to load offline.
- "Add file" did nothing while the attachments section was collapsed.
- New databases weren't saved until the first edit.
- Upcoming showed "Today" for timed tasks on other days.

## 0.1.0 — 2026-11-14 (Phase 1, first session)

### Added
- Architecture decision records, architecture, database and roadmap documentation.
- Local SQLite database (sql.js) persisted to IndexedDB with rotating snapshots, integrity check on start-up,
  corruption recovery, pre-migration snapshots, versioned reversible migrations and a single-tab lock.
- Full Phase 1 schema including tables for later phases.
- Tasks with every specified field and status; nested subtasks; duplicate, move, promote, soft delete, Trash, undo.
- Deterministic offline Quick Add parser (UK defaults) with highlighted tokens, tap-to-unrecognise and ambiguity choices.
- Recurrence engine with scheduled- or completion-based repeats; one next occurrence per completion.
- Projects (nested, sections, colours, icons, notes, archive, favourites) with List, Board, Table and month Calendar layouts.
- Labels, Inbox, Today, Upcoming, Calendar, Search (FTS), Focus mode with timer, Trash, Settings, onboarding.
- Comments, local attachments, reminders (stored), activity history, time tracking.
- JSON and SQLite backup with verification; restore with safety snapshot; demo data with safe removal.
- Responsive layout (bottom navigation + FAB on phones, sidebar + resizable detail panel on desktop), dark mode,
  accent colours, keyboard shortcuts, swipe actions, drag and drop, PWA with offline service worker.
- 138 Vitest tests and 22 Playwright tests (desktop + Pixel 7 emulation).
