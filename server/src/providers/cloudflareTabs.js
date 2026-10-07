// Live data for every Cloudflare analytics tab: Requests, Visitors, Performance, Security, Cache, Origin, DNS.
// Every definition was matched against the Cloudflare dashboard (same zone, same window):
//   pageview       = HTML response with status 200
//   mitigated      = securityAction != "unknown"
//   cached         = cacheStatus in (hit, revalidated)
//   to origin      = originResponseStatus != 0   (+ edge 522/523/524 counted as connection failures)
//   served by orig = to origin and not revalidated; served by Cloudflare = everything else not mitigated
import { kpi } from '../lib/mock.js';
import { cache, checkCreds, run, tline, fragments, DG, parseFilters, parseGroups, GROUPS, GROUP_OPTIONS, groupColors, statusLabel, countryName, coloName, cap, litOf, FIELDS, staticSuggestions } from './cfCore.js';

const change = (cur, prev) => (prev == null ? null : prev === 0 ? (cur > 0 ? 100 : null) : +(((cur - prev) / prev) * 100).toFixed(1));

// ---- shaping helpers ----------------------------------------------------------------------
/** rows -> stacked time series, top `max` keys + "Other". */
function pivot(tl, rows, keyOf, valOf, max = 4) {
  const totals = new Map();
  for (const r of rows || []) totals.set(keyOf(r), (totals.get(keyOf(r)) || 0) + valOf(r));
  const keys = [...totals].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const shown = keys.slice(0, max);
  const names = keys.length > max ? [...shown, 'Other'] : shown;
  const at = new Map(tl.ts.map((t, i) => [t, i]));
  const data = tl.ts.map((t) => ({ t, ...Object.fromEntries(names.map((k) => [k, 0])) }));
  for (const r of rows || []) {
    const i = at.get(tl.bucket(r.dimensions[tl.dim]));
    if (i == null) continue;
    const k = shown.includes(keyOf(r)) ? keyOf(r) : 'Other';
    data[i][k] += valOf(r);
  }
  return { series: names.map((k) => ({ key: k, label: k })), data };
}

/** rows -> one value per bucket for several named series. */
function lines(tl, rows, defs) {
  const at = new Map(tl.ts.map((t, i) => [t, i]));
  const data = tl.ts.map((t) => ({ t, ...Object.fromEntries(defs.map((d) => [d.key, 0])) }));
  for (const r of rows || []) {
    const i = at.get(tl.bucket(r.dimensions[tl.dim]));
    if (i == null) continue;
    for (const d of defs) data[i][d.key] += d.val(r);
  }
  return { series: defs.map((d) => ({ key: d.key, label: d.label })), data };
}

const toplist = (rows, keyOf, valOf = (r) => r.count, n = 12) => {
  const m = new Map();
  for (const r of rows || []) m.set(keyOf(r), (m.get(keyOf(r)) || 0) + valOf(r));
  return [...m].map(([label, value]) => ({ label: String(label), value })).sort((a, b) => b.value - a.value).slice(0, n);
};

const PRODUCT = { firewallManaged: 'Managed rules', bic: 'Browser integrity check', firewallCustom: 'Custom rules', firewallRateLimit: 'Rate limiting rules', rateLimit: 'Rate limiting rules', l7ddos: 'HTTP DDoS protection', waf: 'WAF', securityLevel: 'Security level', hot: 'Hotlink protection', uaBlock: 'User agent blocking', zoneLockdown: 'Zone lockdown', ip: 'IP access rules', unknown: 'Unknown' };
const CACHED = ['hit', 'revalidated'];
const PV = ',edgeResponseContentTypeName:"html",edgeResponseStatus:200'; // a "pageview"
const CACHE_LABEL = { hit: 'Hit', miss: 'Miss', dynamic: 'Dynamic', revalidated: 'Revalidated', none: 'None', unknown: 'None' };
export const CACHE_COLORS = { Dynamic: 'var(--s1)', Miss: 'var(--s3)', None: 'var(--s4)', Hit: 'var(--s2)', Revalidated: 'var(--s5)', Expired: 'var(--muted)', Other: 'var(--muted)' };
const UNKNOWN = (x) => (!x || x === 'Unknown' ? 'Unknown/Others' : x);

const num = (v) => v || 0;
const sumBy = (rows, pred, val = (r) => r.count) => (rows || []).filter(pred).reduce((a, r) => a + val(r), 0);
const bytesOf = (r) => num(r.sum?.edgeResponseBytes);
const visitsOf = (r) => num(r.sum?.visits);
const Q3 = 'quantiles{originResponseDurationMsP50 originResponseDurationMsP95 originResponseDurationMsP99}';

// ---- "Group by": top-5 values of a dimension, then one series per value ------------------------
async function groupedSeries(ctx, groupId, { metric, extra = '', order = 'count_DESC' }) {
  const g = GROUPS[groupId];
  const { token, zone, tl, H } = ctx;
  // the top 5 are picked by the same measure the chart shows (requests, bytes or visits)
  const top = (await run(token, zone, [H.HG('top', g.dim, { limit: 5, extra, order, sel: 'count sum{edgeResponseBytes visits}' })], tl.start, tl.end)).top;
  const vals = top.map((r) => r.dimensions[g.dim]);
  if (!vals.length) return { series: [], data: tl.ts.map((t) => ({ t })), colors: {} };
  const z = await run(token, zone, [H.HG('gs', `${tl.dim} ${g.dim}`, { limit: 10000, order: `${tl.dim}_ASC`, extra: `${extra},${g.dim}_in:[${vals.map(litOf).join(',')}]`, sel: 'count sum{edgeResponseBytes visits}' })], tl.start, tl.end);
  const label = (v) => (g.name ? g.name(v) : String(v ?? 'Unknown'));
  const keys = [...new Set(vals.map(label))];
  const raws = {};
  for (const v of vals) raws[label(v)] = String(v ?? '');
  const at = new Map(tl.ts.map((t, i) => [t, i]));
  const data = tl.ts.map((t) => ({ t, ...Object.fromEntries(keys.map((k) => [k, 0])) }));
  for (const r of z.gs) {
    const i = at.get(tl.bucket(r.dimensions[tl.dim]));
    if (i != null) data[i][label(r.dimensions[g.dim])] += metric(r);
  }
  return { series: keys.map((k) => ({ key: k, label: k })), data, colors: groupColors(keys), raws };
}

