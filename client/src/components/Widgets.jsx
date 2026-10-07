import { useState } from 'react';
import { fmt } from '../format.js';
import TimeChart from './Charts.jsx';
import LiveLogs from './LiveLogs.jsx';
import Status from './Status.jsx';
import WorldMap from './WorldMap.jsx';

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title={done ? 'Copied' : 'Copy'} aria-label={`Copy ${text}`} onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? '✓' : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>}
    </button>
  );
}

function TopList({ widget, filterApi }) {
  const max = Math.max(...widget.items.map((i) => i.value), 1);
  const kind = widget.unit || 'int';
  const canAct = filterApi && widget.filterField;
  if (!widget.items.length) return <div className="empty">No data</div>;
  return (
    <ul className="top">
      {widget.items.map((it) => (
        <li key={it.label} className={canAct ? 'actable' : ''}>
          <span className="top-l" title={it.label}>{it.label}</span>
          <span className="top-bar"><span style={{ width: `${(it.value / max) * 100}%` }} /></span>
          <b>{fmt(kind, it.value)}</b>
          {canAct && (() => {
            const raw = it.raw ?? it.label;
            const on = filterApi.has(widget.filterField, raw);
            return (
              <span className="row-act">
                {on ? (
                  <button type="button" title={`Remove filter: ${it.label}`} aria-label={`Remove filter ${it.label}`} onClick={() => filterApi.remove(widget.filterField, raw)}>✕</button>
                ) : (
                  <>
                    <button type="button" title={`Filter: ${it.label}`} aria-label={`Filter by ${it.label}`} onClick={() => filterApi.add(widget.filterField, 'eq', raw, it.label)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 5h18l-7 8v6l-4-2v-4z" /></svg></button>
                    <button type="button" title={`Exclude: ${it.label}`} aria-label={`Exclude ${it.label}`} onClick={() => filterApi.add(widget.filterField, 'neq', raw, it.label)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg></button>
                  </>
                )}
                <Copy text={it.label} />
              </span>
            );
          })()}
        </li>
      ))}
    </ul>
  );
}

function Table({ widget }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>{widget.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {widget.rows.map((r, i) => (
            <tr key={i}>
              {widget.columns.map((c) => {
                const v = r[c.key];
                if (c.fmt === 'status') return <td key={c.key}><Status value={v} /></td>;
                if (c.fmt === 'days') return <td key={c.key} className={v < 14 ? 'bad-t' : v < 30 ? 'warn-t' : ''}>{v} d</td>;
                return <td key={c.key}>{c.fmt ? fmt(c.fmt, v) : v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Widget({ widget, range, onGroup, filterApi }) {
  const span = { gridColumn: `span ${widget.span || 6}` };
  if (widget.type === 'heading') return <h2 className="sect" style={span}>{widget.title}</h2>;

  let body = null;
  if (widget.type === 'line') body = <TimeChart widget={widget} range={range} filterApi={filterApi} />;
  else if (widget.type === 'bars') body = <TimeChart widget={widget} range={range} stacked filterApi={filterApi} />;
  else if (widget.type === 'toplist') body = <TopList widget={widget} filterApi={filterApi} />;
  else if (widget.type === 'table') body = <Table widget={widget} />;
  else if (widget.type === 'map') body = <WorldMap widget={widget} />;
  else if (widget.type === 'logs') body = <LiveLogs />;
  else if (widget.type === 'notice') body = <p className="muted">{widget.text}</p>;

  // Charts with a "Group by" control and the map get the grey header bar the Cloudflare cards have.
  if (widget.groupable || widget.type === 'map') {
    return (
      <section className={`card headed ${widget.type === 'map' ? 'flush' : ''}`} style={span}>
        <div className="card-head">
          <h3>{widget.title}</h3>
          {widget.groupable && (
            <label className="grp">
              Group by
              <select value={widget.group || 'none'} onChange={(e) => onGroup?.(widget.id, e.target.value)} aria-label={`Group ${widget.title} by`}>
                {widget.groupOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="card-body">{body}</div>
      </section>
    );
  }
  return (
    <section className="card" style={span}>
      <h3>{widget.title}</h3>
      {body}
    </section>
  );
}
