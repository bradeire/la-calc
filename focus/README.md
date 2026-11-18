# Focus

A local-first personal productivity app: tasks, projects, subtasks, natural-language Quick Add, recurring tasks,
and a calm, fast interface for phone and desktop. **Your data stays on your device.** No account, no cloud, no tracking.

> Status: **Phases 1–4 complete, plus encrypted sync between devices** (see [FEATURES.md](FEATURES.md)). Ships as a
> native app (Tauri) for **Android** (Pixel; APK built in the cloud session) and **Windows 11** (installer built by
> GitHub Actions), plus Linux. In daily use on a Pixel; the Windows app is new. The web/PWA version was dropped in
> 0.9.0 — the browser build is kept only for automated tests and development. See [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).

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

`npm run dev` / `npm run build` produce the browser build used by the tests; it is not a supported way to use Focus.
Install the Android APK or the Windows installer instead (see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md)).

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
| [INTEGRATIONS.md](INTEGRATIONS.md) | Claude connector and local API, calendars, import/export, webhooks, Home Assistant, AI, capture, voice |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Upgrading

Data lives in a SQLite file in the app's data folder and survives app updates. On start-up Focus checks database integrity and, before any
schema migration, stores a snapshot of the previous database. It refuses to open a database written by a newer
version rather than modify it.
