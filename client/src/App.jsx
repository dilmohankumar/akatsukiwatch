import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { api } from './api.js';
import { useSettings } from './store.jsx';
import Icon from './components/Icon.jsx';
import Overview from './pages/Overview.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Connect from './pages/Connect.jsx';
import DateRange from './components/DateRange.jsx';

function Topbar() {
  const { auto, setAuto, theme, setTheme } = useSettings();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <header className="topbar">
      <DateRange />
      <button className={`btn live-btn ${auto ? 'on' : ''}`} onClick={() => setAuto(!auto)} aria-pressed={auto} title={auto ? 'Live: refreshing every 15 seconds. Click to pause.' : 'Paused. Click to refresh every 15 seconds.'}>
        <span className="live-dot" aria-hidden /> Live
      </button>
      <button className="btn icon" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">
        <Icon name={dark ? 'sun' : 'moon'} />
      </button>
    </header>
  );
}

export default function App() {
  const { enabled } = useSettings();
  const [providers, setProviders] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.providers().then(setProviders).catch(setErr);
  }, []);

  const active = providers.filter((p) => enabled.includes(p.id));

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img className="logo" src="/logo.svg" width="28" height="28" alt="" />
          AkatsukiWatch
        </div>
        <nav>
          <NavLink to="/" end><Icon name="overview" /> Overview</NavLink>
          {active.map((p) => (
            <NavLink key={p.id} to={`/p/${p.id}`}><Icon name={p.icon} /> {p.name}</NavLink>
          ))}
          <div className="nav-sep" />
          <NavLink to="/connect"><Icon name="plug" /> Integrations</NavLink>
        </nav>
        <p className="side-foot">Your keys stay in your browser. Demo data is shown until live APIs are connected.</p>
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
  );
}
