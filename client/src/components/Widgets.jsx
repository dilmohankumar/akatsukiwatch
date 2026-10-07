import { fmt } from '../format.js';
import TimeChart from './Charts.jsx';
import LiveLogs from './LiveLogs.jsx';
import Status from './Status.jsx';

function TopList({ widget }) {
  const max = Math.max(...widget.items.map((i) => i.value), 1);
  const kind = widget.unit || 'int';
  return (
    <ul className="top">
      {widget.items.map((it) => (
        <li key={it.label}>
          <span className="top-l" title={it.label}>{it.label}</span>
          <span className="top-bar"><span style={{ width: `${(it.value / max) * 100}%` }} /></span>
          <b>{fmt(kind, it.value)}</b>
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

export default function Widget({ widget, range }) {
  let body = null;
  if (widget.type === 'line') body = <TimeChart widget={widget} range={range} />;
  else if (widget.type === 'bars') body = <TimeChart widget={widget} range={range} stacked />;
  else if (widget.type === 'toplist') body = <TopList widget={widget} />;
  else if (widget.type === 'table') body = <Table widget={widget} />;
  else if (widget.type === 'logs') body = <LiveLogs />;
  return (
    <section className="card" style={{ gridColumn: `span ${widget.span || 6}` }}>
      <h3>{widget.title}</h3>
      {body}
    </section>
  );
}
