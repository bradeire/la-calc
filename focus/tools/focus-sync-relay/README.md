# Focus sync relay

A single-file Cloudflare Worker (with a D1 database) that lets Focus devices sync. It stores **encrypted**
batches of changes, snapshots and attachment files, and hands them to the user's other devices. It never has the
key to read them: devices derive the encryption key from the user's sync key and send the relay only an access
token (stored as a hash) and ciphertext.

Two ways to use it:

- **Your own relay** (personal use, free plan) — below.
- **A hosted relay for everyone who installs Focus** (a release) — see "Running a hosted relay".

## Your own relay (dashboard, no command line)

1. Create a free account at <https://dash.cloudflare.com>.
2. **Storage & Databases → D1 → Create database**, name it `focus-sync`.
3. **Workers & Pages → Create application → Start with Hello World!** (not "Import a repository" or "Upload
   static files"; if it isn't shown, pick a Hello World template), name it `focus-sync`, **Deploy**.
4. **Edit code**, replace everything with [`worker.js`](worker.js) (Focus can copy or save it: Settings → Sync
   between devices → Use my own relay → How to set up your relay), **Deploy**.
5. The worker's **Settings → Bindings → Add → D1 database**: variable name `DB`, database `focus-sync`, **Save**.
6. Open `https://focus-sync.<your-subdomain>.workers.dev/v1/health` — it should show `{"ok":true,...}`.
7. In Focus: Settings → Sync between devices → **Set up on this device**, paste the address.

Tables are created automatically and upgraded in place when you deploy a newer `worker.js`.

**Updating:** Workers & Pages → `focus-sync` → Edit code → paste the new `worker.js` → Deploy (Focus: Settings → Sync
between devices → Update your relay's code). Version 3 adds the `/open` page that makes tap-to-add links from Claude
tappable (Claude's apps only make `http(s)` links tappable).

## Running a hosted relay (for a release)

1. Deploy as above (or with `npx wrangler deploy` and `wrangler.toml`), ideally on your own domain
   (e.g. `sync.example.com`: Worker → Settings → Domains & Routes).
2. Set limits under **Settings → Variables**:

   | Variable | Default | Meaning |
   |---|---|---|
   | `QUOTA_BYTES` | 104857600 (100 MB) | Storage per user (vault), including history, snapshots and files |
   | `RATE_PER_MINUTE` | 240 | Requests per vault per minute |
   | `IP_RATE_PER_MINUTE` | 600 | Requests per IP address per minute |
   | `VAULTS_PER_IP_PER_DAY` | 5 | New sync set-ups per IP address per day |
   | `LICENCE_SECRET` (secret) | — | If set, setting up sync needs a licence (paid sync) |
   | `VAULTS_PER_LICENCE` | 3 | Set-ups one licence may create |

3. **Paid sync (optional):** set `LICENCE_SECRET` as an encrypted secret (`npx wrangler secret put
   LICENCE_SECRET`). Mint a licence per customer with
   `LICENCE_SECRET=... node mint-licence.mjs <customer-id> <days|0>` and give it to them (e.g. from your payment
   provider's webhook). Users paste it when setting up sync. When it expires, their devices stop sending new
   changes but can still read their data; a renewed licence (same id, later expiry) resumes it.
4. **Build Focus with your relay as the default:** `VITE_SYNC_RELAY_URL=https://sync.example.com npm run build`
   (and the same for `tauri build` / `tauri android build`). Users then just press "Set up on this device"; "Use my
   own relay instead" stays available.
5. **Costs:** the Workers/D1 free plan covers testing and small numbers of users; beyond that Cloudflare's paid
   Workers plan applies. Check Cloudflare's current pricing and limits; compaction keeps per-user storage roughly
   proportional to the size of their data rather than their history.
6. **Privacy:** you hold only ciphertext plus metadata (random vault ids, device ids, sizes, times, IP addresses in
   Cloudflare's logs). Say so in your privacy policy and on Google Play's Data safety form ("encrypted in transit";
   data is end-to-end encrypted). You cannot reset a user's sync key or recover their data — that is the point;
   the app makes users save a recovery sheet.

What the relay can't do: prove a request comes from the genuine Focus app (any client can be copied). Quotas,
rate limits and licences are the defence against abuse.

## API

All `/v1/vaults/{vault}/…` requests need `Authorization: Bearer <64-hex token>`; `X-Focus-Licence` is sent when
the relay needs a licence. CORS is open because every request needs the token.

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | `{ ok, version, licenceRequired }` |
| GET | `/open` | Static “Add to Focus” page for tap-to-add links: `/open#add?text=…` hands the text to `focus://`. The text is in the fragment, so it never reaches the relay. No token needed. |
| POST | `/batches` | `{ device, data }` (base64 ciphertext ≤ 1.5 MB). The first upload creates the vault. |
| GET | `/batches?after=&limit=` | batches in order, `more`, and `snapshot` when the caller is behind the latest snapshot |
| POST / GET | `/snapshots/{id}/parts/{n}` | upload `{ parts, upTo, data }` / download a part; completion deletes covered batches |
| GET | `/blobs/{id}` | `{ blob: { parts, complete } \| null }` |
| POST / GET | `/blobs/{id}/parts/{n}` | upload `{ parts, data }` / download a part of an encrypted file |
| POST | `/blobs/{id}/delete` | remove a file |
| GET | `/usage` | `{ bytes, quota, batches, licenceExpires }` |
| POST | `/delete` | erase everything for the vault |

Errors: 402 licence required/expired, 403 wrong key, 429 rate limit (`Retry-After`), 507 quota full.
