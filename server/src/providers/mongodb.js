import { MongoClient, BSON } from 'mongodb';
import { timeline, series, split, rows, sum, avg, last, kpi, toplist, ago } from '../lib/mock.js';

export const meta = {
  id: 'mongodb',
  name: 'MongoDB',
  icon: 'database',
  description: 'Database throughput, connections, replication, storage and slow queries.',
  monitors: [
    'Opcounters: insert / query / update / delete / command per second',
    'Connections (current vs available), network in/out',
    'Replication lag, oplog window, primary elections',
    'WiredTiger cache usage and dirty %, memory, page faults',
    'Slow queries & query targeting (scanned/returned ratio)',
    'Storage: data + index size per collection, disk free',
    'Unused / redundant indexes, Atlas alerts, backups',
  ],
  credentialFields: [
    { key: 'connectionString', label: 'Connection string (read-only user)', type: 'password' },
  ],
  liveApi: 'serverStatus, listDatabases and collStats through a read-only database user',
};

const lastSample = new Map();

/** Turns a driver error into a sentence that says what is wrong and what to fix. */
function explain(e) {
  const m = String(e?.message || e);
  const tip = (t) => `${t} (${m.split('\n')[0].slice(0, 140)})`;
  if (/bad auth|Authentication failed|AuthenticationFailed/i.test(m)) return tip('Wrong username or password in the connection string. Check the database user and its password.');
  if (/ENOTFOUND|querySrv|EAI_AGAIN|getaddrinfo/i.test(m)) return tip('Cluster address not found. Check the host name in the connection string, and that this computer is online.');
  if (/not authorized|Unauthorized|requires authentication|Command .* requires/i.test(m)) return tip('This database user is not allowed to read this data. Give it the "Only read any database" role in Atlas → Database Access.');
  if (/Server selection timed out|ETIMEDOUT|ECONNREFUSED|ReplicaSetNoPrimary|connection .* closed/i.test(m)) return tip('Could not reach the cluster. Most likely this computer\'s IP is not allowed in Atlas → Network Access, or the cluster is paused or down.');
  if (/tls|ssl|certificate/i.test(m)) return tip('Secure (TLS) connection failed. Check the connection string and your network/VPN.');
  if (/Invalid (scheme|connection string)|must start with mongodb/i.test(m)) return tip('The connection string is not valid. Copy it again from Atlas → Connect → Drivers.');
  return m;
}
// Small rates keep their decimals (0.07, 0.004) instead of rounding to 0.
const dec = (v) => (v === 0 ? '0' : v < 0.01 ? v.toFixed(3) : v.toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live numbers straight from the database; ops/sec come from two serverStatus samples 2s apart. */
export async function live(win, creds) {
  try {
    return await liveRaw(win, creds);
  } catch (e) {
    throw new Error(explain(e));
  }
}

async function liveRaw(win, creds) {
  const uri = String(creds?.connectionString || '').trim();
  if (!/^mongodb(\+srv)?:\/\/[^\s]+$/.test(uri)) throw new Error('Connection string must start with mongodb:// or mongodb+srv://');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'analytics-dashboard', maxPoolSize: 1, serverMonitoringMode: 'poll' });
  const OWN = 2; // with these options the driver holds exactly 2 sockets on the node it talks to (1 command, 1 monitor)
  try {
    await client.connect();
    const admin = client.db('admin');
    // Rates are measured against the previous load when it is recent (a longer window, like Atlas's own graph);
    // otherwise from two samples 2s apart.
    const now = Date.now();
    const prev = lastSample.get(uri);
    let s1 = prev && now - prev.at >= 2000 && now - prev.at <= 600e3 ? prev.s : null;
    if (!s1) {
      s1 = await admin.command({ serverStatus: 1 });
      await sleep(2000);
    }
    const s2 = await admin.command({ serverStatus: 1 });
    lastSample.set(uri, { at: Date.now(), s: s2 });
    const dt = Math.max((s2.uptimeMillis - s1.uptimeMillis) / 1000, 0.001);
    const opKeys = ['insert', 'query', 'update', 'delete', 'getmore', 'command'];
    const rate = (k) => (s2.uptimeMillis < s1.uptimeMillis ? 0 : Math.max(0, ((s2.opcounters?.[k] || 0) - (s1.opcounters?.[k] || 0)) / dt));
    // "command" is left out because the dashboard's own calls land there; "getmore" because replica-set nodes tailing the oplog fill it.
    const readRate = rate('query');
    const writeRate = rate('insert') + rate('update') + rate('delete');

    const { databases = [] } = await admin.command({ listDatabases: 1 });
    const dbRows = [];
    const collRows = [];
    const SYSTEM = ['admin', 'local', 'config'];
    for (const d of databases) {
      const db = client.db(d.name);
      const st = await db.command({ dbStats: 1 }).catch(() => ({}));
      dbRows.push({ db: SYSTEM.includes(d.name) ? `${d.name} (system)` : d.name, system: SYSTEM.includes(d.name), collections: st.collections ?? 0, objects: st.objects ?? 0, dataSize: st.dataSize ?? 0, storageSize: st.storageSize ?? 0, indexSize: st.indexSize ?? 0 });
      if (SYSTEM.includes(d.name)) continue; // system collections stay out of the collection list
      for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
        const cs = await db.command({ collStats: c.name }).catch(() => null);
        if (cs) collRows.push({ ns: `${d.name}.${c.name}`, docs: cs.count ?? 0, size: cs.size ?? 0, indexes: cs.nindexes ?? 0, indexSize: cs.totalIndexSize ?? 0 });
      }
    }
    for (const d of dbRows) d.children = d.system ? [] : collRows.filter((c) => c.ns.startsWith(`${d.db}.`)).sort((a, b) => b.size - a.size);
    const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
    const cur = Math.max(0, (s2.connections?.current ?? 0) - OWN); // don't count the dashboard's own connection
    const avail = (s2.connections?.available ?? 0) + OWN; // the dashboard's own sockets are not counted as used
    const connPct = cur + avail ? (cur / (cur + avail)) * 100 : 0;
    // Free (M0) clusters stop at 512 MB; set MONGO_LIMIT_MB if the cluster is on a bigger plan.
    const limitMb = Number(process.env.MONGO_LIMIT_MB) || 512;
    const usedBytes = sum(dbRows.filter((r) => !r.system), (r) => r.dataSize + r.indexSize);
    const leftMb = Math.max(0, limitMb - usedBytes / 1e6);
    const left = leftMb >= 100 ? `${Math.round(leftMb)} MB` : `${leftMb.toFixed(1)} MB`;
    const k = (label, value, fmt, sub) => ({ label, value, fmt, delta: null, tone: 'neutral', spark: null, sub, empty: false, basis: 'previous' });
    return {
      health: { status: connPct > 90 ? 'crit' : connPct > 75 ? 'warn' : 'ok', note: `${cur} connections` },
      kpis: [
        k('Connections', cur, 'int', `${avail} available`),
        k('Data size', sum(dbRows.filter((r) => !r.system), (r) => r.dataSize), 'bytes'),
        k('Storage size', sum(dbRows.filter((r) => !r.system), (r) => r.storageSize), 'bytes', `${left} left of ${limitMb} MB`),
        k('Index size', sum(dbRows.filter((r) => !r.system), (r) => r.indexSize), 'bytes'),
        k('Databases', dbRows.filter((r) => !r.system).length, 'int'),
        k('Collections', sum(dbRows, (r) => r.collections), 'int'),
        k('Documents', sum(dbRows, (r) => r.objects), 'count'),
      ],
      widgets: [
        { id: 'ops', type: 'toplist', title: 'Operations / sec by type', span: 6, unit: 'qps', items: opKeys.map((o) => ({ label: o, value: +rate(o).toFixed(2) })).sort((a, b) => b.value - a.value) },
        { id: 'opsTotal', type: 'toplist', title: 'Operations since server start', span: 6, unit: 'count', items: opKeys.map((o) => ({ label: o, value: s2.opcounters?.[o] || 0 })).sort((a, b) => b.value - a.value) },
        {
          id: 'dbs', type: 'table', title: 'Databases', span: 12,
          columns: [{ key: 'db', label: 'Database' }, { key: 'collections', label: 'Collections' }, { key: 'objects', label: 'Documents' }, { key: 'dataSize', label: 'Data', fmt: 'bytes' }, { key: 'storageSize', label: 'Storage', fmt: 'bytes' }, { key: 'indexSize', label: 'Indexes', fmt: 'bytes' }],
          rows: dbRows,
          expandChildren: true,
          childColumns: [{ key: 'ns', label: 'Namespace' }, { key: 'docs', label: 'Documents' }, { key: 'size', label: 'Data', fmt: 'bytes' }, { key: 'indexes', label: 'Indexes' }, { key: 'indexSize', label: 'Index size', fmt: 'bytes' }],
        },
        {
          id: 'colls', type: 'table', title: 'Collections', span: 12,
          columns: [{ key: 'ns', label: 'Namespace' }, { key: 'docs', label: 'Documents' }, { key: 'size', label: 'Data', fmt: 'bytes' }, { key: 'indexes', label: 'Indexes' }, { key: 'indexSize', label: 'Index size', fmt: 'bytes' }],
          rows: collRows.sort((a, b) => b.size - a.size),
          expandDocs: true,
        },
      ],
      alerts: [],
    };
  } finally {
    await client.close().catch(() => {});
  }
}

