// Shared plumbing for the Cloudflare provider: API access, time windows, filters, group-by,
// and display names for countries / data centers.
import fs from 'node:fs';

// ---- API access --------------------------------------------------------------------------------
const GQL = 'https://api.cloudflare.com/client/v4/graphql';

export const cache = new Map(); // short TTLs so 15s polling doesn't hammer Cloudflare's rate limits

export function checkCreds(creds) {
  const token = String(creds?.apiToken || '').trim();
  const zone = String(creds?.zoneId || '').trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('API token looks invalid (unexpected characters)');
  if (!/^[a-f0-9]{32}$/i.test(zone)) throw new Error('Zone ID must be 32 hex characters');
  return { token, zone };
}

export async function gql(token, query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
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

export async function run(token, zone, frags, start, end) {
  const q = `query($zone:String!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){${frags.join('\n')}}}}`;
  const d = await gql(token, q, { zone, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  const z = d?.viewer?.zones?.[0];
  if (!z) throw new Error('Zone not found, or the token has no Analytics:Read access to this zone');
  return z;
}

// ---- time windows ------------------------------------------------------------------------------
export const PRESETS = { '30m': 30 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 864e5, '7d': 7 * 864e5, '14d': 14 * 864e5, '30d': 30 * 864e5 };

/** Query params -> { key, start, end, dur } (ms). Falls back to the last 24h on bad input. */
export function windowOf(query, now = Date.now()) {
  if (query.range === 'custom') {
    const from = Number(query.from);
    const to = Number(query.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      const end = Math.min(to, now);
      const start = Math.max(from, end - 31 * 864e5);
      if (end > start) return { key: 'custom', start, end, dur: end - start };
    }
  }
  const key = PRESETS[query.range] ? query.range : '24h';
  return { key, start: now - PRESETS[key], end: now, dur: PRESETS[key] };
}

/** The demo providers only know five fixed ranges; map any window to the nearest one. */
export function legacyRange(win) {
  const h = win.dur / 3600e3;
  return h <= 1.5 ? '1h' : h <= 8 ? '6h' : h <= 36 ? '24h' : h <= 240 ? '7d' : '30d';
}

/** Bucket dimension + size for a window length. */
export function stepFor(dur) {
  if (dur <= 3600e3) return ['datetimeMinute', 60e3];
  if (dur <= 6 * 3600e3) return ['datetimeFiveMinutes', 300e3];
  if (dur <= 12 * 3600e3) return ['datetimeFifteenMinutes', 900e3];
  if (dur <= 14 * 864e5) return ['datetimeHour', 3600e3];
  return ['date', 864e5];
}

export function tline(win) {
  const [dim, step] = stepFor(win.dur);
  const ts = [];
  for (let t = Math.floor(win.start / step) * step; t <= win.end; t += step) ts.push(t);
  const tsOf = (v) => (dim === 'date' ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v));
  return { dim, step, windowMs: win.dur, start: win.start, end: win.end, ts, bucket: (v) => Math.floor(tsOf(v) / step) * step };
}

// ---- display names -----------------------------------------------------------------------------
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_OVERRIDE = { KR: 'Korea, South' }; // the dashboard uses this spelling
export const countryName = (code) => {
  if (!code) return 'Unknown';
  if (COUNTRY_OVERRIDE[code]) return COUNTRY_OVERRIDE[code];
  try {
    return regions.of(code) || code;
  } catch {
    return code; // e.g. "T1" (Tor) or "XX"
  }
};

let colos = {};
try {
  colos = JSON.parse(fs.readFileSync(new URL('../data/colos.json', import.meta.url), 'utf8'));
} catch {
  /* data file missing: fall back to bare IATA codes */
}
const COLO_CITY = { IAD: 'Ashburn', FRA: 'Frankfurt' }; // where the dashboard's city differs from the public locations list
/** "AMS" -> "Amsterdam, Netherlands (AMS)" */
export const coloName = (code) => (colos[code] ? `${COLO_CITY[code] || colos[code].city}, ${countryName(colos[code].cca2)} (${code})` : code || 'Unknown');

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : 'Unknown');

// ---- filters (the "Add filter" button) -----------------------------------------------------------
// Same field list and order as the Cloudflare dashboard ("Ray ID" is left out: the dataset has no such field).
// kind: text -> all 10 operators; enum / num / class -> equals, does not equal, is in, is not in;
//       list -> has / does not have / has any of.
const upper = (v) => v.toUpperCase();
const lower = (v) => v.toLowerCase();
export const FIELDS = {
  host: { label: 'Host', dim: 'clientRequestHTTPHost', kind: 'text', ph: 'e.g. example.com' },
  path: { label: 'Path', dim: 'clientRequestPath', kind: 'text', ph: 'e.g. /content' },
  method: { label: 'Method', dim: 'clientRequestHTTPMethodName', kind: 'enum', values: ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], norm: upper },
  country: { label: 'Country', dim: 'clientCountryName', kind: 'enum', norm: (v) => countryCode(v), names: 'country' },
  ip: { label: 'Client IP', dim: 'clientIP', kind: 'text', ph: 'e.g. 203.0.113.7' },
  colo: { label: 'Data center', dim: 'coloCode', kind: 'enum', norm: (v) => coloCodeOf(v), names: 'colo' },
  cache: { label: 'Cache status', dim: 'cacheStatus', kind: 'enum', values: ['hit', 'miss', 'dynamic', 'revalidated', 'none', 'expired', 'stale', 'bypass', 'updating'], norm: lower },
  statusClass: { label: 'Status class', dim: 'edgeResponseStatus', kind: 'class', values: ['1xx', '2xx', '3xx', '4xx', '5xx'] },
  status: { label: 'Status code', dim: 'edgeResponseStatus', kind: 'num', ph: 'e.g. 404', live: true },
  http: { label: 'HTTP protocol', dim: 'clientRequestHTTPProtocol', kind: 'enum', values: ['HTTP/1.0', 'HTTP/1.1', 'HTTP/2', 'HTTP/3'] },
  tls: { label: 'TLS version', dim: 'clientSSLProtocol', kind: 'enum', values: ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3', 'none'] },
  contentType: { label: 'Content type', dim: 'edgeResponseContentTypeName', kind: 'enum', live: true },
  browser: { label: 'Browser', dim: 'userAgentBrowser', kind: 'enum', live: true },
  os: { label: 'Operating system', dim: 'userAgentOS', kind: 'enum', live: true },
  device: { label: 'Device type', dim: 'clientDeviceType', kind: 'enum', values: ['desktop', 'mobile', 'tablet'], norm: lower },
  userAgent: { label: 'User agent', dim: 'userAgent', kind: 'text', ph: 'e.g. curl/8.6.0' },
  secAction: { label: 'Security action', dim: 'securityAction', kind: 'enum', values: ['block', 'challenge', 'managed_challenge', 'js_challenge', 'log', 'skip', 'allow', 'unknown'], norm: lower },
  secProduct: { label: 'Security product', dim: 'securitySource', kind: 'enum', live: true },
  apiEndpoint: { label: 'API endpoint', dim: 'apiGatewayMatchedEndpoint', kind: 'text', ph: 'e.g. /v1/users/{id}' },
  assetHost: { label: 'Web asset host', dim: 'apiGatewayMatchedHost', kind: 'text', ph: 'e.g. api.example.com' },
  contentMatched: { label: 'Content type matched', dim: 'edgeResponseContentTypeMatched', kind: 'num', values: ['0', '1'], small: true },
  piiPrompt: { label: 'Has PII in LLM prompt', dim: 'firewallForAiAnyPiiCategory', kind: 'num', values: ['0', '1'] },
  aiTopic: { label: 'AI Security Custom Topic Score', dim: 'firewallForAiCustomTopicCategoriesScoresMin', kind: 'num', ph: 'e.g. 50', small: true },
  injection: { label: 'Prompt injection score', dim: 'firewallForAiInjectionScore', kind: 'num', ph: 'e.g. 50' },
  piiCats: { label: 'LLM PII Categories', dim: 'firewallForAiPiiCategories', kind: 'list', ph: 'e.g. EMAIL' },
  unsafeTopics: { label: 'LLM unsafe Topics', dim: 'firewallForAiUnsafeTopicCategories', kind: 'list', ph: 'e.g. S1' },
  eventType: { label: 'Event Type', dim: 'fraudEventType', kind: 'text' },
  userId: { label: 'User ID', dim: 'fraudUserId', kind: 'text' },
  appVersion: { label: 'HTTP Application version', dim: 'httpApplicationVersion', kind: 'num', ph: 'e.g. 1' },
  leaked: { label: 'Leaked credentials scan result', dim: 'leakedCredentialCheckResult', kind: 'enum', live: true },
  originIp: { label: 'Origin IP', dim: 'originIP', kind: 'text', ph: 'e.g. 203.0.113.7' },
  originDuration: { label: 'Origin response duration (ms)', dim: 'originResponseDurationMs', kind: 'num', ph: 'e.g. 500' },
  originStatus: { label: 'Origin status code', dim: 'originResponseStatus', kind: 'num', ph: 'e.g. 200', live: true },
  payPerCrawl: { label: 'Pay Per Crawl status', dim: 'payPerCrawlStatus', kind: 'enum', live: true },
  requestSource: { label: 'Request source', dim: 'requestSource', kind: 'enum', values: ['eyeball', 'edgeWorkerFetch'] },
  sessionId: { label: 'Session ID hash', dim: 'sessionIdHash', kind: 'text' },
  verifiedBot: { label: 'Verified Bot Category', dim: 'verifiedBotCategory', kind: 'enum', live: true },
  zoneVersion: { label: 'Zone version', dim: 'zoneVersion', kind: 'num', ph: 'e.g. 1' },
  keyExchange: { label: 'Client key exchange mechanism', dim: 'clientTLSKeyExchangeGroup', kind: 'enum', live: true },
};
const OPS_BY_KIND = {
  text: ['eq', 'neq', 'contains', 'ncontains', 'starts', 'nstarts', 'ends', 'nends', 'in', 'nin'],
  enum: ['eq', 'neq', 'in', 'nin'],
  num: ['eq', 'neq', 'in', 'nin'],
  class: ['eq', 'neq'],
  list: ['eq', 'neq', 'in'],
};

let nameToCode;
function countryCode(v) {
  const s = String(v).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (!nameToCode) {
    nameToCode = new Map();
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const c = String.fromCharCode(a, b);
      const n = countryName(c);
      if (n !== c) nameToCode.set(n.toLowerCase(), c);
    }
  }
  const c = nameToCode.get(s.toLowerCase());
  if (!c) throw new Error(`Unknown country "${s}" (use a name like "India" or a code like "IN")`);
  return c;
}
/** "Amsterdam, Netherlands (AMS)" or "ams" -> "AMS" */
function coloCodeOf(v) {
  const m = /\(([A-Za-z]{3})\)\s*$/.exec(v.trim());
  return upper(m ? m[1] : v.trim());
}

