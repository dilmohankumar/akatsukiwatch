// Mock live log generator. In production, replace `start()` with a real tail
// (Docker `logs --follow` API, CloudWatch Logs StartLiveTail, Loki, etc.)
// and keep the same event shape: { id, ts, source, status, message }.
import { rng, hash, pick } from './lib/mock.js';

const T = {
  nginx: {
    success: ['GET /api/board 200 12ms', 'GET /assets/index.js 200 3ms', 'POST /api/checkout 201 142ms', 'GET / 200 8ms'],
    warning: ['GET /favicon.ico 404', 'GET /.credentials 403 (blocked)', 'upstream response time 1.9s'],
    error: ['upstream timed out (110) while reading response header', 'connect() failed (111) to 127.0.0.1:4000'],
  },
  api: {
    success: ['order created', 'user login ok', 'price board refreshed', 'JWT issued'],
    warning: ['slow handler /api/board/next-price 820ms', 'rate limit near threshold for 195.178.110.94', 'retrying upstream call (1/3)'],
    error: ['unhandled rejection: MongoServerSelectionError', 'TypeError: Cannot read properties of undefined (reading "id")', 'validation failed: amount must be > 0'],
  },
  worker: {
    success: ['job email:welcome done in 310ms', 'job report:daily done in 4.2s', 'queue drained'],
    warning: ['job email:welcome retry 2/5', 'queue depth 480 > 300'],
    error: ['job invoice:pdf failed: ENOMEM', 'SMTP 421 service not available'],
  },
  mongo: {
    success: ['connection accepted from api-prod-1', 'checkpoint complete'],
    warning: ['slow query 1840ms shop.orders find', 'replication lag 11.2s'],
    error: ['WriteConflict on shop.orders', 'Connection pool exhausted'],
  },
  payments: {
    success: ['webhook payment_intent.succeeded delivered', 'payout scheduled'],
    warning: ['webhook delivery slow (2.4s)', 'card_declined for pay_8f2k1'],
    error: ['webhook signature verification failed', 'webhook endpoint returned 500'],
  },
  cron: {
    success: ['backup mongodump ok (2.1 GB)', 'cert renew check ok', 'log rotation ok'],
    warning: ['backup took 3x longer than usual'],
    error: ['backup upload to S3 failed: AccessDenied'],
  },
};

const sources = Object.keys(T);
const subs = new Set();
const backlog = [];
let seq = 0;

function make(r = Math.random) {
  const source = pick(r, sources);
  const x = r();
  const status = x < 0.72 ? 'success' : x < 0.9 ? 'warning' : 'error';
  return { id: ++seq, ts: Date.now(), source, status, message: pick(r, T[source][status]) };
}

function push(ev) {
  backlog.push(ev);
  if (backlog.length > 300) backlog.shift();
  for (const s of subs) s(ev);
}

export function start() {
  if (process.env.DEMO_LOGS !== '1') return; // no invented log lines unless explicitly asked for
  const r = rng(hash('seed-logs'));
  for (let i = 0; i < 60; i++) {
    const ev = make(r);
    ev.ts = Date.now() - (60 - i) * 4000;
    backlog.push(ev);
  }
  const tick = () => {
    push(make());
    setTimeout(tick, 300 + Math.random() * 1400);
  };
  tick();
}

export const getBacklog = (n = 100) => backlog.slice(-n);
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function counts(windowMs) {
  const from = Date.now() - windowMs;
  const c = { success: 0, warning: 0, error: 0 };
  backlog.forEach((e) => e.ts >= from && c[e.status]++);
  return c;
}
