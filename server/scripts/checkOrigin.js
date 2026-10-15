// Compare the Origin tab numbers with the raw Cloudflare data behind them.
// Usage: CF_API_TOKEN=... CF_ZONE_ID=... node scripts/checkOrigin.js [range]   (range: 24h, 7d, 30d ...)
import { liveTab } from '../src/providers/cloudflareTabs.js';
import { run, windowOf, fragments } from '../src/providers/cfCore.js';

const token = process.env.CF_API_TOKEN;
const zone = process.env.CF_ZONE_ID;
if (!token || !zone) {
  console.error('Set CF_API_TOKEN and CF_ZONE_ID');
  process.exit(1);
}
const win = windowOf({ range: process.argv[2] || '30d' });

const app = await liveTab('origin', win, { apiToken: token, zoneId: zone }, {});
console.log(`\nApp (Origin tab, ${win.key}):`);
for (const k of app.kpis) console.log(`  ${k.label.padEnd(24)} ${k.display ?? k.value}`);

const H = fragments();
const z = await run(token, zone, [H.HG('raw', 'originResponseStatus edgeResponseStatus', { limit: 1000, sel: 'count sum{edgeResponseBytes}' })], win.start, win.end);
const rows = z.raw || [];
const sum = (f, g = (r) => r.count) => rows.filter(f).reduce((a, r) => a + g(r), 0);
const bytes = (r) => r.sum?.edgeResponseBytes || 0;
const noOrigin = (r) => r.dimensions.originResponseStatus === 0;

console.log('\nRaw Cloudflare (eyeball requests):');
console.log(`  reached origin (originStatus != 0)   ${sum((r) => !noOrigin(r))}   bytes ${(sum((r) => !noOrigin(r), bytes) / 1e6).toFixed(2)} MB`);
console.log('  never reached origin, by edge status:');
const by = new Map();
for (const r of rows.filter(noOrigin)) by.set(r.dimensions.edgeResponseStatus, (by.get(r.dimensions.edgeResponseStatus) || 0) + r.count);
for (const [s, n] of [...by].sort((a, b) => a[0] - b[0])) if (s >= 500) console.log(`    edge ${s}: ${n}`);
