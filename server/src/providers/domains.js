import dns from 'node:dns/promises';
import tls from 'node:tls';
import { timeline, series, rows, avg, last, kpi, ago } from '../lib/mock.js';

export const meta = {
  id: 'domains',
  name: 'Domains & Uptime',
  icon: 'globe',
  description: 'Domain expiry, SSL certificate expiry, DNS and HTTP uptime checks for the domains you list.',
  monitors: [
    'Domain expiry date and transfer-lock status (from the public RDAP registry)',
    'SSL certificate expiry per domain',
    'DNS: does the domain resolve',
    'HTTP status and response time',
    'Uptime since the server started',
  ],
  credentialFields: [
    { key: 'domains', label: 'Domains to monitor (comma separated, e.g. example.com, mybrand.io)', type: 'text' },
  ],
  liveApi: 'RDAP (domain registry) + TLS handshake + DNS lookup + HTTPS request. No API key needed.',
};

// ---- live checks ---------------------------------------------------------------------------------
const history = new Map(); // domain -> [{ t, up, ms }] kept in memory since the server started
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parseDomains(raw) {
  const list = String(raw || '')
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, ''))
    .filter(Boolean);
  const bad = list.filter((d) => !HOST.test(d));
  if (bad.length) throw new Error(`Not a valid domain name: ${bad.slice(0, 3).join(', ')}`);
  return [...new Set(list)].slice(0, 20);
}

const isPrivate = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/i.test(ip);

async function dnsCheck(domain) {
  try {
    const rec = await dns.lookup(domain, { all: true });
    if (!rec.length) return { ok: false };
    return { ok: true, private: rec.some((r) => isPrivate(r.address)) };
  } catch {
    return { ok: false };
  }
}

function sslCheck(domain) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: domain, port: 443, servername: domain, timeout: 8000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c?.valid_to ? { left: Math.floor((Date.parse(c.valid_to) - Date.now()) / 864e5), valid: sock.authorized } : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function httpCheck(domain) {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${domain}`, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'AkatsukiWatch-uptime/1.0' } });
    await r.body?.cancel();
    return { up: r.status < 500, code: r.status, ms: Date.now() - t0 };
  } catch {
    return { up: false, code: 0, ms: Date.now() - t0 };
  }
}

// rdap.org blocks scripted requests, so the registry for each TLD is looked up in IANA's own bootstrap file.
let bootstrap = { at: 0, map: new Map() };
async function rdapBase(tld) {
  if (Date.now() - bootstrap.at > 864e5 || !bootstrap.map.size) {
    const r = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    const map = new Map();
    for (const [tlds, urls] of j.services || []) for (const t of tlds) map.set(t.toLowerCase(), urls.find((u) => u.startsWith('https://')) || urls[0]);
    bootstrap = { at: Date.now(), map };
  }
  return bootstrap.map.get(tld);
}

async function rdapCheck(domain) {
  try {
    const base = await rdapBase(domain.split('.').pop());
    if (!base) return null;
    const r = await fetch(`${base.replace(/\/?$/, '/')}domain/${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/rdap+json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const exp = (j.events || []).find((e) => e.eventAction === 'expiration')?.eventDate;
    const status = (j.status || []).join(' ').toLowerCase();
    return { expires: exp ? exp.slice(0, 10) : null, left: exp ? Math.floor((Date.parse(exp) - Date.now()) / 864e5) : null, locked: /transfer prohibited/.test(status) };
  } catch {
    return null;
  }
}

export async function live(win, creds) {
  const list = parseDomains(creds?.domains);
  if (!list.length) throw new Error('Add at least one domain to monitor');
  const rows = await Promise.all(
    list.map(async (domain) => {
      const d = await dnsCheck(domain);
      if (d.ok && d.private) return { domain, up: 'down', http: 'private address (skipped)', ms: null, expires: '—', left: null, ssl: null, lock: '—', dns: 'warn' };
      const [h, ssl, rd] = d.ok ? await Promise.all([httpCheck(domain), sslCheck(domain), rdapCheck(domain)]) : [{ up: false, code: 0, ms: null }, null, await rdapCheck(domain)];
      const hist = history.get(domain) || [];
      hist.push({ t: Date.now(), up: h.up, ms: h.ms });
      history.set(domain, hist.slice(-1000));
      return { domain, up: h.up ? 'up' : 'down', http: h.code || 'no response', ms: h.ms, expires: rd?.expires || 'unknown', left: rd?.left ?? null, ssl: ssl?.left ?? null, lock: rd ? (rd.locked ? 'locked' : 'unlocked') : '—', dns: d.ok ? 'ok' : 'failed' };
    }),
  );
  const all = list.flatMap((d) => history.get(d) || []);
  const upPct = all.length ? (all.filter((x) => x.up).length / all.length) * 100 : 0;
  const msVals = rows.map((r) => r.ms).filter((v) => v != null && v > 0);
  const expiring = rows.filter((r) => r.left != null && r.left < 30).length;
  const sslSoon = rows.filter((r) => r.ssl != null && r.ssl < 14).length;
  const down = rows.filter((r) => r.up !== 'up').length;
  const k = (label, value, fmt, sub) => ({ label, value, fmt, delta: null, tone: 'neutral', spark: null, sub, empty: false, basis: 'previous' });
  return {
    health: { status: down || sslSoon ? 'crit' : expiring ? 'warn' : 'ok', note: down ? `${down} down` : `${expiring} expiring` },
    kpis: [
      k('Domains', rows.length, 'int'),
      k('Expiring < 30 days', expiring, 'int'),
      k('SSL expiring < 14 days', sslSoon, 'int'),
      k('Uptime', +upPct.toFixed(2), 'pct', 'since this server started'),
      k('Avg response', msVals.length ? msVals.reduce((a, b) => a + b, 0) / msVals.length : 0, 'ms'),
    ],
    widgets: [
      {
        id: 'dom', type: 'table', title: 'Domains', span: 12,
        columns: [{ key: 'domain', label: 'Domain' }, { key: 'up', label: 'Status', fmt: 'status' }, { key: 'http', label: 'HTTP' }, { key: 'ms', label: 'Response', fmt: 'ms' }, { key: 'expires', label: 'Expires' }, { key: 'left', label: 'Days left', fmt: 'days' }, { key: 'ssl', label: 'SSL days left', fmt: 'days' }, { key: 'lock', label: 'Transfer lock', fmt: 'status' }, { key: 'dns', label: 'DNS', fmt: 'status' }],
        rows,
      },
    ],
    alerts: [],
  };
}

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
