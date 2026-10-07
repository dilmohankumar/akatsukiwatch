import { useMemo } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSettings } from '../store.jsx';
import { useData } from '../useData.js';
import Kpi from '../components/Kpi.jsx';
import Widget from '../components/Widgets.jsx';
import { FilterButton, FilterChips } from '../components/Filters.jsx';

const Sk = ({ w = 80, h = 12, style }) => <span className="sk" style={{ width: w, height: h, ...style }} />;

// Placeholder shown while a dashboard (or a tab) loads, same idea as the grey blocks in Cloudflare's UI.
function Skeleton() {
  return (
    <>
      <div className="kpis" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="kpi">
            <Sk w={90} />
            <Sk w={130} h={26} style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
      <div className="grid" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <section key={i} className="card" style={{ gridColumn: 'span 6' }}>
            <Sk w={150} />
            <div className="sk-legend"><Sk w={64} /><Sk w={44} /><Sk w={56} /></div>
            <div className="sk-chart" />
          </section>
        ))}
      </div>
    </>
  );
}

const parse = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

export default function Dashboard({ providers }) {
  const { id } = useParams();
  const { rangeKey, enabled } = useSettings();
  const [sp, setSp] = useSearchParams();
  const known = providers.find((p) => p.id === id);
  const tabs = known?.tabs;
  const tab = tabs ? (tabs.some((t) => t.id === sp.get('tab')) ? sp.get('tab') : tabs[0].id) : undefined;

  // Filters and "Group by" choices live in the URL, so a view can be shared or reloaded.
  const filtersText = sp.get('filters') || '';
  const groupsText = sp.get('groups') || '';
  const filters = useMemo(() => parse(filtersText, []), [filtersText]);
  const groups = useMemo(() => parse(groupsText, {}), [groupsText]);
  const patch = (changes) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
    setSp(next, { replace: true });
  };
  const setFilters = (list) => patch({ filters: list.length ? JSON.stringify(list) : '' });
  // hover buttons on legends and lists. A value that is already filtered shows "remove" instead of filter / exclude.
  const addFilter = (field, op, value, label) => {
    if (filters.some((f) => f.f === field && f.o === op && f.v === value)) return;
    // picking another single value for the same field replaces it ("equals A" AND "equals B" could never match)
    const rest = op === 'eq' ? filters.filter((f) => !(f.f === field && f.o === 'eq')) : filters;
    setFilters([...rest, { f: field, o: op, v: value, l: label }]);
  };
  const removeFilter = (field, value) => setFilters(filters.filter((f) => !(f.f === field && f.o === 'eq' && f.v === value)));
  const hasFilter = (field, value) => filters.some((f) => f.f === field && f.o === 'eq' && f.v === value);
  const setGroup = (widgetId, value) => {
    const g = { ...groups };
    if (value === 'none') delete g[widgetId];
    else g[widgetId] = value;
    patch({ groups: Object.keys(g).length ? JSON.stringify(g) : '' });
  };

  const { data, error, loading } = useData(`${id}:${rangeKey}:${tab || ''}:${filtersText}:${groupsText}`, () => api.dashboard(id, { tab, filters: filtersText, groups: groupsText }));

  if (providers.length && !known) return <div className="banner bad">Unknown integration “{id}”.</div>;
  if (error && !data) return <div className="banner bad">Failed to load {id}: {String(error.message)}</div>;
  const ready = data && data.meta.id === id && (!tabs || data.tab === tab);
  const meta = ready ? data.meta : known;
  const canFilter = known?.filterFields && !(known.noFilterTabs || []).includes(tab) && ready && data.source === 'live';

  return (
    <div className={`page theme-${id}`}>
      <div className="page-h">
        <div>
          <h1>{meta?.name || id}</h1>
          <p>{meta?.description}</p>
        </div>
        {ready && (
          <div className="page-badges">
            {data.health && <span className={`pill ${data.health.status}`}>{{ ok: 'Healthy', warn: 'Attention', crit: 'Critical' }[data.health.status]} · {data.health.note}</span>}
            <span className={`pill ${data.source === 'live' ? 'ok' : 'neutral'}`}>{data.source === 'live' ? 'Live data' : 'Demo data'}</span>
            {loading && <span className="pill neutral">refreshing…</span>}
          </div>
        )}
      </div>

      {tabs && (
        <div className="tabrow">
          <div className="seg tabs" role="tablist" aria-label={`${meta?.name} sections`}>
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => patch({ tab: t.id === tabs[0].id ? '' : t.id })}>{t.label}</button>
            ))}
          </div>
          {canFilter && <FilterButton provider={id} fields={known.filterFields} filters={filters} onApply={setFilters} />}
        </div>
      )}

      {canFilter && <FilterChips fields={known.filterFields} filters={filters} onChange={setFilters} />}
      {error && data && <div className="banner bad">{String(error.message)}</div>}

      {!ready ? (
        <Skeleton />
      ) : (
        <>
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

          <div className={`stale-wrap ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
          <div className="kpis">{data.kpis.map((k) => <Kpi key={k.label} k={k} replay={`${rangeKey}:${tab}`} />)}</div>
          <div className="grid">{data.widgets.map((w) => <Widget key={w.id} widget={w} range={rangeKey} onGroup={setGroup} filterApi={canFilter ? { add: addFilter, remove: removeFilter, has: hasFilter } : undefined} />)}</div>
          </div>
        </>
      )}
    </div>
  );
}
