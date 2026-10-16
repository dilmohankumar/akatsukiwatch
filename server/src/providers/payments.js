import { stepFor } from './cfCore.js';
import { timeline, series, split, rows, sum, kpi, toplist, rng, hash, pick, ago } from '../lib/mock.js';

export const meta = {
  id: 'payments',
  name: 'Payments',
  icon: 'card',
  description: 'Stripe / Razorpay revenue, success rate, failures, refunds and payouts.',
  monitors: [
    'Gross volume, net volume, average ticket',
    'Payment success / failure rate and top decline reasons',
    'Method mix: card, UPI, netbanking, wallet',
    'Refunds, disputes / chargebacks',
    'Webhook delivery failures, payout schedule & balance',
    'Revenue by country / currency',
  ],
  credentialFields: [
    { key: 'provider', label: 'Provider (stripe | razorpay)', type: 'text' },
    { key: 'apiKey', label: 'Restricted read-only key / Key ID', type: 'password' },
    { key: 'apiSecret', label: 'Key secret (Razorpay only)', type: 'password', optional: true },
  ],
  liveApi: 'Stripe Balance Transactions + Events API, or Razorpay Payments API',
};

export async function dashboard(range) {
  const tl = timeline(range);
  const attempts = series(tl, { seed: 'pay-att', base: 0.6, noise: 0.5, amp: 0.5, spike: 0.03, spikeMul: 3 });
  const st = split(tl, attempts, { succeeded: 0.91, failed: 0.07, refunded: 0.015, disputed: 0.005 }, 'pay-st');
  const ticket = 48;
  const volume = st.succeeded.map((n, i) => Math.round(n * ticket * (0.8 + ((i * 31) % 40) / 100)));
  const ok = sum(st.succeeded);
  const total = sum(attempts);
  const failRate = (sum(st.failed) / total) * 100;
  const successRate = 100 - failRate;
  const rate = attempts.map((a, i) => (a ? (st.succeeded[i] / a) * 100 : 100));

  const r = rng(hash('pay-recent') + Math.floor(Date.now() / 60000));
  const recent = Array.from({ length: 8 }, (_, i) => {
    const bad = r() < 0.18;
    return {
      time: ago((i + 1) * (2 + Math.floor(r() * 5)) * 60e3),
      id: `pay_${Math.floor(r() * 1e9).toString(36)}`,
      amount: Math.round((10 + r() * 120) * 100) / 100,
      method: pick(r, ['Card •4242', 'UPI', 'Card •0005', 'Netbanking', 'Wallet']),
      country: pick(r, ['IN', 'US', 'GB', 'SG', 'DE']),
      status: bad ? 'failed' : 'succeeded',
      reason: bad ? pick(r, ['insufficient_funds', 'card_declined', 'authentication_failed', 'bank_timeout']) : '—',
    };
  });

  return {
    health: { status: failRate > 15 ? 'crit' : failRate > 8 ? 'warn' : 'ok', note: `${successRate.toFixed(1)}% success` },
    kpis: [
      kpi('Gross volume', sum(volume), 'usd', volume, { goodWhen: 'up' }),
      kpi('Successful payments', ok, 'int', st.succeeded, { goodWhen: 'up' }),
      kpi('Success rate', successRate, 'pct', rate, { goodWhen: 'up', mode: 'avg' }),
      kpi('Failed payments', sum(st.failed), 'int', st.failed, { goodWhen: 'down' }),
      kpi('Refunds + disputes', sum(st.refunded) + sum(st.disputed), 'int', st.refunded.map((v, i) => v + st.disputed[i]), { goodWhen: 'down' }),
    ],
    widgets: [
      { id: 'vol', type: 'line', title: 'Gross volume', span: 6, unit: 'usd', series: [{ key: 'volume', label: 'Volume' }], data: rows(tl, { volume }) },
      { id: 'st', type: 'bars', title: 'Payments by outcome', span: 6, unit: 'int', series: Object.keys(st).map((k) => ({ key: k, label: k })), data: rows(tl, st) },
      { id: 'fail', type: 'toplist', title: 'Top failure reasons', span: 6, items: toplist('pay-fail', ['card_declined', 'insufficient_funds', 'authentication_failed', 'bank_timeout', 'expired_card'], sum(st.failed), 1.0) },
      { id: 'method', type: 'toplist', title: 'Payment methods', span: 6, items: toplist('pay-method', ['UPI', 'Card', 'Netbanking', 'Wallet', 'Pay later'], ok, 1.1) },
      {
        id: 'recent', type: 'table', title: 'Recent transactions', span: 12,
        columns: [{ key: 'time', label: 'Time', fmt: 'ago' }, { key: 'id', label: 'ID' }, { key: 'amount', label: 'Amount', fmt: 'usd' }, { key: 'method', label: 'Method' }, { key: 'country', label: 'Country' }, { key: 'status', label: 'Status', fmt: 'status' }, { key: 'reason', label: 'Reason' }],
        rows: recent,
      },
      {
        id: 'payouts', type: 'table', title: 'Payouts', span: 12,
        columns: [{ key: 'date', label: 'Arrival' }, { key: 'amount', label: 'Amount', fmt: 'usd' }, { key: 'status', label: 'Status', fmt: 'status' }],
        rows: [{ date: 'Tomorrow', amount: 4820.5, status: 'pending' }, { date: '2 days ago', amount: 5112.0, status: 'paid' }, { date: '4 days ago', amount: 4377.25, status: 'paid' }],
      },
    ],
    alerts: failRate > 6 ? [{ sev: 'warn', msg: `Failure rate ${failRate.toFixed(1)}% — above 6% baseline (top reason: card_declined)`, ts: ago(14 * 60e3) }] : [],
  };
}

