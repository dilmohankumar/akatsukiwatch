import { timeline, series, split, rows, sum, avg, last, kpi, ago } from '../lib/mock.js';

export const meta = {
  id: 'docker',
  name: 'Docker & Logs',
  icon: 'box',
  description: 'Container health, resource usage, restarts and a live success / warning / error log stream.',
  monitors: [
    'Container state, uptime, restart count, OOM kills',
    'CPU %, memory vs limit, network and block I/O per container',
    'Live log stream with success / warning / error classification',
    'Error rate over time and top error messages',
    'Image versions / health-check status',
  ],
  credentialFields: [
    { key: 'endpoint', label: 'Agent or Docker API URL (TLS)', type: 'text' },
    { key: 'token', label: 'Agent token', type: 'password' },
  ],
  liveApi: 'Docker Engine API (/containers/json, /stats, /logs?follow=1) via a lightweight agent',
};

const containers = [
  { name: 'nginx', image: 'nginx:1.27', cpu: 3, mem: 42, limit: 128, restarts: 0, up: 18 * 864e5 },
  { name: 'api', image: 'shop-api:2.14.1', cpu: 31, mem: 410, limit: 512, restarts: 1, up: 2 * 864e5 },
  { name: 'worker', image: 'shop-worker:2.14.1', cpu: 54, mem: 620, limit: 1024, restarts: 3, up: 5 * 3600e3 },
  { name: 'redis', image: 'redis:7', cpu: 2, mem: 71, limit: 256, restarts: 0, up: 30 * 864e5 },
];

export async function dashboard(range) {
  const tl = timeline(range);
  const cpu = {};
  containers.forEach((c, i) => {
    cpu[c.name] = series(tl, { seed: `dk-cpu-${i}`, base: c.cpu, flat: true, noise: 0.25, spike: 0.02, spikeMul: 1.8, round: false }).map((v) => Math.min(100, v));
  });
  const logsTotal = series(tl, { seed: 'dk-logs', base: 40, spike: 0.03, spikeMul: 4 });
  const lv = split(tl, logsTotal, { success: 0.74, warning: 0.18, error: 0.08 }, 'dk-lv');
  const errRate = (sum(lv.error) / sum(logsTotal)) * 100;
  const restarts = containers.reduce((a, c) => a + c.restarts, 0);

  return {
    health: { status: errRate > 12 ? 'crit' : errRate > 6 ? 'warn' : 'ok', note: `${errRate.toFixed(1)}% log errors` },
    kpis: [
      kpi('Running containers', containers.length, 'int', null, { sub: `${containers.length} of ${containers.length} healthy` }),
      kpi('Restarts (7d)', restarts, 'int', null, { goodWhen: 'down' }),
      kpi('Avg CPU', avg(Object.values(cpu).map((a) => last(a))), 'pct', null),
      kpi('Log events', sum(logsTotal), 'int', logsTotal),
      kpi('Error rate', errRate, 'pct', lv.error, { goodWhen: 'down' }),
    ],
    widgets: [
      { id: 'cpu', type: 'line', title: 'CPU % by container', span: 6, unit: 'pct', series: containers.map((c) => ({ key: c.name, label: c.name })), data: rows(tl, cpu) },
      { id: 'lv', type: 'bars', title: 'Log events by outcome', span: 6, unit: 'int', series: [{ key: 'success', label: 'success' }, { key: 'warning', label: 'warning' }, { key: 'error', label: 'error' }], data: rows(tl, lv) },
      {
        id: 'ctr', type: 'table', title: 'Containers', span: 12,
        columns: [{ key: 'name', label: 'Name' }, { key: 'image', label: 'Image' }, { key: 'state', label: 'State', fmt: 'status' }, { key: 'cpu', label: 'CPU', fmt: 'pct' }, { key: 'memText', label: 'Memory' }, { key: 'restarts', label: 'Restarts' }, { key: 'uptime', label: 'Up since', fmt: 'ago' }],
        rows: containers.map((c) => ({ ...c, state: 'running', memText: `${c.mem} / ${c.limit} MB`, uptime: ago(c.up) })),
      },
      { id: 'live', type: 'logs', title: 'Live logs', span: 12 },
    ],
    alerts: [
      { sev: 'warn', msg: 'worker restarted 3 times in 7d — memory at 60% of limit, check for leaks', ts: ago(5 * 3600e3) },
    ],
  };
}
