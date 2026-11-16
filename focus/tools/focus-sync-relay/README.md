# Focus sync relay

A tiny Cloudflare Worker that lets your Focus devices sync. It stores **encrypted** batches of changes and hands
them to your other devices. It never has the key to read them: devices derive the encryption key from your sync
key, and only send the relay an access token (stored as a hash) and ciphertext.

Runs on Cloudflare's free plan (Workers + D1). Your relay, your account; nobody else's server is involved.

## Set up in the dashboard (no command line)

1. Create a free account at <https://dash.cloudflare.com>.
2. **Storage & Databases → D1 → Create database**, name it `focus-sync`.
3. **Workers & Pages → Create → Worker**, name it `focus-sync`, **Deploy**.
4. **Edit code**, replace everything with [`worker.js`](worker.js) (Focus can copy or save it for you: Settings →
   Sync between devices → How to set up your relay), **Deploy**.
5. The worker's **Settings → Bindings → Add → D1 database**: variable name `DB`, database `focus-sync`, **Save**.
6. Open `https://focus-sync.<your-subdomain>.workers.dev/v1/health` — it should show `{"ok":true,...}`.
7. In Focus: Settings → Sync between devices → **Set up on this device**, paste the address.

Tables are created automatically on the first request. Cloudflare occasionally renames menu items.

## Or with the command line

```bash
npx wrangler login
npx wrangler d1 create focus-sync          # copy the database_id into wrangler.toml
npx wrangler deploy
```

## API

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | no auth |
| POST | `/v1/vaults/{vault}/batches` | `{ "device", "data" }` (base64 ciphertext ≤ 1.5 MB). The first upload creates the vault and fixes its token. |
| GET | `/v1/vaults/{vault}/batches?after=&limit=` | batches in order; `more` if there are further pages |
| POST | `/v1/vaults/{vault}/delete` | erase everything stored for the vault |

All but health need `Authorization: Bearer <64 hex token>`. CORS is open (`*`) because every request needs the
token; the token is compared in constant time.

## What the relay can see

The vault id (random), each device's random id, batch sizes and times. Not task titles, notes, dates or anything
else in your data.
