import { loadCreds } from './store.jsx';

const headers = () => {
  const c = loadCreds();
  return Object.keys(c).length ? { 'x-creds': btoa(JSON.stringify(c)) } : {};
};

async function get(url) {
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export const api = {
  providers: () => get('/api/providers'),
  dashboard: (id, range) => get(`/api/dashboard/${id}?range=${range}`),
  overview: (ids, range) => get(`/api/overview?range=${range}&ids=${ids.join(',')}`),
  recentLogs: () => get('/api/logs/recent'),
  test: async (provider, creds) => {
    const r = await fetch('/api/connect/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, creds }) });
    return r.json();
  },
};
