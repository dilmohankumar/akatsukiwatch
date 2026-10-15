import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Status from './Status.jsx';

const FILTERS = ['all', 'success', 'warning', 'error'];
const MAX = 200;

export default function LiveLogs({ compact = false }) {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('all');
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  const buffer = useRef([]);
  pausedRef.current = paused;

  useEffect(() => {
    let es;
    let alive = true;
    api.recentLogs().then((r) => alive && setEvents(r.reverse())).catch(() => {});
    es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (pausedRef.current) {
        buffer.current.unshift(ev);
        return;
      }
      setEvents((e) => [ev, ...e].slice(0, MAX));
    };
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  const resume = () => {
    setEvents((e) => [...buffer.current, ...e].slice(0, MAX));
    buffer.current = [];
    setPaused(false);
  };

  const counts = events.reduce((a, e) => ({ ...a, [e.status]: (a[e.status] || 0) + 1 }), {});
  const shown = filter === 'all' ? events : events.filter((e) => e.status === filter);

  return (
    <div>
      <div className="log-bar">
        <div className="seg" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f}
              {f !== 'all' && <span className="cnt">{counts[f] || 0}</span>}
            </button>
          ))}
        </div>
        <span className={`live ${connected && !paused ? 'on' : ''}`}>{paused ? 'paused' : connected ? 'live' : 'reconnecting…'}</span>
        <button className="btn sm" onClick={() => (paused ? resume() : setPaused(true))}>{paused ? 'Resume' : 'Pause'}</button>
      </div>
      <div className={`logs${compact ? ' compact' : ''}`} role="log" aria-live="off">
        {shown.length === 0 && <div className="empty">No events yet…</div>}
        {shown.map((e) => (
          <div key={e.id} className={`log ${e.status}`}>
            <time>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</time>
            <Status value={e.status} />
            <span className="src">{e.source}</span>
            <span className="msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
