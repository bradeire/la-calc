/**
 * A printable recovery sheet for the sync key: the only way back into synced data if every
 * device is lost (the relay can't decrypt it, so nobody can reset it).
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function recoverySheetHtml(opts: { relay: string; key: string; qrSvg: string; createdAt: Date }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Focus sync recovery sheet</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; color: #111; background: #fff; max-width: 680px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .key { font: 600 20px/1.6 ui-monospace, monospace; letter-spacing: 0.04em; word-break: break-all; border: 2px solid #111; padding: 12px; border-radius: 8px; }
  .qr { width: 200px; margin: 12px 0; }
  .warn { border-left: 4px solid #b45309; padding: 4px 12px; background: #fff7ed; }
  small { color: #555; }
  @media print { body { margin: 0 auto; } button { display: none; } }
</style>
</head>
<body>
<h1>Focus sync recovery sheet</h1>
<small>Created ${esc(opts.createdAt.toLocaleString())}</small>
<p class="warn"><strong>Keep this private and safe</strong> (printed in a drawer, or in a password manager). Anyone with this key and the relay address can read your tasks. If you lose every device <em>and</em> this key, your synced data can’t be recovered — not even by the relay’s owner.</p>
<h2>Sync key</h2>
<p class="key">${esc(opts.key)}</p>
<h2>Relay</h2>
<p><code>${esc(opts.relay)}</code></p>
<div class="qr">${opts.qrSvg}</div>
<h2>To restore on a new device</h2>
<ol>
  <li>Install Focus and open Settings → Sync between devices → <strong>Join from another device</strong>.</li>
  <li>Enter the relay address and the sync key above (or scan the code with the phone’s camera).</li>
  <li>Your tasks, projects and notes download and stay in sync.</li>
</ol>
<button onclick="print()">Print</button>
</body>
</html>`;
}