/** Values offered in the value box without asking Cloudflare (countries, data centers, fixed lists). */
export function staticSuggestions(id) {
  const spec = FIELDS[id];
  if (!spec) return null;
  if (spec.names === 'country') {
    const out = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const c = String.fromCharCode(a, b);
      const n = countryName(c);
      if (n !== c) out.push(n);
    }
    return out.sort();
  }
  if (spec.names === 'colo') return Object.keys(colos).map(coloName).sort();
  return spec.values || null;
}

const lit = (x) => (typeof x === 'number' ? String(x) : JSON.stringify(String(x)));

function normValue(spec, raw) {
  const v = String(raw).trim();
  if (!v) throw new Error('Filter value is empty');
  if (v.length > 200) throw new Error('Filter value is too long');
  if (spec.kind === 'class') {
    const m = /^([1-5])(xx)?$/i.exec(v);
    if (!m) throw new Error('Status class must look like 4xx');
    return Number(m[1]);
  }
  if (spec.kind === 'num') {
    if (!/^-?\d{1,15}$/.test(v)) throw new Error(`${spec.label} must be a whole number`);
    return Number(v);
  }
  return spec.norm ? spec.norm(v) : v;
}

function cond(spec, op, rawValue) {
  const { dim, kind } = spec;
  if (!OPS_BY_KIND[kind].includes(op)) throw new Error(`"${op}" is not available for ${spec.label}`);
  if (kind === 'class') {
    const n = normValue(spec, rawValue) * 100;
    const inside = `{${dim}_geq:${n},${dim}_lt:${n + 100}}`;
    return op === 'eq' ? inside : `{OR:[{${dim}_lt:${n}},{${dim}_geq:${n + 100}}]}`;
  }
  const many = () => String(rawValue).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 25).map((x) => normValue(spec, x));
  if (kind === 'list') {
    if (op === 'in') return `{${dim}_hasany:[${many().map(lit).join(',')}]}`;
    return `{${dim}_${op === 'eq' ? 'has' : 'nothas'}:${lit(normValue(spec, rawValue))}}`;
  }
  if (op === 'in' || op === 'nin') {
    const vals = many();
    if (!vals.length) throw new Error('Filter value is empty');
    // Cloudflare can't parse list filters on its small-integer (uint8) fields, so expand them
    if (spec.small) return op === 'in' ? `{OR:[${vals.map((x) => `{${dim}:${lit(x)}}`).join(',')}]}` : `{AND:[${vals.map((x) => `{${dim}_neq:${lit(x)}}`).join(',')}]}`;
    return `{${dim}_${op === 'in' ? 'in' : 'notin'}:[${vals.map(lit).join(',')}]}`;
  }
  const v = normValue(spec, rawValue);
  if (['contains', 'ncontains', 'starts', 'nstarts', 'ends', 'nends'].includes(op)) {
    if (/[%]/.test(String(v))) throw new Error('The % character is not allowed in text filters');
    const pat = op.endsWith('contains') ? `%${v}%` : op.endsWith('starts') ? `${v}%` : `%${v}`;
    return `{${dim}_${op[0] === 'n' ? 'notlike' : 'like'}:${JSON.stringify(pat)}}`;
  }
  return `{${dim}${op === 'neq' ? '_neq' : ''}:${lit(v)}}`;
}

