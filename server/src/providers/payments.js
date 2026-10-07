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
    { key: 'apiSecret', label: 'Key secret (Razorpay only)', type: 'password' },
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
