import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
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

/** Latest documents of one collection, pretty-printed as JSON. */
function Docs({ ns }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    api.mongoDocs(ns).then((r) => alive && setState({ docs: r.docs, total: r.total })).catch((e) => alive && setState({ error: e.message }));
    return () => { alive = false; };
  }, [ns]);
  if (state.loading) return <div className="muted">Loading documents…</div>;
  if (state.error) return <div className="banner bad">{state.error}</div>;
  if (!state.docs.length) return <div className="empty">This collection is empty</div>;
  const capped = state.total > state.docs.length;
  return (
    <div className="docs">
      <div className="muted small">
        {capped ? `Showing the latest ${state.docs.length} of ${state.total} documents` : `All ${state.docs.length} documents`}, newest first. Fields that look like passwords or tokens are hidden.
      </div>
      <pre>{JSON.stringify(state.docs, null, 2)}</pre>
    </div>
  );
}

function Table({ widget }) {
  const [open, setOpen] = useState(null);
  const expand = widget.expandDocs || widget.expandChildren;
  const cols = widget.columns.length + (expand ? 1 : 0);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>{expand && <th />}{widget.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {widget.rows.map((r, i) => {
            const key = expand ? r[widget.columns[0].key] : i;
            const isOpen = expand && open === key;
            return (
              <Fragment key={i}>
                <tr className={expand ? 'clickable' : ''} onClick={expand ? () => setOpen(isOpen ? null : key) : undefined}>
                  {expand && <td className="chev">{isOpen ? '▾' : '▸'}</td>}
                  {widget.columns.map((c) => {
                    const v = r[c.key];
                    if (c.fmt === 'status') return <td key={c.key}><Status value={v} /></td>;
                    if (c.fmt === 'days') return <td key={c.key} className={v < 14 ? 'bad-t' : v < 30 ? 'warn-t' : ''}>{v} d</td>;
                    return <td key={c.key} className={c.fmt ? 'num' : ''}>{c.fmt ? fmt(c.fmt, v) : v}</td>;
                  })}
                </tr>
                {isOpen && (
                  <tr className="docs-row">
                    <td colSpan={cols}>
                      {widget.expandChildren
                        ? (r.children?.length ? <div className="nested"><Table widget={{ columns: widget.childColumns, rows: r.children, expandDocs: true }} /></div> : <div className="empty">No collections</div>)
                        : <Docs ns={key} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The "⋯" menu in a chart's top-right corner: Interval -> Auto / 15 minutes / 1 hour / 1 day. */
function IntervalMenu({ widget, onInterval }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
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
  return (
    <div className="kebab" ref={ref}>
      <button type="button" className="kebab-btn" aria-label={`${widget.title} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="kebab-menu" role="menu">
          <div className="kebab-h">Interval</div>
          {widget.intervalOptions.map((o) => (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === widget.interval} onClick={() => { onInterval?.(widget.id, o.id); setOpen(false); }}>
              <span>{o.label}</span>
              {o.id === widget.interval && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Widget({ widget, range, onGroup, onInterval, filterApi }) {
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
    <section className={`card ${widget.intervalable ? 'has-kebab' : ''}`} style={span}>
      <h3>{widget.title}</h3>
      {widget.intervalable && <IntervalMenu widget={widget} onInterval={onInterval} />}
      {body}
    </section>
  );
}