/** Filters from the query string -> { extra, list, key, noEyeball }. Throws a readable Error on bad input. */
export function parseFilters(json) {
  let list = [];
  if (json) {
    try {
      list = JSON.parse(json);
    } catch {
      throw new Error('Filters are not valid JSON');
    }
  }
  if (!Array.isArray(list)) throw new Error('Filters must be a list');
  list = list.slice(0, 8).map((f) => ({ f: String(f?.f), o: String(f?.o), v: String(f?.v ?? '') }));
  const parts = list.map((x) => {
    const spec = FIELDS[x.f];
    if (!spec) throw new Error(`Unknown filter field "${x.f}"`);
    return cond(spec, x.o, x.v);
  });
  // wrapped in AND so a filter on e.g. edgeResponseStatus can't collide with a built-in condition
  return {
    extra: parts.length ? `,AND:[${parts.join(',')}]` : '',
    list,
    key: JSON.stringify(list),
    noEyeball: list.some((x) => x.f === 'requestSource'), // user picked the request source: drop our default "eyeball"
  };
}

/** What the UI needs to draw the filter form. */
export const FILTER_UI = Object.entries(FIELDS).map(([id, f]) => ({
  id,
  label: f.label,
  kind: f.kind,
  ops: OPS_BY_KIND[f.kind],
  placeholder: f.ph || (f.values || f.names ? 'Select or type a value' : 'Value'),
  suggest: f.kind !== 'list', // every other field offers values (fixed lists, or the zone's own top values)
}));