// ---------- Live: Stripe (Charges + Payouts) and Razorpay (Payments) over plain HTTPS ----------
const MAX_ROWS = 2000;

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error?.description || `HTTP ${r.status}`);
  return j;
}

async function stripeFetch(win, key) {
  if (!/^(rk|sk)_(live|test)_/.test(key)) throw new Error('Stripe key must start with rk_live_ / rk_test_ (restricted key)');
  const h = { Authorization: `Bearer ${key}` };
  const q = `created[gte]=${Math.floor(win.start / 1000)}&created[lte]=${Math.floor(win.end / 1000)}&limit=100`;
  const txns = [];
  let after = '';
  while (txns.length < MAX_ROWS) {
    const j = await getJson(`https://api.stripe.com/v1/charges?${q}${after}`, h);
    for (const c of j.data) {
      txns.push({
        t: c.created * 1000, id: c.id, amount: c.amount / 100, method: c.payment_method_details?.type || 'other',
        country: c.billing_details?.address?.country || c.payment_method_details?.card?.country || '—',
        status: c.disputed ? 'disputed' : c.status === 'failed' ? 'failed' : c.refunded || c.amount_refunded ? 'refunded' : 'succeeded',
        reason: c.failure_code || '—',
      });
    }
    if (!j.has_more) break;
    after = `&starting_after=${j.data[j.data.length - 1].id}`;
  }
  let payouts = [];
  try {
    const j = await getJson('https://api.stripe.com/v1/payouts?limit=5', h);
    payouts = j.data.map((p) => ({ date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10), amount: p.amount / 100, status: p.status }));
  } catch { /* key may lack payout permission */ }
  return { txns, payouts };
}

