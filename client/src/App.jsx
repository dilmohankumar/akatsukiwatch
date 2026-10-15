import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { api } from './api.js';
import { useSettings } from './store.jsx';
import Icon from './components/Icon.jsx';
import Overview from './pages/Overview.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Connect from './pages/Connect.jsx';
import { createPortal } from 'react-dom';
import DateRange from './components/DateRange.jsx';
import { ControlsSlot, useControlsSlot } from './controlsSlot.js';

// seconds until the next Live refresh, e.g. "12s"
function Countdown() {
  const { nextAt } = useSettings();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <span className="live-count">{Math.max(0, Math.ceil((nextAt - now) / 1000))}s</span>;
}

function Topbar() {
  const { auto, setAuto, theme, setTheme } = useSettings();
  const { slots } = useControlsSlot();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const controls = (
    <>
      <DateRange />
      <button className={`btn live-btn ${auto ? 'on' : ''}`} onClick={() => setAuto(!auto)} aria-pressed={auto} title={auto ? 'Live: refreshing every 15 seconds. Click to pause.' : 'Paused. Click to refresh every 15 seconds.'}>
        <span className="live-dot" aria-hidden /> Live {auto && <Countdown />}
      </button>
      <button className="btn icon" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">
        <Icon name={dark ? 'sun' : 'moon'} />
      </button>
    </>
  );
  // on a page with a tab row the controls are drawn there instead, and the top bar is left empty
  if (slots.rest) return <>{createPortal(controls, slots.rest)}</>;
  return <header className="topbar">{controls}</header>;
}

export default function App() {
  const { enabled } = useSettings();
  // after a reload the browser would restore an old scroll position; always start at the top
  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    document.querySelector('.main')?.scrollTo?.(0, 0);
  }, []);
  const [providers, setProviders] = useState([]);
  const [err, setErr] = useState(null);
  const [slots, setSlotsState] = useState({ filter: null, rest: null });
  const setSlots = (patch) => setSlotsState((cur) => ((Object.keys(patch).every((k) => cur[k] === patch[k])) ? cur : { ...cur, ...patch }));

  useEffect(() => {
    api.providers().then(setProviders).catch(setErr);
  }, []);

  const active = providers.filter((p) => enabled.includes(p.id));

  return (
    <ControlsSlot.Provider value={{ slots, setSlots }}>
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img className="logo" src="/logo.svg" width="28" height="28" alt="" />
          AkatsukiWatch
        </div>
        <nav>
          <NavLink to="/" end><Icon name="overview" /> Dashboard</NavLink>
          {active.map((p) => (
            <NavLink key={p.id} to={`/p/${p.id}`}><Icon name={p.icon} /> {p.name}</NavLink>
          ))}
          <div className="nav-sep" />
          <NavLink to="/connect"><Icon name="plug" /> Integrations</NavLink>
        </nav>
        <p className="side-foot">Your keys stay in your browser.</p>
      </aside>
      <main className="main">
        <Topbar />
        {err && <div className="banner bad">Can’t reach the API: {String(err.message)}</div>}
        <Routes>
          <Route path="/" element={<Overview providers={providers} />} />
          <Route path="/p/:id" element={<Dashboard providers={providers} />} />
          <Route path="/connect" element={<Connect providers={providers} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
    </ControlsSlot.Provider>
  );
}
