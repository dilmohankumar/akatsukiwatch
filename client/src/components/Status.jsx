const OK = ['up', 'running', 'succeeded', 'paid', 'on', 'locked', 'ok', 'success', '2/2 passed'];
const WARN = ['warning', 'warn', 'pending', 'unlocked', 'off'];
const BAD = ['down', 'failed', 'error', 'stopped', 'disputed', 'crit'];

export default function Status({ value }) {
  const v = String(value).toLowerCase();
  const kind = OK.includes(v) ? 'ok' : WARN.includes(v) ? 'warn' : BAD.includes(v) ? 'bad' : 'neutral';
  const icon = { ok: '✓', warn: '▲', bad: '✕', neutral: '•' }[kind];
  return (
    <span className={`badge ${kind}`}>
      <i aria-hidden>{icon}</i>
      {value}
    </span>
  );
}

