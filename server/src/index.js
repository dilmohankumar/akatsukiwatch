import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { providers, getProvider, load } from './providers/index.js';
import { windowOf, parseFilters } from './providers/cfCore.js';
import * as logs from './logs.js';
import * as mongodb from './providers/mongodb.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Credentials are bring-your-own: the browser keeps them in localStorage and sends
// them per request. The server is stateless and never persists or logs them.
const credsOf = (req) => {
  try {
    return JSON.parse(Buffer.from(req.get('x-creds') || '', 'base64').toString() || '{}');
  } catch {
    return {};
  }
};
const winOf = (req) => windowOf(req.query);

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: process.env.DATA_MODE || 'auto' }));

app.get('/api/providers', (_req, res) => res.json(providers.map((p) => p.meta)));

app.get('/api/dashboard/:id', async (req, res) => {
  const p = getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown provider' });
  const creds = credsOf(req);
  try {
    if (req.query.filters) parseFilters(req.query.filters); // reject bad filters with a clear message
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const win = winOf(req);
  const data = await load(p, win, creds[p.meta.id], { tab: req.query.tab, filters: req.query.filters, groups: req.query.groups, intervals: req.query.intervals });
  res.json({ meta: p.meta, range: win.key, window: { start: win.start, end: win.end }, tab: req.query.tab || null, generatedAt: Date.now(), ...data });
});

// A collection's latest documents (read-only, credentials masked) for the MongoDB page.
app.get('/api/mongodb/docs', async (req, res) => {
  try {
    res.json(await mongodb.documents(credsOf(req).mongodb, String(req.query.ns || ''), req.query.limit));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Autocomplete values for the filter form.
app.get('/api/suggest/:id', async (req, res) => {
  const p = getProvider(req.params.id);
  if (!p?.suggest) return res.status(404).json({ error: 'no suggestions for this integration' });
  try {
    const values = await p.suggest(winOf(req), credsOf(req)[p.meta.id], { field: String(req.query.field || ''), q: String(req.query.q || '') });
    res.json({ values });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cross-provider summary for the Overview page.
app.get('/api/overview', async (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const list = providers.filter((p) => !ids.length || ids.includes(p.meta.id));
  const creds = credsOf(req);
  const out = await Promise.all(
    list.map(async (p) => {
      const d = await load(p, winOf(req), creds[p.meta.id]);
      return { id: p.meta.id, name: p.meta.name, icon: p.meta.icon, source: d.source, health: d.health, kpis: d.kpis.slice(0, 3), alerts: d.alerts.map((a) => ({ ...a, source: p.meta.name })) };
    }),
  );
  res.json({
    generatedAt: Date.now(),
    providers: out.map(({ alerts, ...rest }) => rest),
    alerts: out.flatMap((o) => o.alerts).sort((a, b) => b.ts - a.ts),
    logCounts: logs.counts(15 * 60e3),
  });
});

app.post('/api/connect/test', (req, res) => {
  const { provider, creds } = req.body || {};
  const p = getProvider(provider);
  if (!p) return res.status(404).json({ ok: false, message: 'unknown provider' });
  const missing = p.meta.credentialFields.filter((f) => !f.optional && !creds?.[f.key]).map((f) => f.label);
  if (missing.length) return res.json({ ok: false, message: `Missing: ${missing.join(', ')}` });
  if (process.env.DATA_MODE !== 'demo' && p.testConnection) {
    return p.testConnection(creds).then((m) => res.json(m)).catch((e) => res.json({ ok: false, message: e.message }));
  }
  res.json({ ok: true, demo: true, message: 'Saved. Demo mode: live API calls are not enabled on this server yet.' });
});

app.get('/api/logs/recent', (_req, res) => res.json(logs.getBacklog(100)));

app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const off = logs.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
});

// Serve the built client in production.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

logs.start();
const port = process.env.PORT || 4100;
app.listen(port, () => console.log(`AkatsukiWatch API on :${port} (${process.env.DATA_MODE || 'auto'} mode)`));