/** Marks a chart as "groupable" and swaps in the grouped series when the user picked one. */
async function maybeGroup(ctx, widget, opts) {
  const gid = ctx.groups[widget.id];
  const base = { ...widget, groupable: true, groupOptions: GROUP_OPTIONS, group: gid || 'none' };
  if (!gid) return base;
  const gs = await groupedSeries(ctx, gid, opts);
  return { ...base, type: 'line', series: gs.series, data: gs.data, colors: gs.colors, filterField: GROUPS[gid].field, rawBy: gs.raws };
}

const heading = (id, title) => ({ id, type: 'heading', title, span: 12 });

// ---- tab definitions ----------------------------------------------------------------------
// kf: fragments for the KPI cards (run for the current AND previous period -> deltas)
// kd: KPI definitions   bf: fragments for the charts/lists (current period only)
// widgets(z, tl, ctx): async, returns { widgets, sparks, meta? }
const TOP_TECH = (z, valOf) => [
  { id: 'os', type: 'toplist', title: 'Top operating systems', span: 6, unit: 'count', items: toplist(z.os, (r) => UNKNOWN(r.dimensions.userAgentOS), valOf) },
  { id: 'br', type: 'toplist', title: 'Top browsers', span: 6, unit: 'count', items: toplist(z.br, (r) => UNKNOWN(r.dimensions.userAgentBrowser), valOf) },
  { id: 'ua', type: 'toplist', title: 'Top user agents', span: 12, unit: 'count', items: toplist(z.ua, (r) => r.dimensions.userAgent || 'Unknown', valOf) },
];

