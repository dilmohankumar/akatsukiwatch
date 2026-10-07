import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSettings } from '../store.jsx';
import { useData } from '../useData.js';
import Kpi from '../components/Kpi.jsx';
import Widget from '../components/Widgets.jsx';

export default function Dashboard({ providers }) {
  const { id } = useParams();
  const { range, enabled } = useSettings();
  const { data, error, loading } = useData(`${id}:${range}`, () => api.dashboard(id, range));
  const known = providers.find((p) => p.id === id);

  if (providers.length && !known) return <div className="banner bad">Unknown integration “{id}”.</div>;
  if (error && !data) return <div className="banner bad">Failed to load {id}: {String(error.message)}</div>;
  if (!data || data.meta.id !== id) return <div className="loading">Loading {known?.name || id}…</div>;

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1>{data.meta.name}</h1>
          <p>{data.meta.description}</p>
        </div>
        <div className="page-badges">
          <span className={`pill ${data.health.status}`}>{{ ok: 'Healthy', warn: 'Attention', crit: 'Critical' }[data.health.status]} · {data.health.note}</span>
          <span className={`pill ${data.source === 'live' ? 'ok' : 'neutral'}`}>{data.source === 'live' ? 'Live data' : 'Demo data'}</span>
          {loading && <span className="pill neutral">refreshing…</span>}
        </div>
      </div>

      {data.liveError && <div className="banner bad">Couldn’t load live data, showing demo data instead. Reason: {data.liveError}</div>}

      {!enabled.includes(id) && <div className="banner">This integration is hidden from the sidebar. <Link to="/connect">Manage integrations</Link></div>}

      {data.alerts.length > 0 && (
        <div className="alerts">
          {data.alerts.map((a, i) => (
            <div key={i} className={`alert ${a.sev}`}>
              <i aria-hidden>{{ crit: '✕', warn: '▲', info: 'i' }[a.sev]}</i>
              {a.msg}
            </div>
          ))}
        </div>
      )}

      <div className="kpis">{data.kpis.map((k) => <Kpi key={k.label} k={k} />)}</div>
      <div className="grid">{data.widgets.map((w) => <Widget key={w.id} widget={w} range={range} />)}</div>
    </div>
  );
}
