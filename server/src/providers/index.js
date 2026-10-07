import * as cloudflare from './cloudflare.js';
import * as mongodb from './mongodb.js';
import * as ec2 from './ec2.js';
import * as payments from './payments.js';
import * as domains from './domains.js';
import * as docker from './docker.js';

// Every provider exposes: meta, dashboard(range, creds), and optionally live(range, creds).
// `live` is the seam where real API integrations plug in later; until a provider
// implements it and credentials are supplied, demo data is served. DATA_MODE=demo forces demo.
export const providers = [cloudflare, mongodb, ec2, payments, domains, docker];
export const getProvider = (id) => providers.find((p) => p.meta.id === id);

export async function load(provider, range, creds) {
  if (process.env.DATA_MODE !== 'demo' && provider.live && creds && Object.keys(creds).length) {
    try {
      return { ...(await provider.live(range, creds)), source: 'live' };
    } catch (e) {
      return { ...(await provider.dashboard(range)), source: 'demo', liveError: e.message };
    }
  }
  return { ...(await provider.dashboard(range)), source: 'demo' };
}