export const TABS = {
  requests: {
    kf: (tl, H) => [H.HG('kc', 'edgeResponseStatus cacheStatus', { limit: 300, sel: 'count sum{edgeResponseBytes visits}' })],
    kd: (() => {
      const tot = (z) => sumBy(z.kc, () => true);
      const hit = (z) => sumBy(z.kc, (r) => CACHED.includes(r.dimensions.cacheStatus));
      return [
        { label: 'Total requests', fmt: 'count', good: 'up', val: tot },
        { label: 'Total data transfer', fmt: 'bytes', good: 'up', val: (z) => sumBy(z.kc, () => true, bytesOf) },
        { label: 'Total visits', fmt: 'count', good: 'up', val: (z) => sumBy(z.kc, () => true, visitsOf) },
        { label: 'Cache hit rate', fmt: 'pct', good: 'up', val: (z) => (tot(z) ? (hit(z) / tot(z)) * 100 : 0) },
        { label: '5xx error rate', fmt: 'pct', good: 'down', val: (z) => (tot(z) ? (sumBy(z.kc, (r) => Math.floor(r.dimensions.edgeResponseStatus / 100) === 5) / tot(z)) * 100 : 0) },
      ];
    })(),
    bf: (tl, H) => {
      const L = { limit: 12 };
      return [
        H.HG('s', `${tl.dim} edgeResponseStatus cacheStatus`, { limit: 10000, order: `${tl.dim}_ASC`, sel: 'count sum{edgeResponseBytes visits}' }),
        H.HG('paths', 'clientRequestPath', L),
        H.HG('cc', 'clientCountryName', L),
        H.HG('ips', 'clientIP', L),
        H.HG('hosts', 'clientRequestHTTPHost', L),
        H.HG('br', 'userAgentBrowser', L),
        H.HG('os', 'userAgentOS', L),
        H.HG('dev', 'clientDeviceType', L),
        H.HG('ua', 'userAgent', L),
        H.HG('proto', 'clientRequestHTTPProtocol', L),
        H.HG('codes', 'edgeResponseStatus', L),
        H.HG('colo', 'coloCode', L),
      ];
    },
    widgets: async (z, tl, ctx) => {
      const cls = (r) => Math.floor((r.dimensions.edgeResponseStatus || 0) / 100);
      const cl = (k) => (r) => ((CACHE_LABEL[r.dimensions.cacheStatus] || 'Other') === k ? r.count : 0);
      const req = lines(tl, z.s, [{ key: 'req', label: 'Requests', val: (r) => r.count }]);
      const bw = lines(tl, z.s, [{ key: 'bytes', label: 'Data transfer', val: bytesOf }]);
      const status = lines(tl, z.s, [2, 3, 4, 5].map((n) => ({ key: `${n}xx`, label: `${n}xx`, val: (r) => (cls(r) === n ? r.count : 0) })));
      const hasOther = sumBy(z.s, (r) => !CACHE_LABEL[r.dimensions.cacheStatus]) > 0;
      const cacheKeys = ['Dynamic', 'Miss', 'None', 'Hit', 'Revalidated', ...(hasOther ? ['Other'] : [])];
      const cacheS = lines(tl, z.s, cacheKeys.map((k) => ({ key: k, label: k, val: cl(k) })));
      const tot = sumBy(z.s, () => true);
      const err5 = tot ? (sumBy(z.s, (r) => cls(r) === 5) / tot) * 100 : 0;
      const hitRate = tot ? (sumBy(z.s, (r) => CACHED.includes(r.dimensions.cacheStatus)) / tot) * 100 : 0;
      const alerts = [];
      if (err5 > 1) alerts.push({ sev: 'crit', msg: `5xx error rate is ${err5.toFixed(2)}% — your origin may be failing`, ts: Date.now() });
      else if (err5 > 0.2) alerts.push({ sev: 'warn', msg: `5xx error rate is ${err5.toFixed(2)}%`, ts: Date.now() });
      return {
        sparks: {
          'Total requests': req.data.map((d) => d.req),
          'Total data transfer': bw.data.map((d) => d.bytes),
          'Total visits': lines(tl, z.s, [{ key: 'v', label: 'v', val: visitsOf }]).data.map((d) => d.v),
          'Cache hit rate': cacheS.data.map((d, i) => (req.data[i].req ? ((d.Hit + d.Revalidated) / req.data[i].req) * 100 : 0)),
          '5xx error rate': status.data.map((d) => d['5xx']),
        },
        meta: { health: { status: err5 > 1 ? 'crit' : err5 > 0.2 ? 'warn' : 'ok', note: `${err5.toFixed(2)}% 5xx` }, alerts },
        widgets: [
          await maybeGroup(ctx, { id: 'req', type: 'line', title: 'Requests over time', span: 6, unit: 'count', ...req }, { metric: (r) => r.count }),
          await maybeGroup(ctx, { id: 'bw', type: 'line', title: 'Data transfer', span: 6, unit: 'bytes', ...bw }, { metric: bytesOf, order: 'sum_edgeResponseBytes_DESC' }),
          { id: 'status', type: 'bars', title: 'Requests by status code', span: 6, unit: 'count', ...status },
          { id: 'cache', type: 'bars', colors: CACHE_COLORS, title: 'Requests by cache status', span: 6, unit: 'count', ...cacheS },
          { id: 'paths', type: 'toplist', title: 'Top paths', span: 6, unit: 'count', items: toplist(z.paths, (r) => r.dimensions.clientRequestPath) },
          { id: 'countries', type: 'toplist', title: 'Top countries', span: 6, unit: 'count', items: toplist(z.cc, (r) => countryName(r.dimensions.clientCountryName)) },
          { id: 'ips', type: 'toplist', title: 'Top client IPs', span: 6, unit: 'count', items: toplist(z.ips, (r) => r.dimensions.clientIP) },
          { id: 'hosts', type: 'toplist', title: 'Top hosts', span: 6, unit: 'count', items: toplist(z.hosts, (r) => r.dimensions.clientRequestHTTPHost) },
          { id: 'browsers', type: 'toplist', title: 'Top browsers', span: 6, unit: 'count', items: toplist(z.br, (r) => UNKNOWN(r.dimensions.userAgentBrowser)) },
          { id: 'oses', type: 'toplist', title: 'Top operating systems', span: 6, unit: 'count', items: toplist(z.os, (r) => UNKNOWN(r.dimensions.userAgentOS)) },
          { id: 'devices', type: 'toplist', title: 'Top device types', span: 6, unit: 'count', items: toplist(z.dev, (r) => cap(r.dimensions.clientDeviceType)) },
          { id: 'protos', type: 'toplist', title: 'Top HTTP versions', span: 6, unit: 'count', items: toplist(z.proto, (r) => r.dimensions.clientRequestHTTPProtocol || 'Unknown') },
          { id: 'uas', type: 'toplist', title: 'Top user agents', span: 12, unit: 'count', items: toplist(z.ua, (r) => r.dimensions.userAgent || 'Unknown') },
          { id: 'codes', type: 'toplist', title: 'Top status codes', span: 6, unit: 'count', items: toplist(z.codes, (r) => statusLabel(r.dimensions.edgeResponseStatus)) },
          { id: 'colos', type: 'toplist', title: 'Top data centers', span: 6, unit: 'count', items: toplist(z.colo, (r) => coloName(r.dimensions.coloCode)) },
        ],
      };
    },
  },

  visitors: {
    kf: (tl, H) => [H.HA('kp', 'count', PV), H.HA('kv', 'sum{visits}')],
    kd: [
      { label: 'Pageviews', fmt: 'count', good: 'up', val: (z) => num(z.kp[0]?.count) },
      { label: 'Total visits', fmt: 'count', good: 'up', val: (z) => visitsOf(z.kv[0] || {}) },
    ],
    bf: (tl, H) => {
      const L = { limit: 12, extra: PV };
      return [
        H.HG('pvs', tl.dim, { limit: 10000, order: `${tl.dim}_ASC`, extra: PV }),
        H.HG('vts', tl.dim, { limit: 10000, order: `${tl.dim}_ASC`, sel: 'sum{visits}' }),
        H.HG('dev', `${tl.dim} clientDeviceType`, { limit: 10000, order: `${tl.dim}_ASC`, extra: PV }),
        H.HG('cc', 'clientCountryName', { limit: 300, extra: PV }),
        H.HG('paths', 'clientRequestPath', L),
        H.HG('hosts', 'clientRequestHTTPHost', L),
        H.HG('os', 'userAgentOS', L),
        H.HG('br', 'userAgentBrowser', L),
        H.HG('ua', 'userAgent', L),
        H.HG('colo', 'coloCode', L),
      ];
    },
    widgets: async (z, tl, ctx) => {
      const pv = lines(tl, z.pvs, [{ key: 'pv', label: 'Pageviews', val: (r) => r.count }]);
      const vis = lines(tl, z.vts, [{ key: 'visits', label: 'Visits', val: visitsOf }]);
      const dev = pivot(tl, z.dev, (r) => cap(r.dimensions.clientDeviceType), (r) => r.count);
      const countries = (z.cc || []).map((r) => ({ code: r.dimensions.clientCountryName, label: countryName(r.dimensions.clientCountryName), value: r.count })).sort((a, b) => b.value - a.value);
      return {
        sparks: { Pageviews: pv.data.map((d) => d.pv), 'Total visits': vis.data.map((d) => d.visits) },
        widgets: [
          await maybeGroup(ctx, { id: 'pv', type: 'line', title: 'Pageviews over time', span: 6, unit: 'count', ...pv }, { metric: (r) => r.count, extra: PV }),
          await maybeGroup(ctx, { id: 'vts', type: 'line', title: 'Visits over time', span: 6, unit: 'count', ...vis }, { metric: visitsOf, order: 'sum_visits_DESC' }),
          heading('h-geo', 'Geography'),
          { id: 'map', type: 'map', title: 'Pageviews by country', span: 6, unit: 'count', items: countries },
          { id: 'cc', type: 'toplist', title: 'Top countries', span: 6, unit: 'count', items: countries.slice(0, 10).map(({ label, value }) => ({ label, value })) },
          heading('h-content', 'Content'),
          { id: 'paths', type: 'toplist', title: 'Top paths', span: 6, unit: 'count', items: toplist(z.paths, (r) => r.dimensions.clientRequestPath) },
          { id: 'hosts', type: 'toplist', title: 'Top hosts', span: 6, unit: 'count', items: toplist(z.hosts, (r) => r.dimensions.clientRequestHTTPHost) },
          heading('h-tech', 'Technology'),
          { id: 'dev', type: 'bars', title: 'Device types over time', span: 12, unit: 'count', ...dev },
          ...TOP_TECH(z, (r) => r.count),
          heading('h-net', 'Traffic & Network'),
          { id: 'colo', type: 'toplist', title: 'Top data centers', span: 12, unit: 'count', items: toplist(z.colo, (r) => coloName(r.dimensions.coloCode)) },
        ],
      };
    },
  },

  performance: {
    kf: (tl, H) => [H.HA('kq', Q3, ',originResponseStatus_neq:0')],
    kd: [
      { label: 'Origin response (p50)', fmt: 'ms', good: 'down', val: (z) => num(z.kq[0]?.quantiles.originResponseDurationMsP50) },
      { label: 'Origin response (p95)', fmt: 'ms', good: 'down', val: (z) => num(z.kq[0]?.quantiles.originResponseDurationMsP95) },
    ],
    bf: (tl, H) => [
      H.HG('pq', tl.dim, { limit: 10000, order: `${tl.dim}_ASC`, extra: ',originResponseStatus_neq:0', sel: Q3 }),
      H.HG('proto', `${tl.dim} clientRequestHTTPProtocol`, { limit: 10000, order: `${tl.dim}_ASC` }),
      H.HG('tls', 'clientSSLProtocol', { limit: 10 }),
    ],
    widgets: async (z, tl) => {
      const q = lines(tl, z.pq, [
        { key: 'p50', label: 'p50', val: (r) => num(r.quantiles.originResponseDurationMsP50) },
        { key: 'p95', label: 'p95', val: (r) => num(r.quantiles.originResponseDurationMsP95) },
        { key: 'p99', label: 'p99', val: (r) => num(r.quantiles.originResponseDurationMsP99) },
      ]);
      return {
        sparks: { 'Origin response (p50)': q.data.map((d) => d.p50), 'Origin response (p95)': q.data.map((d) => d.p95) },
        widgets: [
          { id: 'pq', type: 'line', title: 'Origin response time percentiles', span: 12, unit: 'ms', ...q },
          { id: 'proto', type: 'bars', title: 'Requests by HTTP protocol', span: 12, unit: 'count', ...pivot(tl, z.proto, (r) => r.dimensions.clientRequestHTTPProtocol || 'Unknown', (r) => r.count) },
          { id: 'tls', type: 'toplist', title: 'TLS versions', span: 12, unit: 'count', items: toplist(z.tls, (r) => r.dimensions.clientSSLProtocol || 'none') },
        ],
      };
    },
  },

  security: {
    kf: (tl, H) => [H.HG('ks', 'securityAction securitySource', { limit: 100 })],
    kd: [
      { label: 'Total requests', fmt: 'count', good: 'up', val: (z) => sumBy(z.ks, () => true) },
      { label: 'Mitigated requests', fmt: 'count', good: null, val: (z) => sumBy(z.ks, (r) => r.dimensions.securityAction !== 'unknown') },
      { label: 'Mitigated requests rate', fmt: 'pct', good: null, val: (z) => (sumBy(z.ks, () => true) ? (sumBy(z.ks, (r) => r.dimensions.securityAction !== 'unknown') / sumBy(z.ks, () => true)) * 100 : 0) },
      { label: 'Custom rule requests', fmt: 'count', good: null, val: (z) => sumBy(z.ks, (r) => /custom/i.test(r.dimensions.securitySource)) },
      { label: 'Rate limiting requests', fmt: 'count', good: null, val: (z) => sumBy(z.ks, (r) => /rate/i.test(r.dimensions.securitySource)) },
      { label: 'Managed rule requests', fmt: 'count', good: null, val: (z) => sumBy(z.ks, (r) => /managed/i.test(r.dimensions.securitySource)) },
    ],
    bf: (tl, H) => {
      const mit = ',securityAction_neq:"unknown"';
      return [
        H.HG('os', `${tl.dim} securityAction cacheStatus originResponseStatus`, { limit: 10000, order: `${tl.dim}_ASC` }),
        H.HG('act', `${tl.dim} securityAction`, { limit: 10000, order: `${tl.dim}_ASC`, extra: mit }),
        H.HG('prod', `${tl.dim} securitySource`, { limit: 10000, order: `${tl.dim}_ASC`, extra: mit }),
        H.HG('sa', 'securityAction', { limit: 10 }),
        H.HG('sp', 'securitySource', { limit: 10, extra: mit }),
        H.HG('mp', 'clientRequestPath', { extra: mit }),
        H.HG('mc', 'clientCountryName', { extra: mit }),
        H.HG('mi', 'clientIP', { extra: mit }),
      ];
    },
    widgets: async (z, tl) => {
      const mitigated = (r) => r.dimensions.securityAction !== 'unknown';
      const byOrigin = (r) => !mitigated(r) && r.dimensions.originResponseStatus !== 0 && r.dimensions.cacheStatus !== 'revalidated';
      const outcomes = lines(tl, z.os, [
        { key: 'm', label: 'Mitigated by Cloudflare', val: (r) => (mitigated(r) ? r.count : 0) },
        { key: 'c', label: 'Served by Cloudflare', val: (r) => (!mitigated(r) && !byOrigin(r) ? r.count : 0) },
        { key: 'o', label: 'Served by Origin', val: (r) => (byOrigin(r) ? r.count : 0) },
      ]);
      return {
        sparks: { 'Total requests': outcomes.data.map((d) => d.m + d.c + d.o), 'Mitigated requests': outcomes.data.map((d) => d.m) },
        widgets: [
          { id: 'out', type: 'bars', title: 'Request outcomes over time', span: 12, unit: 'count', ...outcomes },
          { id: 'act', type: 'bars', title: 'Mitigations by action', span: 6, unit: 'count', ...pivot(tl, z.act, (r) => cap(r.dimensions.securityAction), (r) => r.count) },
          { id: 'prod', type: 'bars', title: 'Requests by security product', span: 6, unit: 'count', ...pivot(tl, z.prod, (r) => PRODUCT[r.dimensions.securitySource] || r.dimensions.securitySource, (r) => r.count) },
          { id: 'sp', type: 'toplist', title: 'Top security products', span: 6, unit: 'count', items: toplist(z.sp, (r) => PRODUCT[r.dimensions.securitySource] || r.dimensions.securitySource) },
          { id: 'sa', type: 'toplist', title: 'Security actions', span: 6, unit: 'count', items: toplist(z.sa, (r) => cap(r.dimensions.securityAction)) },
          { id: 'mp', type: 'toplist', title: 'Top mitigated paths', span: 6, unit: 'count', items: toplist(z.mp, (r) => r.dimensions.clientRequestPath) },
          { id: 'mc', type: 'toplist', title: 'Top mitigated countries', span: 6, unit: 'count', items: toplist(z.mc, (r) => countryName(r.dimensions.clientCountryName)) },
          { id: 'mi', type: 'toplist', title: 'Top mitigated client IPs', span: 12, unit: 'count', items: toplist(z.mi, (r) => r.dimensions.clientIP) },
        ],
      };
    },
  },

  cache: {
    kf: (tl, H) => [H.HG('kc', 'cacheStatus', { limit: 20, sel: 'count sum{edgeResponseBytes}' })],
    kd: (() => {
      const isC = (r) => CACHED.includes(r.dimensions.cacheStatus);
      const tot = (z) => sumBy(z.kc, () => true);
      const cachedN = (z) => sumBy(z.kc, isC);
      const cachedB = (z) => sumBy(z.kc, isC, bytesOf);
      const totB = (z) => sumBy(z.kc, () => true, bytesOf);
      return [
        { label: 'Cache hit rate', fmt: 'pct', good: 'up', val: (z) => (tot(z) ? (cachedN(z) / tot(z)) * 100 : 0) },
        { label: 'Cached requests', fmt: 'count', good: 'up', val: cachedN },
        { label: 'Uncached requests', fmt: 'count', good: null, val: (z) => tot(z) - cachedN(z) },
        { label: 'Bandwidth from cache', fmt: 'bytes', good: 'up', val: cachedB },
        { label: 'Total data transfer', fmt: 'bytes', good: null, val: totB },
        { label: 'Bandwidth saved', fmt: 'pct', good: 'up', val: (z) => (totB(z) ? (cachedB(z) / totB(z)) * 100 : 0) },
      ];
    })(),
    bf: (tl, H) => {
      const yes = ',cacheStatus_in:["hit","revalidated"]';
      const no = ',cacheStatus_notin:["hit","revalidated"]';
      return [
        H.HG('cs', `${tl.dim} cacheStatus`, { limit: 10000, order: `${tl.dim}_ASC`, sel: 'count sum{edgeResponseBytes}' }),
        H.HG('cp', 'clientRequestPath', { extra: yes }),
        H.HG('up', 'clientRequestPath', { extra: no }),
        H.HG('cct', 'edgeResponseContentTypeName', { extra: yes }),
        H.HG('uct', 'edgeResponseContentTypeName', { extra: no }),
        H.HG('st', 'cacheStatus', { limit: 10 }),
      ];
    },
    widgets: async (z, tl) => {
      const isC = (r) => CACHED.includes(r.dimensions.cacheStatus);
      const reqs = lines(tl, z.cs, [
        { key: 'cached', label: 'Cached', val: (r) => (isC(r) ? r.count : 0) },
        { key: 'uncached', label: 'Uncached', val: (r) => (isC(r) ? 0 : r.count) },
      ]);
      const bw = lines(tl, z.cs, [
        { key: 'cached', label: 'Cached', val: (r) => (isC(r) ? bytesOf(r) : 0) },
        { key: 'uncached', label: 'Uncached', val: (r) => (isC(r) ? 0 : bytesOf(r)) },
      ]);
      const label = (r) => cap(r.dimensions.cacheStatus);
      const ct = (r) => (!r.dimensions.edgeResponseContentTypeName || r.dimensions.edgeResponseContentTypeName === 'empty' ? 'Empty' : r.dimensions.edgeResponseContentTypeName);
      return {
        sparks: { 'Cached requests': reqs.data.map((d) => d.cached), 'Uncached requests': reqs.data.map((d) => d.uncached) },
        widgets: [
          { id: 'cs', type: 'bars', colors: CACHE_COLORS, title: 'Requests by cache status', span: 12, unit: 'count', ...pivot(tl, z.cs, label, (r) => r.count, 5) },
          { id: 'cu', type: 'bars', title: 'Cached vs uncached requests', span: 6, unit: 'count', ...reqs },
          { id: 'bw', type: 'bars', title: 'Data transfer: cached vs uncached', span: 6, unit: 'bytes', ...bw },
          { id: 'cp', type: 'toplist', title: 'Top cached paths', span: 6, unit: 'count', items: toplist(z.cp, (r) => r.dimensions.clientRequestPath) },
          { id: 'up', type: 'toplist', title: 'Top uncached paths', span: 6, unit: 'count', items: toplist(z.up, (r) => r.dimensions.clientRequestPath) },
          { id: 'cct', type: 'toplist', title: 'Top cached content types', span: 6, unit: 'count', items: toplist(z.cct, ct) },
          { id: 'uct', type: 'toplist', title: 'Top uncached content types', span: 6, unit: 'count', items: toplist(z.uct, ct) },
          { id: 'st', type: 'toplist', title: 'Top cache statuses', span: 12, unit: 'count', items: toplist(z.st, label) },
        ],
      };
    },
  },

  origin: (() => {
    const toOrigin = (r) => r.dimensions.originResponseStatus !== 0;
    const failedConn = (r) => !toOrigin(r) && [522, 523, 524].includes(r.dimensions.edgeResponseStatus);
    const reached = (z) => sumBy(z.ko, toOrigin);
    const failed = (z) => sumBy(z.ko, failedConn);
    const reach = (z) => (reached(z) + failed(z) ? (reached(z) / (reached(z) + failed(z))) * 100 : 0);
    return {
      kf: (tl, H) => [H.HG('ko', 'originResponseStatus edgeResponseStatus', { limit: 300, sel: 'count sum{edgeResponseBytes}' }), H.HA('kq', Q3, ',originResponseStatus_neq:0')],
      kd: [
        { label: 'Origin reachability', fmt: 'pct', good: 'up', val: reach },
        { label: 'Connection success', fmt: 'pct', good: 'up', val: reach },
        { label: 'Origin response (p50)', fmt: 'ms', good: 'down', val: (z) => num(z.kq[0]?.quantiles.originResponseDurationMsP50) },
        { label: 'Origin error rate', fmt: 'pct', good: 'down', val: (z) => (reached(z) ? (sumBy(z.ko, (r) => r.dimensions.originResponseStatus >= 500) / reached(z)) * 100 : 0) },
        { label: 'Requests to origin', fmt: 'count', good: null, val: (z) => reached(z) + failed(z) },
        { label: 'Origin data transfer', fmt: 'bytes', good: null, val: (z) => sumBy(z.ko, toOrigin, bytesOf) },
      ],
      bf: (tl, H) => {
        const o = ',originResponseStatus_neq:0';
        return [
          H.HG('ots', `${tl.dim} originResponseStatus edgeResponseStatus`, { limit: 10000, order: `${tl.dim}_ASC` }),
          H.HA('bd', 'avg{originTcpHandshakeDurationMs originTlsHandshakeDurationMs originResponseHeaderReceiveDurationMs}', o),
          H.HG('pq', tl.dim, { limit: 10000, order: `${tl.dim}_ASC`, extra: o, sel: Q3 }),
          H.HG('op', 'clientRequestPath', { extra: o }),
          H.HG('os', 'originResponseStatus', { extra: o, limit: 10 }),
          H.HG('oip', 'originIP', { extra: o }),
          H.HG('ep', 'clientRequestPath clientRequestHTTPHost coloCode', { extra: o, sel: 'count quantiles{originResponseDurationMsP95} ratio{status4xx status5xx}' }),
        ];
      },
      widgets: async (z, tl) => {
        const outcomes = lines(tl, z.ots, [
          { key: 'reached', label: 'Reached origin', val: (r) => (toOrigin(r) ? r.count : 0) },
          { key: 'failed', label: 'Connection failed', val: (r) => (failedConn(r) ? r.count : 0) },
        ]);
        const toO = lines(tl, z.ots, [{ key: 'req', label: 'Requests', val: (r) => (toOrigin(r) ? r.count : 0) }]);
        const cls = pivot(tl, (z.ots || []).filter(toOrigin), (r) => `${Math.floor(r.dimensions.originResponseStatus / 100)}xx`, (r) => r.count, 4);
        const q = lines(tl, z.pq, [
          { key: 'p50', label: 'p50', val: (r) => num(r.quantiles.originResponseDurationMsP50) },
          { key: 'p95', label: 'p95', val: (r) => num(r.quantiles.originResponseDurationMsP95) },
          { key: 'p99', label: 'p99', val: (r) => num(r.quantiles.originResponseDurationMsP99) },
        ]);
        const bd = z.bd[0]?.avg || {};
        return {
          sparks: { 'Requests to origin': toO.data.map((d) => d.req), 'Origin response (p50)': q.data.map((d) => d.p50) },
          widgets: [
            { id: 'ots', type: 'bars', title: 'Origin connection outcomes over time', span: 6, unit: 'count', ...outcomes },
            { id: 'bd', type: 'toplist', title: 'Origin connection breakdown (average)', span: 6, unit: 'ms', items: [
              { label: 'TCP handshake', value: num(bd.originTcpHandshakeDurationMs) },
              { label: 'TLS handshake', value: num(bd.originTlsHandshakeDurationMs) },
              { label: 'Response wait', value: num(bd.originResponseHeaderReceiveDurationMs) },
            ] },
            { id: 'pq', type: 'line', title: 'Origin response time percentiles', span: 6, unit: 'ms', ...q },
            { id: 'rto', type: 'line', title: 'Requests to origin over time', span: 6, unit: 'count', ...toO },
            { id: 'osc', type: 'bars', title: 'Origin status codes over time', span: 12, unit: 'count', ...cls },
            { id: 'op', type: 'toplist', title: 'Top paths by origin requests', span: 6, unit: 'count', items: toplist(z.op, (r) => r.dimensions.clientRequestPath) },
            { id: 'os', type: 'toplist', title: 'Top reached-origin status codes', span: 6, unit: 'count', items: toplist(z.os, (r) => statusLabel(r.dimensions.originResponseStatus)) },
            { id: 'oip', type: 'toplist', title: 'Top origin IPs', span: 12, unit: 'count', items: toplist(z.oip, (r) => r.dimensions.originIP || 'Unknown') },
            {
              id: 'ep', type: 'table', title: 'Top endpoints', span: 12,
              columns: [{ key: 'path', label: 'Path / host' }, { key: 'colo', label: 'Data center' }, { key: 'p95', label: 'Response time (p95)', fmt: 'ms' }, { key: 'r4', label: '4xx rate', fmt: 'pct' }, { key: 'r5', label: '5xx rate', fmt: 'pct' }, { key: 'count', label: 'Requests', fmt: 'count' }],
              rows: (z.ep || []).map((r) => ({
                path: `${r.dimensions.clientRequestPath} ${r.dimensions.clientRequestHTTPHost}`,
                colo: r.dimensions.coloCode,
                p95: num(r.quantiles?.originResponseDurationMsP95),
                r4: num(r.ratio?.status4xx) * 100,
                r5: num(r.ratio?.status5xx) * 100,
                count: r.count,
              })),
            },
          ],
        };
      },
    };
  })(),

  dns: {
    noFilters: true, // the DNS dataset has different fields; HTTP filters don't apply
    kf: () => [DG('kd', 'responseCode', { limit: 30, sel: 'count avg{processingTimeUs}' })],
    kd: (() => {
      const total = (z) => sumBy(z.kd, () => true);
      return [
        { label: 'Total DNS queries', fmt: 'count', good: null, val: total },
        { label: 'Queries per second', fmt: 'qps', good: null, val: (z) => total(z) / ((z.__windowMs || 1) / 1000) },
        { label: 'NOERROR responses', fmt: 'pct', good: 'up', val: (z) => (total(z) ? (sumBy(z.kd, (r) => r.dimensions.responseCode === 'NOERROR') / total(z)) * 100 : 0) },
        { label: 'NXDOMAIN responses', fmt: 'pct', good: 'down', val: (z) => (total(z) ? (sumBy(z.kd, (r) => r.dimensions.responseCode === 'NXDOMAIN') / total(z)) * 100 : 0) },
        { label: 'Average processing time', fmt: 'ms', good: 'down', val: (z) => (total(z) ? sumBy(z.kd, () => true, (r) => r.count * num(r.avg?.processingTimeUs)) / total(z) / 1000 : 0) },
      ];
    })(),
    bf: (tl) => [
      DG('qs', tl.dim, { limit: 10000, order: `${tl.dim}_ASC` }),
      DG('rc', 'responseCode', { limit: 10 }),
      DG('qt', 'queryType', { limit: 10 }),
      DG('pr', 'protocol', { limit: 10 }),
      DG('qn', 'queryName', { limit: 10 }),
      DG('fq', 'queryName', { limit: 10, extra: ',responseCode_neq:"NOERROR"' }),
      DG('sip', 'sourceIP', { limit: 12 }),
      DG('dip', 'destinationIP', { limit: 12 }),
      DG('colo', 'coloName', { limit: 12 }),
      DG('ipv', 'ipVersion', { limit: 5 }),
    ],
    widgets: async (z, tl) => {
      const qs = lines(tl, z.qs, [{ key: 'q', label: 'Queries', val: (r) => r.count }]);
      const T = (alias, key, name = String) => toplist(z[alias], (r) => name(r.dimensions[key] ?? 'Unknown'));
      return {
        sparks: { 'Total DNS queries': qs.data.map((d) => d.q) },
        widgets: [
          { id: 'qs', type: 'line', title: 'DNS queries over time', span: 12, unit: 'count', ...qs },
          { id: 'rc', type: 'toplist', title: 'Queries by response code', span: 6, unit: 'count', items: T('rc', 'responseCode') },
          { id: 'qt', type: 'toplist', title: 'Queries by record type', span: 6, unit: 'count', items: T('qt', 'queryType') },
          { id: 'pr', type: 'toplist', title: 'Queries by protocol', span: 6, unit: 'count', items: T('pr', 'protocol') },
          { id: 'ipv', type: 'toplist', title: 'Queries by IP version', span: 6, unit: 'count', items: T('ipv', 'ipVersion') },
          { id: 'qn', type: 'toplist', title: 'Top query names', span: 6, unit: 'count', items: T('qn', 'queryName') },
          { id: 'fq', type: 'toplist', title: 'Top failing query names', span: 6, unit: 'count', items: T('fq', 'queryName') },
          { id: 'sip', type: 'toplist', title: 'Top source IPs', span: 6, unit: 'count', items: T('sip', 'sourceIP') },
          { id: 'dip', type: 'toplist', title: 'Top destination IPs', span: 6, unit: 'count', items: T('dip', 'destinationIP') },
          { id: 'colo', type: 'toplist', title: 'Queries by data center', span: 12, unit: 'count', items: T('colo', 'coloName', coloName) },
        ],
      };
    },
  },
};