const SECRET_KEY = /pass(word)?|pwd|secret|token|api[-_]?key|private|authorization|cookie|session/i;
/** Deep copy with anything that looks like a credential masked. */
function mask(v) {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '••••••' : mask(x)]));
  return v;
}

/** Documents of one collection (newest _id first, up to 5000), read-only, credentials masked. */
export async function documents(creds, ns, limit = 20) {
  const uri = String(creds?.connectionString || '').trim();
  if (!/^mongodb(\+srv)?:\/\/[^\s]+$/.test(uri)) throw new Error('MongoDB is not connected');
  const dot = String(ns).indexOf('.');
  const dbName = String(ns).slice(0, dot);
  const coll = String(ns).slice(dot + 1);
  if (dot < 1 || !coll || !/^[\w.-]+$/.test(dbName) || !/^[\w.\-$]+$/.test(coll)) throw new Error('Bad collection name');
  if (['admin', 'local', 'config'].includes(dbName)) throw new Error('System databases are not shown');
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 5000); // hard cap so one click can't pull a huge collection
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'analytics-dashboard', maxPoolSize: 1, serverMonitoringMode: 'poll' });
  try {
    await client.connect().catch((e) => { throw new Error(explain(e)); });
    const docs = await client.db(dbName).collection(coll).find({}).sort({ _id: -1 }).limit(n).toArray();
    return { ns, total: await client.db(dbName).collection(coll).estimatedDocumentCount(), docs: docs.map((d) => mask(BSON.EJSON.serialize(d, { relaxed: true }))) };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function dashboard(range) {
  const tl = timeline(range);
  const ops = {
    query: series(tl, { seed: 'm-q', base: 420, flat: true, noise: 0.15 }),
    insert: series(tl, { seed: 'm-i', base: 80, flat: true, noise: 0.25, spike: 0.03, spikeMul: 4 }),
    update: series(tl, { seed: 'm-u', base: 120, flat: true, noise: 0.2 }),
    delete: series(tl, { seed: 'm-d', base: 12, flat: true, noise: 0.4 }),
    command: series(tl, { seed: 'm-c', base: 260, flat: true, noise: 0.1 }),
  };
  const total = ops.query.map((_, i) => Object.values(ops).reduce((a, o) => a + o[i], 0));
  const conns = series(tl, { seed: 'm-conn', base: 140, flat: true, noise: 0.08, spike: 0.02, spikeMul: 1.8 });
  const lag = series(tl, { seed: 'm-lag', base: 0.4, flat: true, noise: 0.8, spike: 0.04, spikeMul: 12, round: false });
  const cacheUsed = series(tl, { seed: 'm-cache', base: 71, flat: true, amp: 0.05, noise: 0.03, round: false });
  const dirty = series(tl, { seed: 'm-dirty', base: 3.2, flat: true, noise: 0.5, round: false });
  const netIn = series(tl, { seed: 'm-nin', base: 2.4e6, flat: true, noise: 0.3 });
  const netOut = series(tl, { seed: 'm-nout', base: 9.8e6, flat: true, noise: 0.3 });
  const slow = series(tl, { seed: 'm-slow', base: 0.12, noise: 0.9, spike: 0.06, spikeMul: 6 });
  const maxConn = 500;

  return {
    health: { status: last(lag) > 10 ? 'warn' : 'ok', note: `${last(lag).toFixed(1)}s repl. lag` },
    kpis: [
      kpi('Operations / sec', Math.round(avg(total)), 'int', total, { mode: 'avg' }),
      kpi('Connections', last(conns), 'int', conns, { mode: 'avg', sub: `of ${maxConn} available` }),
      kpi('Replication lag', last(lag), 'sec', lag, { goodWhen: 'down', mode: 'avg' }),
      kpi('Cache used', avg(cacheUsed), 'pct', cacheUsed, { mode: 'avg' }),
      kpi('Slow queries', sum(slow), 'int', slow, { goodWhen: 'down' }),
    ],
    widgets: [
      { id: 'ops', type: 'bars', title: 'Operations per second', span: 6, unit: 'int', series: Object.keys(ops).map((k) => ({ key: k, label: k })), data: rows(tl, ops) },
      { id: 'conn', type: 'line', title: 'Connections', span: 6, unit: 'int', series: [{ key: 'conns', label: 'Current connections' }], data: rows(tl, { conns }) },
      { id: 'lag', type: 'line', title: 'Replication lag', span: 6, unit: 'sec', series: [{ key: 'lag', label: 'Lag (s)' }], data: rows(tl, { lag }) },
      { id: 'cache', type: 'line', title: 'WiredTiger cache', span: 6, unit: 'pct', series: [{ key: 'cacheUsed', label: 'Used %' }, { key: 'dirty', label: 'Dirty %' }], data: rows(tl, { cacheUsed, dirty }) },
      { id: 'net', type: 'line', title: 'Network (bytes/s)', span: 6, unit: 'bytes', series: [{ key: 'netOut', label: 'Out' }, { key: 'netIn', label: 'In' }], data: rows(tl, { netOut, netIn }) },
      { id: 'sizes', type: 'toplist', title: 'Largest collections (data + index)', span: 6, unit: 'bytes', items: toplist('m-size', ['orders', 'events', 'users', 'sessions', 'invoices', 'audit_logs', 'products'], 38e9, 1.2) },
      {
        id: 'slowq', type: 'table', title: 'Slow queries (>100ms)', span: 12,
        columns: [{ key: 'ns', label: 'Namespace' }, { key: 'op', label: 'Operation' }, { key: 'ms', label: 'Duration', fmt: 'ms' }, { key: 'ratio', label: 'Scanned / returned' }, { key: 'hint', label: 'Suggestion' }],
        rows: [
          { ns: 'shop.orders', op: 'find {status, createdAt}', ms: 1840, ratio: '120,000 : 20', hint: 'Create index {status:1, createdAt:-1}' },
          { ns: 'shop.events', op: 'aggregate $group by userId', ms: 960, ratio: '2.1M : 8,400', hint: 'Add index on userId; consider pre-aggregation' },
          { ns: 'shop.users', op: 'find {email: /regex/}', ms: 410, ratio: '310,000 : 1', hint: 'Avoid unanchored regex; use text/Atlas Search' },
        ],
      },
      {
        id: 'idx', type: 'table', title: 'Unused indexes', span: 12,
        columns: [{ key: 'ns', label: 'Namespace' }, { key: 'index', label: 'Index' }, { key: 'size', label: 'Size', fmt: 'bytes' }, { key: 'ops', label: 'Ops since restart' }],
        rows: [
          { ns: 'shop.sessions', index: 'ua_1', size: 1.4e9, ops: 0 },
          { ns: 'shop.products', index: 'legacySku_1', size: 4.2e8, ops: 3 },
        ],
      },
    ],
    alerts: [
      { sev: 'warn', msg: 'shop.orders: query scanning 6,000x more documents than returned', ts: ago(21 * 60e3) },
      { sev: 'info', msg: 'Disk 64% used — projected full in ~41 days', ts: ago(6 * 3600e3) },
    ],
  };
}
