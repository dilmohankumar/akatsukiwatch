import { timeline, series, rows, avg, last, kpi, ago } from '../lib/mock.js';

export const meta = {
  id: 'domains',
  name: 'Domains & Uptime',
  icon: 'globe',
  description: 'GoDaddy / registrar domains, DNS, SSL expiry and synthetic uptime checks.',
  monitors: [
    'Domain expiry dates, auto-renew and transfer-lock status',
    'DNS records and nameserver changes',
    'SSL certificate expiry per hostname',
    'HTTP uptime and response time from multiple regions',
    'WHOIS privacy status',
  ],
  credentialFields: [
    { key: 'apiKey', label: 'GoDaddy API key', type: 'text' },
    { key: 'apiSecret', label: 'GoDaddy API secret', type: 'password' },
  ],
  liveApi: 'GoDaddy Domains API (GET /v1/domains) + TLS handshake probe + HTTP check',
};

const days = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export async function dashboard(range) {
  const tl = timeline(range);
  const resp = series(tl, { seed: 'up-ms', base: 190, flat: true, noise: 0.25, spike: 0.03, spikeMul: 3 });
  const regions = {
    mumbai: resp.map((v) => Math.round(v * 0.55)),
    frankfurt: resp,
    virginia: resp.map((v) => Math.round(v * 1.2)),
  };
  const checkDown = series(tl, { seed: 'up-down', base: 0.02, flat: true, noise: 1, spike: 0.01, spikeMul: 3 }).map((v) => (v > 1 ? 1 : 0));
  const up = ((1 - checkDown.reduce((a, b) => a + b, 0) / tl.n) * 100);

  const domainRows = [
    { domain: 'example.com', expires: days(212), left: 212, autoRenew: 'on', ssl: 61, lock: 'locked', dns: 'ok' },
    { domain: 'example.in', expires: days(24), left: 24, autoRenew: 'off', ssl: 61, lock: 'locked', dns: 'ok' },
    { domain: 'mybrand.io', expires: days(340), left: 340, autoRenew: 'on', ssl: 12, lock: 'locked', dns: 'ok' },
    { domain: 'oldproject.net', expires: days(9), left: 9, autoRenew: 'off', ssl: 9, lock: 'unlocked', dns: 'warn' },
  ];

  const expiring = domainRows.filter((d) => d.left < 30).length;
  const sslSoon = domainRows.filter((d) => d.ssl < 14).length;

  return {
    health: { status: expiring || sslSoon ? 'warn' : 'ok', note: `${expiring} expiring, ${up.toFixed(2)}% up` },
    kpis: [
      kpi('Domains', domainRows.length, 'int', null),
      kpi('Expiring < 30 days', expiring, 'int', null, { sub: 'renew or enable auto-renew' }),
      kpi('SSL expiring < 14 days', sslSoon, 'int', null),
      kpi('Uptime', up, 'pct', checkDown.map((d) => (1 - d) * 100), { goodWhen: 'up', mode: 'avg' }),
      kpi('Avg response', avg(resp), 'ms', resp, { goodWhen: 'down', mode: 'avg' }),
    ],
    widgets: [
      { id: 'rt', type: 'line', title: 'Response time by region', span: 12, unit: 'ms', series: Object.keys(regions).map((k) => ({ key: k, label: k })), data: rows(tl, regions) },
      {
        id: 'dom', type: 'table', title: 'Domains', span: 12,
        columns: [{ key: 'domain', label: 'Domain' }, { key: 'expires', label: 'Expires' }, { key: 'left', label: 'Days left', fmt: 'days' }, { key: 'autoRenew', label: 'Auto-renew', fmt: 'status' }, { key: 'ssl', label: 'SSL days left', fmt: 'days' }, { key: 'lock', label: 'Transfer lock', fmt: 'status' }, { key: 'dns', label: 'DNS', fmt: 'status' }],
        rows: domainRows,
      },
      {
        id: 'dns', type: 'table', title: 'DNS records (example.com)', span: 12,
        columns: [{ key: 'type', label: 'Type' }, { key: 'name', label: 'Name' }, { key: 'value', label: 'Value' }, { key: 'ttl', label: 'TTL' }],
        rows: [
          { type: 'A', name: '@', value: '104.21.34.10 (Cloudflare proxy)', ttl: 'Auto' },
          { type: 'CNAME', name: 'www', value: 'example.com', ttl: '1 hour' },
          { type: 'MX', name: '@', value: 'aspmx.l.google.com', ttl: '1 hour' },
          { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all', ttl: '1 hour' },
        ],
      },
    ],
    alerts: [
      { sev: 'crit', msg: 'oldproject.net expires in 9 days with auto-renew OFF and SSL expiring in 9 days', ts: ago(30 * 60e3) },
      { sev: 'warn', msg: 'example.in expires in 24 days with auto-renew OFF', ts: ago(5 * 3600e3) },
    ],
  };
}
