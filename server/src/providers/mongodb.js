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
    { key: 'publicKey', label: 'Atlas public key', type: 'text' },
    { key: 'privateKey', label: 'Atlas private key', type: 'password' },
    { key: 'projectId', label: 'Project (group) ID', type: 'text' },
  ],
  liveApi: 'Atlas Admin API v2 (measurements, performance advisor) or serverStatus via read-only user',
};

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