// ---- hover actions (filter / exclude / copy) ------------------------------------------------------
// widget id -> [rows alias, filter field]; the raw value behind each label is recovered from the rows.
const FILTERABLE = {
  requests: { paths: ['paths', 'path'], countries: ['cc', 'country'], ips: ['ips', 'ip'], hosts: ['hosts', 'host'], browsers: ['br', 'browser'], oses: ['os', 'os'], devices: ['dev', 'device'], protos: ['proto', 'http'], uas: ['ua', 'userAgent'], codes: ['codes', 'status'], colos: ['colo', 'colo'] },
  visitors: { paths: ['paths', 'path'], hosts: ['hosts', 'host'], cc: ['cc', 'country'], os: ['os', 'os'], br: ['br', 'browser'], ua: ['ua', 'userAgent'], colo: ['colo', 'colo'] },
  security: { sp: ['sp', 'secProduct'], sa: ['sa', 'secAction'], mp: ['mp', 'path'], mc: ['mc', 'country'], mi: ['mi', 'ip'] },
  cache: { cp: ['cp', 'path'], up: ['up', 'path'], cct: ['cct', 'contentType'], uct: ['uct', 'contentType'], st: ['st', 'cache'] },
  origin: { op: ['op', 'path'], os: ['os', 'originStatus'], oip: ['oip', 'originIp'] },
  performance: { tls: ['tls', 'tls'] },
};
const ctName = (v) => (!v || v === 'empty' ? 'Empty' : v);
const DISPLAY = {
  path: (v) => v, host: (v) => v, ip: (v) => v, country: countryName, browser: UNKNOWN, os: UNKNOWN, device: cap, http: (v) => v || 'Unknown', userAgent: (v) => v || 'Unknown',
  status: statusLabel, colo: coloName, secProduct: (v) => PRODUCT[v] || v, secAction: cap, contentType: ctName, cache: cap, originStatus: statusLabel, originIp: (v) => v || 'Unknown', tls: (v) => v || 'none',
};
const lowerMap = (labels) => Object.fromEntries(labels.map((l) => [l, l.toLowerCase()]));

