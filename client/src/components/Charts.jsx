import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { fmt, compact, bytes, tick, fullTime } from '../format.js';
import { useSettings } from '../store.jsx';

const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

const axisFmt = (unit) => (v) => {
  switch (unit) {
    case 'bytes': return bytes(v);
    case 'pct': return `${Math.round(v)}%`;
    case 'usd': return `$${compact(v)}`;
    case 'ms': return `${Math.round(v)}ms`;
    case 'sec': return `${v}s`;
    default: return compact(v);
  }
};

function ChartTooltip({ active, payload, label, unit, series }) {
  if (!active || !payload?.length) return null;
  // Preserve legend order regardless of how Recharts stacks the payload.
  const rows = series.map((s, i) => ({ s, i, p: payload.find((x) => x.dataKey === s.key) })).filter((r) => r.p);
  return (
    <div className="tip">
      <div className="tip-h">{fullTime(label)}</div>
      {rows.map(({ s, i, p }) => (
        <div key={s.key} className="tip-r">
          <span className="sw" style={{ background: COLORS[i] }} />
          <span className="tip-l">{s.label}</span>
          <b>{fmt(unit, p.value)}</b>
        </div>
      ))}
    </div>
  );
}

function Legend({ series, data, unit }) {
  const additive = unit === 'int' || unit === 'bytes' || unit === 'usd';
  return (
    <div className="legend">
      {series.map((s, i) => {
        const vals = data.map((d) => d[s.key]);
        const v = additive ? vals.reduce((a, b) => a + b, 0) : vals[vals.length - 1];
        return (
          <span key={s.key} className="lg">
            <span className="sw" style={{ background: COLORS[i] }} />
            {s.label} <b>{fmt(unit, v)}</b>
            {!additive && series.length === 1 && <em> now</em>}
          </span>
        );
      })}
    </div>
  );
}

function DataView({ series, data, unit, range }) {
  return (
    <div className="tbl-wrap" style={{ maxHeight: 260 }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Time</th>
            {series.map((s) => <th key={s.key}>{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((d) => (
            <tr key={d.t}>
              <td>{fullTime(d.t)}</td>
              {series.map((s) => <td key={s.key}>{fmt(unit, d[s.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TimeChart({ widget, range, stacked }) {
  const { series, data, unit } = widget;
  const [table, setTable] = useState(false);
  useSettings(); // re-render on theme change so CSS-var colours repaint

  const common = {
    data,
    margin: { top: 8, right: 8, left: 0, bottom: 0 },
  };
  const axes = [
    <CartesianGrid key="g" vertical={false} stroke="var(--grid)" strokeDasharray="3 4" />,
    <XAxis key="x" dataKey="t" tickFormatter={(t) => tick(range, t)} tickLine={false} axisLine={{ stroke: 'var(--grid)' }} tick={{ fill: 'var(--muted)', fontSize: 11 }} minTickGap={42} />,
    <YAxis key="y" width={52} tickFormatter={axisFmt(unit)} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} />,
    <Tooltip key="t" content={<ChartTooltip unit={unit} series={series} />} cursor={stacked ? { fill: 'var(--grid)', opacity: 0.5 } : { stroke: 'var(--muted)', strokeDasharray: '3 3' }} isAnimationActive={false} />,
  ];

  return (
    <>
      <div className="chart-top">
        <Legend series={series} data={data} unit={unit} />
        <button className="link" onClick={() => setTable((t) => !t)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {widget.note && <div className="note">{widget.note}</div>}
      {table ? (
        <DataView series={series} data={data} unit={unit} range={range} />
      ) : (
        <div className="chart" role="img" aria-label={`${widget.title} chart`}>
          <ResponsiveContainer width="100%" height={240}>
            {stacked ? (
              <BarChart {...common} barCategoryGap="12%">
                {axes}
                {series.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} stackId="a" fill={COLORS[i]} stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} />
                ))}
              </BarChart>
            ) : (
              <LineChart {...common}>
                {axes}
                {series.map((s, i) => (
                  <Line key={s.key} dataKey={s.key} type="monotone" stroke={COLORS[i]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
