import { loadCreds, loadRange } from './store.jsx';

const headers = () => {
  const c = loadCreds();
  return Object.keys(c).length ? { 'x-creds': btoa(JSON.stringify(c)) } : {};
};

// Presets are sent as-is; "Today" and custom ranges as explicit from/to timestamps.
function rangeQuery() {
  const { range, custom } = loadRange();
  if (range === 'today') {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return `range=custom&from=${midnight.getTime()}&to=${Date.now()}`;
  }
  if (range === 'custom' && custom) return `range=custom&from=${custom.from}&to=${custom.to}`;
  return `range=${range === 'custom' ? '24h' : range}`;
}

async function get(url) {
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error(j?.error || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

export const api = {
  providers: () => get('/api/providers'),
  dashboard: (id, { tab, filters, groups, intervals } = {}) => {
    const q = [rangeQuery(), tab && `tab=${tab}`, filters && `filters=${encodeURIComponent(filters)}`, groups && `groups=${encodeURIComponent(groups)}`, intervals && `intervals=${encodeURIComponent(intervals)}`].filter(Boolean).join('&');
    return get(`/api/dashboard/${id}?${q}`);
  },
  suggest: (id, field, q) => get(`/api/suggest/${id}?${rangeQuery()}&field=${encodeURIComponent(field)}&q=${encodeURIComponent(q)}`),
  overview: (ids) => get(`/api/overview?${rangeQuery()}&ids=${ids.join(',')}`),
  mongoDocs: (ns) => get(`/api/mongodb/docs?ns=${encodeURIComponent(ns)}&limit=5000`),
  recentLogs: () => get('/api/logs/recent'),
  test: async (provider, creds) => {
    const r = await fetch('/api/connect/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, creds }) });
    return r.json();
  },
};