// ---- display names for status codes ---------------------------------------------------------------
const STATUS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 429: 'Too Many Requests', 499: 'Client Closed Request', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 520: 'Web Server Returned an Unknown Error', 521: 'Web Server Is Down', 522: 'Origin Connection Time-out', 523: 'Origin Is Unreachable', 524: 'A Timeout Occurred', 525: 'SSL Handshake Failed', 526: 'Invalid SSL Certificate' };
export const statusLabel = (c) => `${c} ${STATUS[c] || ''}`.trim();

// ---- group by ----------------------------------------------------------------------------------
export const GROUPS = {
  host: { label: 'Host', dim: 'clientRequestHTTPHost', field: 'host' },
  country: { label: 'Country', dim: 'clientCountryName', field: 'country', name: countryName },
  path: { label: 'Path', dim: 'clientRequestPath', field: 'path' },
  status: { label: 'Status code', dim: 'edgeResponseStatus', field: 'status', name: statusLabel },
  originStatus: { label: 'Origin status code', dim: 'originResponseStatus', field: 'originStatus', name: statusLabel },
  browser: { label: 'Browser', dim: 'userAgentBrowser', field: 'browser', name: (x) => (!x || x === 'Unknown' ? 'Unknown/Others' : x) },
  colo: { label: 'Data center', dim: 'coloCode', field: 'colo', name: coloName },
  os: { label: 'Operating system', dim: 'userAgentOS', field: 'os', name: (x) => (!x || x === 'Unknown' ? 'Unknown/Others' : x) },
  device: { label: 'Device type', dim: 'clientDeviceType', field: 'device', name: cap },
  http: { label: 'HTTP protocol', dim: 'clientRequestHTTPProtocol', field: 'http' },
};
export const GROUP_OPTIONS = [{ id: 'none', label: 'None' }, ...Object.entries(GROUPS).map(([id, g]) => ({ id, label: g.label }))];
// purple, pink, blue, yellow, teal: the order Cloudflare uses for grouped series
export const GROUP_COLORS = ['var(--s4)', 'var(--s3)', 'var(--s1)', 'var(--s2)', 'var(--s5)'];

