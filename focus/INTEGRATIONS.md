# Focus — Integrations (Phase 3)

Everything here is optional and off by default. Focus works fully offline without any of it.

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

**Not yet possible:** creating Focus tasks *from* Home Assistant (e.g. when a leak sensor fires) and showing
Focus tasks on a Home Assistant dashboard. Both need Focus to accept incoming requests, which is the local API
planned for Phase 4. Scheduled maintenance tasks can already be modelled as recurring tasks in Focus.

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
