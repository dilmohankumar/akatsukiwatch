import { timeline, series, split, rows, sum, kpi, toplist, ago } from '../lib/mock.js';
import { checkCreds, gql, FILTER_UI } from './cfCore.js';
import { CACHE_COLORS, liveTab } from './cloudflareTabs.js';
export { suggest } from './cloudflareTabs.js';

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
  filterFields: FILTER_UI,
  noFilterTabs: ['dns'],
  tabs: [
    { id: 'requests', label: 'Requests' },
    { id: 'visitors', label: 'Visitors' },
    { id: 'performance', label: 'Performance' },
    { id: 'security', label: 'Security' },
    { id: 'cache', label: 'Cache' },
    { id: 'origin', label: 'Origin' },
    { id: 'dns', label: 'DNS' },
  ],
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
        id: 'cache', type: 'bars', colors: CACHE_COLORS, title: 'Requests by cache status', span: 6, unit: 'int',
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
    ],
  };
}

// Live data: cloudflareTabs.js holds one definition per analytics tab; cfCore.js holds the API access,
// date windows, filters and group-by plumbing.
const VERIFY = 'https://api.cloudflare.com/client/v4/user/tokens/verify';

export async function live(win, creds, opts = {}) {
  return liveTab(opts.tab || 'requests', win, creds, opts);
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
