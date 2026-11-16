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
| Database, migrations, boot, recovery | `tests/database.test.ts` | 10 |
| Task service (lifecycle, subtasks, recurrence, views, time) | `tests/task-service.test.ts` | 22 |
| Projects, labels, sample data, backup/restore | `tests/data-service.test.ts` | 12 |
| **Total Vitest** | | **138 passing** |
| End-to-end (desktop + Pixel 7 emulation) | `e2e/core.spec.ts` | **24 passing** (12 × 2) |

Integration tests run on sql.js in Node, i.e. the same SQLite engine the app ships, not a mock.
The in-memory platform (`src/platform/memory.ts`) is used only in tests.

## Notable regressions caught by tests

- Zod 4's `.partial()` applies `.default()` values, which made every partial update reset other fields
  (e.g. clearing a deadline when changing the date). Patch schemas are now built from default-free fields.
- Undoing a move did not move subtasks back (`??` treated `null` as "unchanged").
- `DROP TABLE` with foreign keys enabled fires delete triggers; the down-migration now drops triggers first.
- Quick Add measured its textarea before the native dialog opened (height 0).
- Menus opened from Quick Add rendered behind the modal dialog (browser top layer); popovers now render inside an open dialog.

## Manual checks per release

1. Fresh install → onboarding → demo data; check Today/Upcoming/Calendar.
2. Create tasks via Quick Add with dates, `#project`, `@label`, `p1`, recurrence; tap a token to un-parse.
3. Complete a recurring task; confirm exactly one next occurrence; undo.
4. Reload; confirm data persists. Go offline (DevTools) and reload the installed PWA.
5. Export JSON + SQLite backup; restore into a fresh profile.
6. Dark mode, 130 % text size, reduced motion, keyboard-only navigation.

## Not yet tested

Physical devices (any), native Tauri builds, multi-tab lock in a real browser, offline reload of the PWA,
screen readers (TalkBack/NVDA/VoiceOver), performance at 10k+ tasks.
