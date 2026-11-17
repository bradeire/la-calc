# Focus — Integrations

Everything here is optional and off by default. Focus works fully offline without any of it.

## Sync between devices

Settings → **Sync between devices**. You need a relay once: a free Cloudflare account with the worker in
`tools/focus-sync-relay` (the app shows the steps and can copy the code). Then **Set up on this device** creates a
sync key; on the other device choose **Join from another device** and enter the relay address and key — or scan the
QR code / open the join link. Syncs automatically (on start, every minute, after changes, when the app comes to the
foreground; on Android also every ~15 minutes while closed). Everything is encrypted on the device; the relay sees
only ciphertext. Edits to different fields on two devices both survive. Save the recovery sheet when you set up:
without the sync key a new device can't join, and nobody can reset it. Attachment files sync too.
Running a hosted relay for others: see `tools/focus-sync-relay/README.md`.

## Claude on your computer (local API + connector)

Desktop app only. Settings → **Local API and Claude connector** → switch on, then **Save focus-mcp.mjs** and add it
to Claude:

```json
{ "mcpServers": { "focus": { "command": "node", "args": ["C:\\Users\\you\\focus-mcp.mjs"],
  "env": { "FOCUS_API_URL": "http://127.0.0.1:47615", "FOCUS_API_TOKEN": "<token from Settings>" } } } }
```

Claude Code: `claude mcp add focus --env FOCUS_API_TOKEN=<token> -- node <path>/focus-mcp.mjs`. Needs Node.js 18+
and Focus open. Claude can then add tasks (natural language, like Quick Add), list/filter, edit, complete and
reopen tasks, list/create projects, list labels, and run automations you tick in Settings. It cannot delete.

### Local API reference

All requests need `Authorization: Bearer <token>`; JSON in and out; `http://127.0.0.1:47615` by default.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | |
| GET | `/v1/tasks?status=open\|completed\|all&filter=<query>&projectId=&limit=` | filter uses the Filters query language |
| POST | `/v1/tasks` | `{"text": "Pay rent every month on the 1st #Home"}` or `{"title", "project", "scheduledDate", …}` |
| GET / PATCH | `/v1/tasks/{id}` | PATCH any of title, description, projectId, priority, status, dates, durationMinutes, labels |
| POST | `/v1/tasks/{id}/complete`, `/reopen` | 409 if it waits on another task; repeat with `?force=true` |
| GET / POST | `/v1/projects` | POST `{"name", "parentId"?}` |
| GET | `/v1/labels` | |
| GET | `/v1/automations`; POST `/v1/automations/{id}/run` | only automations approved in Settings |

```bash
curl -H "Authorization: Bearer $TOKEN" -d '{"text":"Renew car insurance by 30 Nov p1"}' http://127.0.0.1:47615/v1/tasks
```

## External calendars

Settings → **Calendars**: add a calendar's private .ics address (Google: Settings → your calendar → "Secret address
in iCal format"; Outlook: Settings → Calendar → Shared calendars → Publish; iCloud: share as Public Calendar) or
import an .ics file. Events appear read-only in the calendar; "Count as busy time" makes workload and suggested
rescheduling avoid them and flags tasks scheduled on top of them. Refreshes every 30 minutes. Export your scheduled
tasks as .ics from the same section or a project's menu.

## Import and export

Settings → Data: **Export CSV** (all fields; opens in Excel/Sheets) and **Import tasks** from a Focus CSV, any
spreadsheet with a Title column, a **Todoist project CSV** (Todoist → project → ⋯ → Export as a template), or a
Focus project/task file (project menu → Export project; task ⋯ → Export task). You see a preview first; existing
tasks are never changed, duplicates are skipped and the import can be undone.

## Add tasks from Claude (tap-to-add links)

Settings → **Add tasks from Claude** has instructions to paste into Claude once (personal preferences or a project's
instructions). Claude then replies with links such as

```
[Phone dentist Friday 10am #Home p2](focus://add?text=Phone%20dentist%20Friday%2010am%20%23Home%20p2)
[Add all](focus://capture?text=Buy%20milk%0ARing%20the%20garage)
```