function addHoverActions(tab, widgets, z) {
  for (const w of widgets) {
    const m = FILTERABLE[tab]?.[w.id];
    if (m && w.type === 'toplist') {
      const [alias, field] = m;
      const dim = FIELDS[field].dim;
      const raws = new Map();
      for (const r of z[alias] || []) raws.set(DISPLAY[field](r.dimensions[dim]), String(r.dimensions[dim] ?? ''));
      w.filterField = field;
      w.items = w.items.map((it) => ({ ...it, raw: raws.get(it.label) }));
    } else if (w.id === 'status' && tab === 'requests') {
      w.filterField = 'statusClass';
      w.rawBy = Object.fromEntries(w.series.map((x) => [x.label, x.label]));
    } else if ((w.id === 'cache' && tab === 'requests') || (w.id === 'cs' && tab === 'cache')) {
      w.filterField = 'cache';
      w.rawBy = lowerMap(w.series.map((x) => x.label));
    }
  }
}

// ---- entry point ----------------------------------------------------------------------------
function cacheSet(key, value) {
  if (cache.size > 300) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k); // keep memory bounded
  cache.set(key, value);
}

async function previous(token, zone, win, tl, def, H, ck) {
  const key = `${ck}:prev`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.z;
  let z = null;
  try {
    z = await run(token, zone, def.kf(tl, H), win.start - win.dur, win.start);
  } catch {
    z = null; // e.g. plan retention: show no delta rather than a wrong one
  }
  cacheSet(key, { at: Date.now(), z });
  return z;
}