async function razorpayFetch(win, id, secret) {
  if (!id || !secret) throw new Error('Razorpay needs both Key ID and Key secret');
  const h = { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
  const txns = [];
  while (txns.length < MAX_ROWS) {
    const j = await getJson(`https://api.razorpay.com/v1/payments?from=${Math.floor(win.start / 1000)}&to=${Math.floor(win.end / 1000)}&count=100&skip=${txns.length}`, h);
    for (const p of j.items) {
      txns.push({
        t: p.created_at * 1000, id: p.id, amount: p.amount / 100, method: p.method || 'other', country: '—',
        status: p.status === 'failed' ? 'failed' : p.status === 'refunded' || p.amount_refunded ? 'refunded' : 'succeeded',
        reason: p.error_description || p.error_code || '—',
      });
    }
    if (j.items.length < 100) break;
  }
  return { txns, payouts: [] };
}

export async function testConnection(creds) {
  const win = { start: Date.now() - 864e5, end: Date.now() };
  const { txns } = await fetchTxns(win, creds);
  return { ok: true, message: `Connected. ${txns.length} payments in the last 24h.` };
}

function fetchTxns(win, creds) {
  const provider = String(creds?.provider || '').trim().toLowerCase();
  const key = String(creds?.apiKey || '').trim();
  if (provider === 'stripe') return stripeFetch(win, key);
  if (provider === 'razorpay') return razorpayFetch(win, key, String(creds?.apiSecret || '').trim());
  throw new Error('Provider must be "stripe" or "razorpay"');
}

const top = (items, field) => {
  const m = new Map();
  items.forEach((x) => m.set(x[field], (m.get(x[field]) || 0) + 1));
  return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
};

export async function live(win, creds) {
  const { txns, payouts } = await fetchTxns(win, creds);
  const [, step] = stepFor(win.dur);
  const first = Math.floor(win.start / step) * step;
  const n = Math.ceil((win.end - first) / step) + 1;
  const ts = Array.from({ length: n }, (_, i) => first + i * step);
  const mk = () => ts.map(() => 0);
  const st = { succeeded: mk(), failed: mk(), refunded: mk(), disputed: mk() };
  const volume = mk();
  for (const x of txns) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((x.t - first) / step)));
    st[x.status][i] += 1;
    if (x.status === 'succeeded') volume[i] += x.amount;
  }
  volume.forEach((v, i) => (volume[i] = Math.round(v * 100) / 100));
  const tl = { ts };
  const ok = sum(st.succeeded);
  const failed = sum(st.failed);
  const attempts = ok + failed;
  const successRate = attempts ? (ok / attempts) * 100 : 100;
  const failRate = 100 - successRate;
  const rate = ts.map((_, i) => { const a = st.succeeded[i] + st.failed[i]; return a ? (st.succeeded[i] / a) * 100 : 100; });
  const recent = [...txns].sort((a, b) => b.t - a.t).slice(0, 10).map((x) => ({ time: x.t, id: x.id, amount: x.amount, method: x.method, country: x.country, status: x.status, reason: x.reason }));

  return {
    health: { status: failRate > 15 ? 'crit' : failRate > 8 ? 'warn' : 'ok', note: `${successRate.toFixed(1)}% success` },
    kpis: [
      kpi('Gross volume', sum(volume), 'usd', volume, { goodWhen: 'up' }),
      kpi('Successful payments', ok, 'int', st.succeeded, { goodWhen: 'up' }),
      kpi('Success rate', successRate, 'pct', rate, { goodWhen: 'up', mode: 'avg' }),
      kpi('Failed payments', failed, 'int', st.failed, { goodWhen: 'down' }),
      kpi('Refunds + disputes', sum(st.refunded) + sum(st.disputed), 'int', st.refunded.map((v, i) => v + st.disputed[i]), { goodWhen: 'down' }),
    ],
    widgets: [
      { id: 'vol', type: 'line', title: 'Gross volume', span: 6, unit: 'usd', series: [{ key: 'volume', label: 'Volume' }], data: rows(tl, { volume }) },
      { id: 'st', type: 'bars', title: 'Payments by outcome', span: 6, unit: 'int', series: Object.keys(st).map((k) => ({ key: k, label: k })), data: rows(tl, st) },
      { id: 'fail', type: 'toplist', title: 'Top failure reasons', span: 6, items: top(txns.filter((x) => x.status === 'failed' && x.reason !== '—'), 'reason') },
      { id: 'method', type: 'toplist', title: 'Payment methods', span: 6, items: top(txns.filter((x) => x.status === 'succeeded'), 'method') },
      {
        id: 'recent', type: 'table', title: 'Recent transactions', span: 12,
        columns: [{ key: 'time', label: 'Time', fmt: 'ago' }, { key: 'id', label: 'ID' }, { key: 'amount', label: 'Amount', fmt: 'usd' }, { key: 'method', label: 'Method' }, { key: 'country', label: 'Country' }, { key: 'status', label: 'Status', fmt: 'status' }, { key: 'reason', label: 'Reason' }],
        rows: recent,
      },
      {
        id: 'payouts', type: 'table', title: 'Payouts', span: 12,
        columns: [{ key: 'date', label: 'Arrival' }, { key: 'amount', label: 'Amount', fmt: 'usd' }, { key: 'status', label: 'Status', fmt: 'status' }],
        rows: payouts,
      },
    ],
    alerts: failRate > 6 && attempts >= 10 ? [{ sev: 'warn', msg: `Failure rate ${failRate.toFixed(1)}% — above 6% baseline`, ts: Date.now() }] : [],
  };
}
