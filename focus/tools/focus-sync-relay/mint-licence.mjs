#!/usr/bin/env node
// Mint a sync licence for a hosted relay that has LICENCE_SECRET set.
//   LICENCE_SECRET=... node mint-licence.mjs <licence-id> [days-valid | 0 for never]
// Give the printed licence to the customer; they paste it into Focus → Settings → Sync.
import { createHmac } from 'node:crypto';

const [id, days = '365'] = process.argv.slice(2);
const secret = process.env.LICENCE_SECRET;
if (!secret || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^\d+$/.test(days)) {
  console.error('Usage: LICENCE_SECRET=... node mint-licence.mjs <id: letters, digits, _ or -> [days, 0 = never expires]');
  process.exit(1);
}
const expires = Number(days) === 0 ? 0 : Math.floor(Date.now() / 1000) + Number(days) * 86400;
const sig = createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex');
console.log(`${id}.${expires}.${sig}`);
