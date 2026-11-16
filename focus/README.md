# Focus

A local-first personal productivity app: tasks, projects, subtasks, natural-language Quick Add, recurring tasks,
and a calm, fast interface for phone and desktop. **Your data stays on your device.** No account, no cloud, no tracking.

> Status: **Phase 1 complete** (see [FEATURES.md](FEATURES.md)). Runs as a web app / installable PWA, and as a
> native desktop app via Tauri (verified on Linux). Windows and Android builds must be made on those platforms —
> see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md). Nothing has been tested on physical devices yet.

## Quick start

Requires Node.js 22+.

```bash
cd focus
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/ (relative paths; host anywhere)
npm run preview    # serve the production build
npm run check      # typecheck, lint, tests, build
npm run e2e        # browser tests (desktop + Pixel 7 emulation)
npm run desktop:dev    # native app (needs Rust; see PLATFORM_SUPPORT.md)
npm run desktop:build  # native installer for the current OS
```

The production build is static files: host `dist/` on any HTTPS server, open it in Chrome on Android or
Edge/Chrome on Windows, and choose **Install**. It then works offline.

## Using Focus

- **Quick Add** (`Q`, or the + button): type naturally, e.g.
  `Phone dentist Friday 10am #Home p2 @calls`, `Finish report by 20 November`, `Check meter every second Tuesday`,
  `Descale kettle every 4 weeks after completion`. Recognised parts are highlighted; tap one to keep it as text.
- **Dates:** *Scheduled* is when you plan to do it, *Deadline* is when it must be done, *Starts* is when it can begin.
- **Back up** from Settings → Data (JSON includes attachments; SQLite is a byte-exact copy).
- Press `?` for keyboard shortcuts.

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, data flow, platform abstraction |
| [DECISIONS.md](DECISIONS.md) | Architecture decision records |
| [DATABASE.md](DATABASE.md) | Schema, migrations, persistence |
| [FEATURES.md](FEATURES.md) | Honest per-feature status |
| [ROADMAP.md](ROADMAP.md) | Five-phase plan |
| [TESTING.md](TESTING.md) | Test suites and manual checks |
| [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md) | Platform status and limitations |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Upgrading

Data lives in IndexedDB and survives app updates. On start-up Focus checks database integrity and, before any
schema migration, stores a snapshot of the previous database. It refuses to open a database written by a newer
version rather than modify it.