// seen on the Cloudflare dashboard: value -> colour (blue s1, yellow s2, pink s3, purple s4, teal s5)
const COLOR_HINT = { '200 OK': 'var(--s1)', '404 Not Found': 'var(--s5)', '301 Moved Permanently': 'var(--s3)', '403 Forbidden': 'var(--s4)', '204 No Content': 'var(--s2)', Windows: 'var(--s4)', 'Unknown/Others': 'var(--s3)', Linux: 'var(--s1)', iOS: 'var(--s5)', MacOSX: 'var(--s2)' };
export function groupColors(labels) {
  const used = new Set(labels.map((l) => COLOR_HINT[l]).filter(Boolean));
  const spare = ['var(--s1)', 'var(--s5)', 'var(--s3)', 'var(--s4)', 'var(--s2)'].filter((c) => !used.has(c));
  return Object.fromEntries(labels.map((l) => [l, COLOR_HINT[l] || spare.shift() || 'var(--muted)']));
}

export function parseGroups(json) {
  if (!json) return {};
  try {
    const g = JSON.parse(json);
    return Object.fromEntries(Object.entries(g || {}).filter(([k, v]) => /^[a-z]{1,12}$/.test(k) && GROUPS[v]).slice(0, 6));
  } catch {
    return {};
  }
}

// ---- GraphQL fragment builders (bound to the active filters) --------------------------------------
export function fragments(filterExtra = '', noEyeball = false) {
  const src = noEyeball ? '' : ',requestSource:"eyeball"';
  const f = (extra = '') => `filter:{datetime_geq:$start,datetime_leq:$end${src}${filterExtra}${extra}}`;
  return {
    HG: (alias, dims, { limit = 10, order = 'count_DESC', extra = '', sel = 'count' } = {}) =>
      `${alias}: httpRequestsAdaptiveGroups(limit:${limit}, orderBy:[${order}], ${f(extra)}){${sel} dimensions{${dims}}}`,
    HA: (alias, sel, extra = '') => `${alias}: httpRequestsAdaptiveGroups(limit:1, ${f(extra)}){${sel}}`,
  };
}
export const DG = (alias, dims, { limit = 10, order = 'count_DESC', extra = '', sel = 'count' } = {}) =>
  `${alias}: dnsAnalyticsAdaptiveGroups(limit:${limit}, orderBy:[${order}], filter:{datetime_geq:$start,datetime_leq:$end${extra}}){${sel} dimensions{${dims}}}`;

export const litOf = lit;
