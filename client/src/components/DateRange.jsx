import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../store.jsx';

// Same presets as the Cloudflare dashboard, plus "Today" (since local midnight).
const PRESETS = [
  ['today', 'Today'],
  ['30m', 'Last 30 minutes'],
  ['1h', 'Last 1 hour'],
  ['6h', 'Last 6 hours'],
  ['12h', 'Last 12 hours'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['14d', 'Last 14 days'],
  ['30d', 'Last 30 days'],
];
const MAX_DAYS = 31;
const MIN = 60e3;
const UNIT = [
  [/^(m|min|mins|minute|minutes)$/, MIN],
  [/^(h|hr|hrs|hour|hours)$/, 60 * MIN],
  [/^(d|day|days)$/, 24 * 60 * MIN],
  [/^(w|wk|wks|week|weeks)$/, 7 * 24 * 60 * MIN],
  [/^(mo|mos|month|months)$/, 30 * 24 * 60 * MIN],
];

const pad = (n) => String(n).padStart(2, '0');
const toText = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromText = (t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};
const short = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (ms) => { const d = new Date(ms); d.setHours(23, 59, 0, 0); return Math.min(d.getTime(), Date.now()); };

/** "3h", "3 hours", "45 min", "last 2 days", "1.5h" -> milliseconds, or null. Seconds are rounded up to a minute. */
function parseDuration(text) {
  const t = text.trim().toLowerCase().replace(/^(last|past|previous)\s+/, '').replace(/,/g, '.');
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(t);
  if (!m) return null;
  const n = +m[1];
  if (/^(s|sec|secs|second|seconds)$/.test(m[2])) return Math.max(MIN, Math.round(n * 1000));
  const u = UNIT.find(([re]) => re.test(m[2]));
  return u && n > 0 ? Math.round(n * u[1]) : null;
}

function Calendar({ month, setMonth, from, to, onPick }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay() + i));
  const lo = from != null ? startOfDay(from) : null;
  const hi = to != null ? startOfDay(to) : lo;
  return (
    <div className="cal">
      <div className="cal-h">
        <b>{first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>
        <span>
          <button type="button" className="btn icon sm" aria-label="Previous month" onClick={() => setMonth(new Date(first.getFullYear(), first.getMonth() - 1, 1))}>‹</button>
          <button type="button" className="btn icon sm" aria-label="Next month" onClick={() => setMonth(new Date(first.getFullYear(), first.getMonth() + 1, 1))}>›</button>
        </span>
      </div>
      <div className="cal-g">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <i key={d} className="cal-w">{d}</i>)}
        {days.map((d) => {
          const t = d.getTime();
          const inRange = lo != null && t >= lo && t <= hi;
          const edge = t === lo || t === hi;
          const future = t > Date.now();
          return (
            <button key={t} type="button" disabled={future} className={`cal-d ${d.getMonth() !== first.getMonth() ? 'out' : ''} ${inRange ? 'in' : ''} ${edge ? 'edge' : ''}`} onClick={() => onPick(t)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRange() {
  const { range, custom, setRangeSel } = useSettings();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({ from: null, to: null });
  const [picking, setPicking] = useState(false); // true after the first click of a range
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [month, setMonth] = useState(() => new Date());
  const ref = useRef(null);

  const label = range === 'custom' && custom ? `${short(custom.from)} – ${short(custom.to)}` : (PRESETS.find(([id]) => id === range) || PRESETS[5])[1];

  const openPicker = () => {
    const now = Date.now();
    const cur = range === 'custom' && custom ? custom : { from: now - 7 * 864e5, to: now };
    setDraft(cur);
    setStartText(toText(cur.from));
    setEndText(toText(cur.to));
    setMonth(new Date(cur.to));
    setText('');
    setErr('');
    setPicking(false);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => ref.current && !(e.composedPath ? e.composedPath().includes(ref.current) : ref.current.contains(e.target)) && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const apply = (from, to) => {
    if (!(to > from)) return setErr('End must be after start');
    if (to - from > MAX_DAYS * 864e5) return setErr(`Pick at most ${MAX_DAYS} days`);
    setRangeSel('custom', { from, to });
    setOpen(false);
  };

  const onText = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const ms = parseDuration(text);
    if (!ms) return setErr(/^\d+$/.test(text.trim()) ? 'Add a unit, e.g. 3h, 45m, 2d' : 'Try 3h, 3 hours, 45 min, 2 days or 1 week');
    if (ms > MAX_DAYS * 864e5) return setErr(`Pick at most ${MAX_DAYS} days`);
    const now = Date.now();
    apply(now - ms, now);
  };

  const pick = (t) => {
    // first click sets the start, second click sets the end (swapped if earlier)
    if (!picking) {
      setDraft({ from: startOfDay(t), to: null });
      setStartText(toText(startOfDay(t)));
      setEndText('');
      setPicking(true);
      return;
    }
    let from = draft.from;
    let to = endOfDay(t);
    if (startOfDay(t) < startOfDay(from)) [from, to] = [startOfDay(t), endOfDay(from)];
    setDraft({ from, to });
    setStartText(toText(from));
    setEndText(toText(to));
    setPicking(false);
    setErr('');
  };

  const submit = () => {
    const from = fromText(startText);
    const to = fromText(endText);
    if (from == null || to == null) return setErr('Use the format YYYY-MM-DD HH:mm');
    apply(from, to);
  };

  return (
    <div className="dr" ref={ref}>
      <button className="btn dr-btn" onClick={() => (open ? setOpen(false) : openPicker())} aria-haspopup="dialog" aria-expanded={open}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        {label}
      </button>
      {open && (
        <div className="dr-pop" role="dialog" aria-label="Select time range">
          <form onSubmit={onText}>
            <input className="dr-text" value={text} onChange={(e) => { setText(e.target.value); setErr(''); }} placeholder="Custom range: 3h, 3 hours, 3 m…" aria-label="Custom range" autoFocus />
            {err && <div className="dr-err top" role="alert">{err}</div>}
          </form>
          <div className="dr-body">
            <Calendar month={month} setMonth={setMonth} from={draft.from} to={draft.to} onPick={pick} />
            <ul className="dr-presets">
              {PRESETS.map(([id, name]) => (
                <li key={id}>
                  <button type="button" className={range === id ? 'on' : ''} onClick={() => { setRangeSel(id); setOpen(false); }}>{name}</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="dr-foot">
            <label>Start<input value={startText} onChange={(e) => { setStartText(e.target.value); setErr(''); }} placeholder="YYYY-MM-DD HH:mm" /></label>
            <label>End<input value={endText} onChange={(e) => { setEndText(e.target.value); setErr(''); }} placeholder="YYYY-MM-DD HH:mm" /></label>
          </div>
                  <div className="dr-act"><button type="button" className="btn primary" onClick={submit}>Apply</button></div>
        </div>
      )}
    </div>
  );
}