export async function liveTab(tab, win, creds, opts = {}) {
  const def = TABS[tab];
  if (!def) throw new Error(`Unknown Cloudflare tab "${tab}"`);
  const { token, zone } = checkCreds(creds);
  const flt = def.noFilters ? { extra: '', key: '[]', list: [], noEyeball: false } : parseFilters(opts.filters); // throws a readable Error on bad input
  const groups = parseGroups(opts.groups);
  const H = fragments(flt.extra, flt.noEyeball);
  const tl = tline(win);
  const ck = `${zone}:${tab}:${win.key === 'custom' ? `${win.start}-${win.end}` : win.key}:${flt.key}`;
  const rk = `${ck}:${JSON.stringify(groups)}`;
  const hit = cache.get(rk);
  if (hit && Date.now() - hit.at < 30_000) return hit.result;

  const z = await run(token, zone, [...def.kf(tl, H), ...def.bf(tl, H)], win.start, win.end);
  const prev = await previous(token, zone, win, tl, def, H, ck);
  z.__windowMs = tl.windowMs;
  if (prev) prev.__windowMs = tl.windowMs;
  const { widgets, sparks, meta } = await def.widgets(z, tl, { token, zone, tl, H, groups });
  addHoverActions(tab, widgets, z);
  const kpis = def.kd.map((d) => {
    const v = d.val(z);
    const pv = prev ? d.val(prev) : null;
    return kpi(d.label, v, d.fmt, sparks[d.label] || null, { goodWhen: d.good, delta: pv == null ? null : change(v, pv) });
  });
  const result = { health: meta?.health || null, kpis, widgets, alerts: meta?.alerts || [], filters: flt.list || [] };
  cacheSet(rk, { at: Date.now(), result });
  return result;
}

