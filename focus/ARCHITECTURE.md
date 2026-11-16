# Focus — Architecture

Focus is a local-first productivity application with **one TypeScript codebase**
for every platform. Business logic never touches the DOM, SQL never appears in
React components, and platform differences sit behind interfaces.

```
┌──────────────────────────────────────────────────────────────────────┐
│ UI  (src/ui)  React components, views, layout, primitives            │
│   reads via hooks (useQuery) · writes via services only              │
├──────────────────────────────────────────────────────────────────────┤
│ State (src/state)  Zustand: navigation, selection, undo, toasts, ui  │
├──────────────────────────────────────────────────────────────────────┤
│ Services (src/services)  use-cases: completeTask, quickAdd, undo …   │
│   transactions · activity log · recurrence · validation              │
├──────────────────────────────────────────────────────────────────────┤
│ Core (src/core)   pure functions, no I/O                             │
│   domain types + Zod schemas · recurrence engine · NLP parser ·      │
│   date utilities · task tree utilities                               │
├──────────────────────────────────────────────────────────────────────┤
│ Data (src/data)  repositories (SQL) · migrations · seed data         │
│   DatabaseDriver interface → SqlJsDriver                             │
├──────────────────────────────────────────────────────────────────────┤
│ Platform (src/platform)  persistence · file store · notifications ·  │
│   lifecycle · device capabilities                                    │
│   web (IndexedDB) │ tauri (fs, native — Phase 5) │ memory (tests)    │
└──────────────────────────────────────────────────────────────────────┘
```

## Directory layout

| Path | Responsibility |
|---|---|
| `src/core/domain` | Entity types and Zod schemas (`Task`, `Project`, `Label`, …). |
| `src/core/dates.ts` | Floating-date helpers (`YYYY-MM-DD`), UK formatting, today/overdue logic. |
| `src/core/recurrence` | Structured recurrence rules, occurrence generation, next-date calculation, human descriptions. |
| `src/core/nlp` | Deterministic Quick Add parser → structured draft + token spans + ambiguities. |
| `src/core/tree.ts` | Build/flatten nested task trees, progress calculation. |
| `src/data/db` | `DatabaseDriver` interface, sql.js driver, migration runner. |
| `src/data/migrations` | Versioned, reversible migrations (`up`/`down`). |
| `src/data/repositories` | One repository per aggregate. All SQL lives here. |
| `src/data/seed.ts` | Demonstration data — tagged so it can be removed cleanly. |
| `src/services` | Use-case layer. Every mutation the UI performs goes through here. |
| `src/platform` | Platform detection and adapters (persistence, files, lifecycle, notifications). |
| `src/state` | Zustand stores for UI state; the database itself is the source of truth for data. |
| `src/ui` | `layout/`, `views/`, `components/`, `primitives/`, `hooks/`. |

## Data flow

**Reads.** Components call `useQuery(() => repo.method(args), [deps])`. The hook
subscribes to the database's change counter; any committed write bumps it and
mounted queries re-run. Because sql.js is in memory, queries are synchronous and
typically take well under a millisecond, so there is no stale cache to manage.

**Writes.** Components call a service (`taskService.complete(id)`). The service
opens a transaction, performs repository calls, writes `activity_log` and
`change_log`, commits, and returns an **undo token** where the action is
reversible. The driver marks the database dirty and the persistence adapter
schedules a flush.

**Undo.** Services return an `UndoAction` (`{ label, undo: () => void }`). The UI
shows a toast; choosing Undo runs the inverse in a new transaction.

## Platform abstraction

```ts
interface PersistenceAdapter { load(): Promise<Uint8Array | null>; save(bytes): Promise<void>; loadPrevious(); }
interface FileStore           { put(id, blob); get(id); delete(id); }   // attachments
interface NotificationAdapter { schedule(reminder); cancel(id); requestPermission(); } // Phase 2
interface LifecycleAdapter    { onPause(cb); onResume(cb); }
interface SecretStore         { persistent; get(key); set(key, value); delete(key); } // keychain / Android Keystore
interface HttpAdapter         { request({ method, url, headers, body }); }           // integrations only
interface LinkAdapter         { initial(); listen(cb); }                             // focus:// links, shares
exportFile(name, data, mime)                                                         // download / Downloads / share sheet
localApi?: { start(port, token, allowLan); stop(); onRequest(cb); respond(id, status, body) } // desktop only
```

Phase 4 services: `InsightsService` (reports and goals over stored data), `CalendarService` (external .ics
calendars, busy time, .ics export), `TransferService` (CSV/Todoist/project-file import and export) and
`ApiService` (local API routes; the Rust server in `src-tauri/src/api.rs` only authenticates and forwards).

`src/platform/index.ts` selects implementations at start-up (`isTauri()` → Tauri
adapters, otherwise web). Business logic only imports the interfaces.

## Cross-phase design commitments

The Phase 1 schema already contains the tables later phases need (dependencies,
time entries, templates, automations, calendar connections, backup history),
so later phases add behaviour, not restructuring. Specifically:

- **Scheduling (Phase 2):** `start_date`, `scheduled_date`, `scheduled_time`,
  `deadline` and `duration_minutes` are independent columns from day one.
- **Dependencies (Phase 2):** `task_dependencies` table with a cycle check in the
  service layer.
- **Automations (Phase 3):** services emit domain events (`task.created`,
  `task.completed`, …) through `src/services/events.ts`. The automation engine
  subscribes to the same bus; nothing in the UI needs to change.
- **Sync (future):** UUIDs + `change_log` + `updated_at` on every row.
- **Secrets (Phase 4):** credentials never go in SQLite. `CredentialStore`
  interface backed by OS keychain/Stronghold natively; in the browser, external
  integrations requiring secrets are disabled unless the user explicitly opts
  in to session-only storage.

## Performance approach

- Indexed columns: project, parent, section, status, scheduled date, deadline,
  completed_at, deleted_at, series.
- Full-text search via an FTS4 virtual table kept in sync by triggers.
- Views query only what they show (e.g. Today = overdue ∪ today ∪ pinned).
- List virtualisation is planned for Phase 5 when lists exceed ~500 rows.
