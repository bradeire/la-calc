# Focus — Testing

```bash
npm run typecheck   # TypeScript strict
npm run lint        # ESLint
npm test            # Vitest: unit + integration against the real SQLite engine
npm run e2e         # Playwright: builds, serves on :4174, runs desktop + Pixel 7 projects
npm run check       # typecheck + lint + test + build
```

## What is covered

| Suite | Files | Count (2026-11-14) |
|---|---|---|
| Recurrence engine | `src/core/recurrence/engine.test.ts` | 21 |
| NLP parser | `src/core/nlp/parser.test.ts` | 73 |
| Database, migrations, boot, recovery | `tests/database.test.ts` | 12 |
| Task service (lifecycle, subtasks, recurrence, views, time) | `tests/task-service.test.ts` | 22 |
| Projects, labels, sample data, backup/restore | `tests/data-service.test.ts` | 12 |
| Performance (20,000 tasks) | `tests/performance.test.ts` | 1 |
| **Total Vitest** | | **141 passing** |
| Rust storage (atomic save, rotation, path-escape rejection) | `src-tauri/src/storage.rs` | 3 |
| End-to-end (desktop + Pixel 7 emulation) | `e2e/core.spec.ts` | 26 (13 × 2) |
| Offline reload, accessibility audit | `e2e/quality.spec.ts` | 3 |
| 5,000-task rendering | `e2e/performance.spec.ts` | 1 |
| **Total Playwright** | | **30 passing** (2 desktop-only tests skipped on Pixel) |

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