/** Values for the filter form's autocomplete: fixed lists locally, everything else from the zone's own data. */
export async function suggest(win, creds, { field, q = '' }) {
  const spec = FIELDS[field];
  if (!spec) throw new Error(`Unknown filter field "${field}"`);
  const needle = String(q).trim().slice(0, 80);
  const fixed = staticSuggestions(field);
  if (fixed) {
    const n = needle.toLowerCase();
    return fixed.filter((v) => !n || v.toLowerCase().includes(n)).slice(0, 30);
  }
  if (spec.kind === 'list' || needle.includes('%')) return [];
  const { token, zone } = checkCreds(creds);
  const key = `${zone}:sg:${field}:${needle}:${win.key}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.vals;
  const extra = needle && spec.kind !== 'num' ? `,${spec.dim}_like:${JSON.stringify(`%${needle}%`)}` : '';
  const H = fragments('', field === 'requestSource');
  const z = await run(token, zone, [H.HG('s', spec.dim, { limit: 15, extra })], win.start, win.end);
  let vals = (z.s || []).map((r) => r.dimensions[spec.dim]).filter((v) => v !== '' && v != null).map(String);
  if (needle && spec.kind === 'num') vals = vals.filter((v) => v.startsWith(needle));
  cacheSet(key, { at: Date.now(), vals });
  return vals;
}
