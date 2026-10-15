import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { fmt, ago } from '../format.js';
import { useSettings } from '../store.jsx';
import { useData } from '../useData.js';
import Icon from '../components/Icon.jsx';
import LiveLogs from '../components/LiveLogs.jsx';
import Loader from '../components/Loader.jsx';

const LABEL = { ok: 'Healthy', warn: 'Attention', crit: 'Critical' };

export default function Overview() {
  const { rangeKey, enabled } = useSettings();
  const ids = enabled.join(',');
  const { data, error } = useData(`ov:${ids}:${rangeKey}`, () => api.overview(enabled), [ids]);

  if (error && !data) return <div className="banner bad">Failed to load overview: {String(error.message)}</div>;
  if (!data) return <Loader label="Loading dashboard" />;

  const lc = data.logCounts;

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1>Dashboard</h1>
          <p>One screen for edge traffic, database, servers, payments, domains and logs.</p>
        </div>
      </div>

      {data.providers.length === 0 && (
        <div className="banner">No integrations enabled. <Link to="/connect">Add one</Link>.</div>
      )}

      <div className="tiles">
        {data.providers.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className={`tile tile-${p.id}`}>
            <div className="tile-h">
              <span className="tile-t"><Icon name={p.icon} /> {p.name}</span>
              <span className={`pill ${p.health.status}`}>{LABEL[p.health.status]}</span>
            </div>
            <div className="tile-note">{p.health.note}</div>
            <div className="tile-k">
              {p.kpis.map((k) => (
                <div key={k.label}>
                  <b className="num">{fmt(k.fmt, k.value)}</b>
                  <span>{k.label}</span>
                </div>
              ))}
            </div>
          </Link>
        ))}
      </div>

      <div className="grid">
        <section className="card" style={{ gridColumn: 'span 8' }}>
          <h3>Alerts &amp; recommendations</h3>
          {data.alerts.length === 0 ? <div className="empty">Nothing to worry about.</div> : (
            <ul className="feed">
              {data.alerts.map((a, i) => (
                <li key={i} className={a.sev}>
                  <i aria-hidden>{{ crit: '✕', warn: '▲', info: 'i' }[a.sev]}</i>
                  <span>{a.msg}<em>{a.source} · {ago(a.ts)}</em></span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" style={{ gridColumn: 'span 4' }}>
          <h3>Logs · last 15 min</h3>
          <div className="logsum">
            {['success', 'warning', 'error'].map((s) => (
              <div key={s} className={s}>
                <b>{lc[s]}</b>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <LiveLogs compact />
          <Link className="link" to="/p/docker" style={{ display: 'inline-block', marginTop: 10 }}>Open all logs →</Link>
        </section>
      </div>
    </div>
  );
}