- Imported tasks go to the **Inbox**: a `#Project` in a link, share or Capture never chooses or creates a project
  (it's kept as "Suggested project: …" in the description). Dates, priority and @labels still apply.
- `focus://add?text=…` opens **Quick Add** filled in; `focus://capture?text=…` (or several lines) opens **Capture**
  so you can tick which tasks to create. **Nothing is created until you confirm**, so a link from anyone is harmless.
- Text is capped (500 characters for one task, 20,000 for capture); control characters are removed; other actions
  are ignored.
- **Share instead:** on Android, Share any Claude reply (or a Gmail, Outlook or Teams message) → **Focus** to open it
  in Capture.
- Links open the installed app (Android, Windows, macOS, Linux). In the browser version they can be passed as
  `?link=focus%3A%2F%2Fadd%3Ftext%3D…`.
- **Claude's apps don't make `focus://` links tappable** (reported on the Pixel, 0.7.2). With sync set up, the
  instructions in Settings use your relay's page instead: `https://<relay>/open#add?text=…`. It shows the task(s)
  and an **Open in Focus** button (an Android intent on phones, `focus://` elsewhere). The text is after the `#`,
  which browsers never send, so the relay never sees it. The relay needs `worker.js` version 3 (Settings → Sync →
  Update your relay's code).
- **Copy instead:** paste Claude's reply or a plain list into Capture. Focus links in it are read directly, and a
  plain list is taken one task per line (chatty lines ending in `.`, `?` or `:` are skipped).

## Webhooks (Home Assistant, Zapier, IFTTT, anything that accepts JSON)

Settings → **Webhooks and Home Assistant** → *Add webhook*. Then use the action **Call a webhook** in an automation.

**What is sent** (POST, `Content-Type: application/json`):

```json
{
  "event": "task.completed",
  "sentAt": "2026-11-16T09:30:00.000Z",
  "task": { "id": "…", "title": "Replace smoke alarm battery", "priority": 2, "status": "completed",
            "project": "Home", "scheduledDate": "2026-11-16", "deadline": null }
}
```

Descriptions, comments and attachments are never sent. Header `X-Focus-Event` carries the event name.

**Signing.** If you set a signing secret, each request carries
`X-Focus-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. The secret is stored in the operating system's
keychain in the desktop app; in the browser it is kept for the current session only.

### Home Assistant example

1. In Home Assistant create an automation with a **Webhook** trigger (ID e.g. `focus-task`), allowed methods POST,
   and *local only* ticked.
2. In Focus add a webhook with URL `http://homeassistant.local:8123/api/webhook/focus-task`.
3. In Focus create an automation, e.g. *When a task is completed → only if labelled @home → Call a webhook*.

```yaml
# Home Assistant automation (YAML mode)
alias: Focus task completed
triggers:
  - trigger: webhook
    webhook_id: focus-task
    allowed_methods: [POST]
    local_only: true
actions:
  - action: notify.mobile_app_pixel
    data:
      message: "Done: {{ trigger.json.task.title }}"
```

**From Home Assistant to Focus:** with the desktop app's local API on and "Allow other devices on my network"
ticked, a Home Assistant `rest_command` can POST to `http://<pc>:47615/v1/tasks` with the bearer token (e.g.
when a leak sensor fires). Showing Focus tasks on a Home Assistant dashboard is not built. Scheduled maintenance tasks can already be modelled as recurring tasks in Focus.

## AI assistant

Settings → **AI assistant (optional)**.

| Provider | Address | Key | Notes |
|---|---|---|---|
| Ollama | `http://localhost:11434` | none | Runs on your computer. In the browser set `OLLAMA_ORIGINS` to allow Focus's address; the desktop app does not need this. |
| OpenAI-compatible (LM Studio, OpenAI, others) | e.g. `http://localhost:1234/v1` or `https://api.openai.com/v1` | optional / required for cloud | Key stored in the OS keychain (desktop) or for the session only (browser). |

Safeguards:
- Nothing is sent until AI is switched on **and** you have agreed to send data to that exact address. Changing the
  address withdraws consent.
- Every request shows the destination (local network or internet) and an expandable *What will be sent* preview,
  and is only sent when you press **Send**.
- Titles, dates, priorities and project names are sent; descriptions only if you allow it; comments and files never.
- Replies are validated; nothing changes until you tick and apply suggestions.

Features: break a task into subtasks; suggest priority/project/labels/estimate/description; summarise a project;
turn a description into a filter query (validated by Focus's own parser); draft a project template; review your plan;
find action items in captured text.

## Capture (email, notes, documents)

Inbox → **Capture from text**, or share text to Focus from another app on Android (installed PWA). Paste an email or
notes, or open a `.txt`, `.md`, `.eml` or `.html` file. Extraction is deterministic and offline: checkboxes, "Action:"/
"TODO:" lines, bullets under "Action items"/"Next steps", requests ("Could you…", "Please…"), "I'll…" commitments and
imperative bullets. Email quoted history and signatures are ignored. Confident items are pre-ticked; you can edit
every line. Each created task records its source. PDF and Word files are not supported yet.

## Voice capture

The microphone in Quick Add uses the browser's speech recognition. Focus tells you before first use whether audio
goes to an online service (Chrome's default). On-device recognition (Chrome's experimental `processLocally`) can be
tried explicitly; Focus saves your data first because the experimental check crashed the browser tab in our testing
(ADR-012). Where no speech recognition exists (some app webviews), use the keyboard's dictation (Gboard, Win + H).
