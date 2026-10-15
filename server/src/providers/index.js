import * as cloudflare from './cloudflare.js';
import * as mongodb from './mongodb.js';
import * as ec2 from './ec2.js';
import * as payments from './payments.js';
import * as domains from './domains.js';
import * as docker from './docker.js';
import { legacyRange } from './cfCore.js';

// Every provider exposes: meta, dashboard(range, creds), and optionally live(range, creds).
// `live` is the seam where real API integrations plug in later; until a provider
// implements it and credentials are supplied, demo data is served. DATA_MODE=demo forces demo.
export const providers = [cloudflare, mongodb, ec2, payments, domains, docker];
export const getProvider = (id) => providers.find((p) => p.meta.id === id);

// Without a live connection a provider shows zeros and empty lists, never invented numbers.
function zeroed(d) {
  const zeroRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 't' ? v : typeof v === 'number' ? 0 : v]));
  return {
    ...d,
    health: { status: 'ok', note: 'Not connected' },
    alerts: [],
    kpis: (d.kpis || []).map((k) => ({ ...k, value: 0, delta: null, tone: 'neutral', spark: null, sub: undefined })),
    widgets: (d.widgets || []).map((w) => {
      if (w.type === 'line' || w.type === 'bars') return { ...w, data: (w.data || []).map(zeroRow) };
      if (w.type === 'toplist' || w.type === 'map') return { ...w, items: [] };
      if (w.type === 'table') return { ...w, rows: [] };
      return w;
    }),
  };
}

export async function load(provider, win, creds, opts = {}) {
  const { tab } = opts;
  if (process.env.DATA_MODE !== 'demo' && provider.live && creds && Object.keys(creds).length) {
    try {
      return { ...(await provider.live(win, creds, opts)), source: 'live' };
    } catch (e) {
      return { ...zeroed(await provider.dashboard(legacyRange(win))), health: { status: 'crit', note: `Connection failed: ${e.message}`.slice(0, 160) }, source: 'demo', liveError: e.message };
    }
  }
  if (tab && tab !== provider.meta.tabs?.[0]?.id) {
    // Only the first tab has demo data; the others need a real connection (no made-up numbers).
    return { health: null, kpis: [], alerts: [], source: 'demo', widgets: [{ id: 'need-live', type: 'notice', title: `${provider.meta.name} · ${tab}`, span: 12, text: 'This tab shows live data only. Connect your account on the Integrations page to see it.' }] };
  }
  return { ...zeroed(await provider.dashboard(legacyRange(win))), source: 'demo' };
}
