import { timeline, series, split, rows, sum, kpi, toplist, ago } from '../lib/mock.js';

export const meta = {
  id: 'cloudflare',
  name: 'Cloudflare',
  icon: 'cloud',
  description: 'Edge traffic, caching, security and origin health for your zones.',
  monitors: [
    'Requests, bandwidth, unique visitors over time',
    'Status codes (2xx/3xx/4xx/5xx) and 5xx error rate',
    'Cache status: hit / miss / dynamic / revalidated',
    'Top paths, hosts, countries, client IPs',
    'WAF / bot / rate-limit events, DDoS mitigations',
    'Origin response time, Workers errors',
  ],
  credentialFields: [
    { key: 'apiToken', label: 'API token (Analytics:Read)', type: 'password' },
    { key: 'zoneId', label: 'Zone ID', type: 'text' },
  ],
  liveApi: 'Cloudflare GraphQL Analytics API (httpRequestsAdaptiveGroups)',
};

export async function dashboard(range) {
  const tl = timeline(range);
  const req = series(tl, { seed: 'cf-req', base: 9, spike: 0.03, spikeMul: 9 });
  const bytes = req.map((v, i) => Math.round(v * (3500 + ((i * 7919) % 2500))));
  const visits = series(tl, { seed: 'cf-visits', base: 0.9, noise: 0.5, spike: 0.05, spikeMul: 3 });
  const status = split(tl, req, { '2xx': 0.28, '3xx': 0.13, '4xx': 0.58, '5xx': 0.004 }, 'cf-status');
  const cache = split(tl, req, { Dynamic: 0.76, Miss: 0.08, None: 0.06, Hit: 0.07, Revalidated: 0.03 }, 'cf-cache');
  const totalReq = sum(req);
  const hit = sum(cache.Hit) + sum(cache.Revalidated);
  const hitRate = (hit / totalReq) * 100;
  const err5 = (sum(status['5xx']) / totalReq) * 100;
  const hitSeries = req.map((_, i) => ((cache.Hit[i] + cache.Revalidated[i]) / (req[i] || 1)) * 100);

  return {
    health: { status: err5 > 1 ? 'crit' : err5 > 0.2 ? 'warn' : 'ok', note: `${err5.toFixed(2)}% 5xx` },
    kpis: [
      kpi('Total requests', totalReq, 'count', req, { goodWhen: 'up' }),
      kpi('Total data transfer', sum(bytes), 'bytes', bytes, { goodWhen: 'up' }),
      kpi('Total visits', sum(visits), 'count', visits, { goodWhen: 'up' }),
      kpi('Cache hit rate', hitRate, 'pct', hitSeries, { goodWhen: 'up', mode: 'avg' }),
      kpi('5xx error rate', err5, 'pct', status['5xx'], { goodWhen: 'down' }),
    ],
    widgets: [
      { id: 'req', type: 'line', title: 'Requests over time', span: 6, unit: 'int', series: [{ key: 'req', label: 'Requests' }], data: rows(tl, { req }) },
      { id: 'bw', type: 'line', title: 'Data transfer', span: 6, unit: 'bytes', series: [{ key: 'bytes', label: 'Data transfer' }], data: rows(tl, { bytes }) },
      {
        id: 'status', type: 'bars', title: 'Requests by status code', span: 6, unit: 'int',
        series: ['2xx', '3xx', '4xx', '5xx'].map((k) => ({ key: k, label: k })), data: rows(tl, status),
      },
      {
        id: 'cache', type: 'bars', title: 'Requests by cache status', span: 6, unit: 'int',
        series: ['Dynamic', 'Miss', 'None', 'Hit', 'Revalidated'].map((k) => ({ key: k, label: k })), data: rows(tl, cache),
      },
      { id: 'paths', type: 'toplist', title: 'Top paths', span: 6, items: toplist('cf-paths', ['/', '/cdn-cgi/rum', '/favicon.ico', '/assets/index.js', '/api/board/next-price', '/api/board', '/assets/index.css', '/assets/logo.png', '/.credentials', '//site/wp-includes/wlwmanifest.xml'], totalReq * 0.55) },
      { id: 'countries', type: 'toplist', title: 'Top countries', span: 6, items: toplist('cf-cc', ['Netherlands', 'United States', 'Singapore', 'India', 'United Kingdom', 'China', 'Japan', 'Germany', 'Indonesia', 'Switzerland'], totalReq * 0.9, 1.3) },
      { id: 'ips', type: 'toplist', title: 'Top client IPs', span: 6, items: toplist('cf-ip', ['195.178.110.94', '122.164.126.53', '167.172.64.214', '103.253.145.143', '34.208.194.0', '81.171.72.135', '178.128.117.117', '35.85.76.34', '54.187.174.169', '2409:4055:2e06:996c::e7b9'], totalReq * 0.75, 1.4) },
      { id: 'hosts', type: 'toplist', title: 'Top hosts', span: 6, items: toplist('cf-host', ['example.com', 'www.example.com', 'example.com:443', 'www.example.com:443', 'example.com:2095', 'example.com:2082', 'example.com:8880', 'example.com:8080'], totalReq, 2.2) },
      {
        id: 'sec', type: 'table', title: 'Security events (WAF / bots)', span: 12,
        columns: [{ key: 'time', label: 'Time', fmt: 'ago' }, { key: 'action', label: 'Action' }, { key: 'rule', label: 'Rule' }, { key: 'ip', label: 'Client IP' }, { key: 'path', label: 'Path' }],
        rows: [
          { time: ago(4 * 60e3), action: 'Block', rule: 'WAF: probing sensitive files', ip: '195.178.110.94', path: '/.credentials' },
          { time: ago(11 * 60e3), action: 'Challenge', rule: 'Bot score < 10', ip: '167.172.64.214', path: '/wp-login.php' },
          { time: ago(26 * 60e3), action: 'Block', rule: 'WAF: WordPress scan', ip: '195.178.110.94', path: '//site/wp-includes/wlwmanifest.xml' },
          { time: ago(52 * 60e3), action: 'Rate limit', rule: '100 req / 10s per IP', ip: '34.208.194.0', path: '/api/board' },
        ],
      },
    ],
    alerts: [
      { sev: 'warn', msg: 'One IP (195.178.110.94) generated 35% of 4xx traffic — consider a rate-limit rule', ts: ago(9 * 60e3) },
      { sev: 'info', msg: 'Cache hit rate is low (<10%) — static assets may be missing Cache-Control headers', ts: ago(3 * 3600e3) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Live adapter: Cloudflare GraphQL Analytics API (zone-level httpRequestsAdaptiveGroups).
// Needs a user API token with Zone > Analytics > Read for the zone.
// ---------------------------------------------------------------------------
const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const VERIFY = 'https://api.cloudflare.com/client/v4/user/tokens/verify';

// range -> [time dimension, bucket size ms, window ms]
const DIMS = {
  '1h': ['datetimeMinute', 60e3, 3600e3],
  '6h': ['datetimeFiveMinutes', 300e3, 6 * 3600e3],
  '24h': ['datetimeHour', 3600e3, 864e5],
  '7d': ['datetimeHour', 3600e3, 7 * 864e5],
  '30d': ['date', 864e5, 30 * 864e5],
};

const CACHE_LABEL = { hit: 'Hit', miss: 'Miss', dynamic: 'Dynamic', revalidated: 'Revalidated', none: 'None', unknown: 'None' };
const cache = new Map(); // short TTL so 15s polling doesn't hammer Cloudflare's rate limits

function checkCreds(creds) {
  const token = String(creds?.apiToken || '').trim();
  const zone = String(creds?.zoneId || '').trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('API token looks invalid (unexpected characters)');
  if (!/^[a-f0-9]{32}$/i.test(zone)) throw new Error('Zone ID must be 32 hex characters');
  return { token, zone };
}

async function gql(token, query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Cloudflare rejected the token (check it is active and has Analytics:Read)');
  if (!res.ok) throw new Error(`Cloudflare API returned ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    const m = json.errors[0].message;
    throw new Error(/time|range|retention|limit/i.test(m) ? `${m} — your Cloudflare plan may limit analytics history; try a shorter range` : m);
  }
  return json.data;
}

// requestSource "eyeball" = real client requests. Without it, Worker-initiated fetches (edgeWorkerFetch) are
// counted too, which inflates totals by ~15% versus the Cloudflare dashboard.
const buildQuery = (dim) => `query($zone:String!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){
  series: httpRequestsAdaptiveGroups(limit:10000, filter:{datetime_geq:$start,datetime_leq:$end,requestSource:"eyeball"}, orderBy:[${dim}_ASC]){
    count sum{edgeResponseBytes visits} dimensions{${dim} edgeResponseStatus cacheStatus}}
  paths: httpRequestsAdaptiveGroups(limit:10, filter:{datetime_geq:$start,datetime_leq:$end,requestSource:"eyeball"}, orderBy:[count_DESC]){count dimensions{clientRequestPath}}
  countries: httpRequestsAdaptiveGroups(limit:10, filter:{datetime_geq:$start,datetime_leq:$end,requestSource:"eyeball"}, orderBy:[count_DESC]){count dimensions{clientCountryName}}
  ips: httpRequestsAdaptiveGroups(limit:10, filter:{datetime_geq:$start,datetime_leq:$end,requestSource:"eyeball"}, orderBy:[count_DESC]){count dimensions{clientIP}}
  hosts: httpRequestsAdaptiveGroups(limit:10, filter:{datetime_geq:$start,datetime_leq:$end,requestSource:"eyeball"}, orderBy:[count_DESC]){count dimensions{clientRequestHTTPHost}}
}}}`;

const top = (rows, key) => (rows || []).map((r) => ({ label: r.dimensions[key] || '(none)', value: r.count }));

const prevQuery = `query($zone:String!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){
  prev: httpRequestsAdaptiveGroups(limit:10000, filter:{datetime_geq:$start,datetime_lt:$end,requestSource:"eyeball"}){
    count sum{edgeResponseBytes visits} dimensions{edgeResponseStatus cacheStatus}}
}}}`;

// Totals for the period right before the selected one, so deltas match the Cloudflare dashboard
// ("change vs previous period"). Returns null when unavailable (e.g. plan retention) -> no delta shown.
async function previousTotals(token, zone, range, windowMs) {
  const ck = `${zone}:${range}:prev`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 300_000) return hit.t;
  let t = null;
  try {
    const now = Date.now();
    const data = await gql(token, prevQuery, { zone, start: new Date(now - 2 * windowMs).toISOString(), end: new Date(now - windowMs).toISOString() });
    const rows = data?.viewer?.zones?.[0]?.prev;
    if (rows) {
      t = { req: 0, bytes: 0, visits: 0, hit: 0, five: 0 };
      for (const g of rows) {
        t.req += g.count;
        t.bytes += g.sum.edgeResponseBytes || 0;
        t.visits += g.sum.visits || 0;
        if (['hit', 'revalidated'].includes(g.dimensions.cacheStatus)) t.hit += g.count;
        if (Math.floor((g.dimensions.edgeResponseStatus || 0) / 100) === 5) t.five += g.count;
      }
    }
  } catch {
    t = null;
  }
  cache.set(ck, { at: Date.now(), t });
  return t;
}

// Relative % change like the Cloudflare dashboard: prev=0 and now>0 -> +100%, both 0 -> no delta.
const change = (cur, prev) => (prev == null ? null : prev === 0 ? (cur > 0 ? 100 : null) : +(((cur - prev) / prev) * 100).toFixed(1));

export async function live(range, creds) {
  const { token, zone } = checkCreds(creds);
  const [dim, step, windowMs] = DIMS[range] || DIMS['24h'];
  const ck = `${zone}:${range}`;
  const hit = cache.get(ck);
  let z;
  if (hit && Date.now() - hit.at < 30_000) z = hit.z;
  else {
    const end = new Date();
    const data = await gql(token, buildQuery(dim), { zone, start: new Date(end - windowMs).toISOString(), end: end.toISOString() });
    z = data?.viewer?.zones?.[0];
    if (!z) throw new Error('Zone not found, or the token has no Analytics:Read access to this zone');
    cache.set(ck, { at: Date.now(), z });
  }

  const tsOf = (v) => (dim === 'date' ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v));
  const first = Math.floor((Date.now() - windowMs) / step) * step;
  const b = new Map();
  for (let t = first; t <= Date.now(); t += step) b.set(t, { t, req: 0, bytes: 0, visits: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, Dynamic: 0, Miss: 0, None: 0, Hit: 0, Revalidated: 0, Other: 0 });
  for (const g of z.series) {
    const row = b.get(Math.floor(tsOf(g.dimensions[dim]) / step) * step);
    if (!row) continue;
    row.req += g.count;
    row.bytes += g.sum.edgeResponseBytes || 0;
    row.visits += g.sum.visits || 0;
    const cls = Math.floor((g.dimensions.edgeResponseStatus || 0) / 100);
    if (cls >= 2 && cls <= 5) row[`${cls}xx`] += g.count;
    row[CACHE_LABEL[g.dimensions.cacheStatus] || 'Other'] += g.count;
  }
  const data = [...b.values()];
  const col = (k) => data.map((d) => d[k]);
  const totalReq = sum(col('req'));
  const hitRate = totalReq ? ((sum(col('Hit')) + sum(col('Revalidated'))) / totalReq) * 100 : 0;
  const err5 = totalReq ? (sum(col('5xx')) / totalReq) * 100 : 0;
  const hitSeries = data.map((d) => (d.req ? ((d.Hit + d.Revalidated) / d.req) * 100 : 0));
  const prev = await previousTotals(token, zone, range, windowMs);
  const prevHitRate = prev && prev.req ? (prev.hit / prev.req) * 100 : prev ? 0 : null;
  const prevErr5 = prev && prev.req ? (prev.five / prev.req) * 100 : prev ? 0 : null;
  const cacheKeys = ['Dynamic', 'Miss', 'None', 'Hit', 'Revalidated', ...(sum(col('Other')) ? ['Other'] : [])];

  const alerts = [];
  if (err5 > 1) alerts.push({ sev: 'crit', msg: `5xx error rate is ${err5.toFixed(2)}% — your origin may be failing`, ts: Date.now() });
  else if (err5 > 0.2) alerts.push({ sev: 'warn', msg: `5xx error rate is ${err5.toFixed(2)}%`, ts: Date.now() });
  if (totalReq > 200 && hitRate < 10) alerts.push({ sev: 'info', msg: 'Cache hit rate is low (<10%) — static assets may be missing Cache-Control headers', ts: Date.now() });

  return {
    health: { status: err5 > 1 ? 'crit' : err5 > 0.2 ? 'warn' : 'ok', note: `${err5.toFixed(2)}% 5xx` },
    kpis: [
      kpi('Total requests', totalReq, 'count', col('req'), { goodWhen: 'up', delta: change(totalReq, prev?.req) }),
      kpi('Total data transfer', sum(col('bytes')), 'bytes', col('bytes'), { goodWhen: 'up', delta: change(sum(col('bytes')), prev?.bytes) }),
      kpi('Total visits', sum(col('visits')), 'count', col('visits'), { goodWhen: 'up', delta: change(sum(col('visits')), prev?.visits) }),
      kpi('Cache hit rate', hitRate, 'pct', hitSeries, { goodWhen: 'up', mode: 'avg', delta: change(hitRate, prevHitRate) }),
      kpi('5xx error rate', err5, 'pct', col('5xx'), { goodWhen: 'down', delta: change(err5, prevErr5) }),
    ],
    widgets: [
      { id: 'req', type: 'line', title: 'Requests over time', span: 6, unit: 'int', series: [{ key: 'req', label: 'Requests' }], data },
      { id: 'bw', type: 'line', title: 'Data transfer', span: 6, unit: 'bytes', series: [{ key: 'bytes', label: 'Data transfer' }], data },
      { id: 'status', type: 'bars', title: 'Requests by status code', span: 6, unit: 'int', series: ['2xx', '3xx', '4xx', '5xx'].map((k) => ({ key: k, label: k })), data },
      { id: 'cache', type: 'bars', title: 'Requests by cache status', span: 6, unit: 'int', series: cacheKeys.map((k) => ({ key: k, label: k })), data },
      { id: 'paths', type: 'toplist', title: 'Top paths', span: 6, items: top(z.paths, 'clientRequestPath') },
      { id: 'countries', type: 'toplist', title: 'Top countries', span: 6, items: top(z.countries, 'clientCountryName') },
      { id: 'ips', type: 'toplist', title: 'Top client IPs', span: 6, items: top(z.ips, 'clientIP') },
      { id: 'hosts', type: 'toplist', title: 'Top hosts', span: 6, items: top(z.hosts, 'clientRequestHTTPHost') },
    ],
    alerts,
  };
}

export async function testConnection(creds) {
  const { token, zone } = checkCreds(creds);
  const v = await fetch(VERIFY, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const vj = await v.json().catch(() => ({}));
  if (!vj.success || vj.result?.status !== 'active') return { ok: false, message: 'Cloudflare says this token is not valid or not active (note: only user API tokens, starting with cfut_, are supported here)' };
  const data = await gql(token, 'query($zone:String!){viewer{zones(filter:{zoneTag:$zone}){zoneTag}}}', { zone });
  if (!data?.viewer?.zones?.length) return { ok: false, message: 'Token is valid, but has no Analytics:Read access to this Zone ID (wrong zone, or permission missing)' };
  return { ok: true, message: 'Connected. Live Cloudflare analytics enabled for this zone.' };
}
