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

export async function load(provider, win, creds, opts = {}) {
  const { tab } = opts;
  if (process.env.DATA_MODE !== 'demo' && provider.live && creds && Object.keys(creds).length) {
    try {
      return { ...(await provider.live(win, creds, opts)), source: 'live' };
    } catch (e) {
      return { ...(await provider.dashboard(legacyRange(win))), source: 'demo', liveError: e.message };
    }
  }
  if (tab && tab !== provider.meta.tabs?.[0]?.id) {
    // Only the first tab has demo data; the others need a real connection (no made-up numbers).
    return { health: null, kpis: [], alerts: [], source: 'demo', widgets: [{ id: 'need-live', type: 'notice', title: `${provider.meta.name} · ${tab}`, span: 12, text: 'This tab shows live data only. Connect your account on the Integrations page to see it.' }] };
  }
  return { ...(await provider.dashboard(legacyRange(win))), source: 'demo' };
}
