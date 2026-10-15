import { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { fmt, compact, bytes, fullTime } from '../format.js';
import { useSettings } from '../store.jsx';

const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--muted)']; // 6th = "Other"

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

// ---- x-axis ticks: day boundaries / every few hours, like the Cloudflare dashboard -------------
const MONTH = (d) => d.toLocaleDateString('en-GB', { month: 'short' });
const H = 3600e3;
const D = 24 * H;

function makeTicks(data) {
  const meta = new Map();
  if (data.length < 2) return { ticks: [], meta, dayView: false };
  const first = data[0].t;
  const last = data[data.length - 1].t;
  const span = last - first;
  const step = span <= 1.2 * H ? 10 * 60e3 : span <= 7 * H ? H : span <= 13 * H ? 2 * H : span <= 2 * D ? 4 * H : span <= 10 * D ? D : 2 * D;
  const d0 = new Date(first);
  d0.setHours(0, 0, 0, 0);
  let n = 0;
  for (let t = d0.getTime(); t <= last; t += step) {
    if (t < first) continue;
    const p = data.find((x) => x.t >= t);
    if (p && !meta.has(p.t)) meta.set(p.t, { target: t, first: n++ === 0 });
  }
  return { ticks: [...meta.keys()], meta, dayView: step >= D };
}

function XTick({ x, y, payload, dayView, meta }) {
  const m = meta.get(payload.value);
  if (!m) return null;
  const d = new Date(m.target);
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  let text;
  let bold = false;
  if (midnight && dayView) {
    bold = m.first || d.getDate() === 1;
    text = bold ? MONTH(d) : String(d.getDate());
  } else if (midnight) {
    bold = true;
    text = String(d.getDate());
  } else {
    text = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return (
    <text x={x} y={y + 14} textAnchor="middle" fill="var(--muted)" fontSize={11} fontWeight={bold ? 700 : 400}>
      {text}
    </text>
  );
}

function ChartTooltip({ active, payload, label, unit, series, colorOf }) {
  if (!active || !payload?.length) return null;
  // Preserve legend order regardless of how Recharts stacks the payload.
  const rows = series.map((s, i) => ({ s, i, p: payload.find((x) => x.dataKey === s.key) })).filter((r) => r.p);
  return (
    <div className="tip">
      <div className="tip-h">{fullTime(label)}</div>
      {rows.map(({ s, i, p }) => (
        <div key={s.key} className="tip-r">
          <span className="sw round" style={{ background: colorOf(s, i) }} />
          <span className="tip-l">{s.label}</span>
          <b>{fmt(unit, p.value)}</b>
        </div>
      ))}
    </div>
  );
}

const FunnelIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 5h18l-7 8v6l-4-2v-4z" /></svg>;
const ExcludeIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>;

/** Legend: hovering an entry highlights that series (the rest fade); entries of filterable charts get filter / exclude buttons. */
function Legend({ widget, series, data, unit, colorOf, hot, setHot, sel, setSel, filterApi }) {
  const additive = unit === 'int' || unit === 'count' || unit === 'bytes' || unit === 'usd';
  const canAct = filterApi && widget.filterField;
  const emph = sel ?? hot; // a clicked entry stays highlighted; otherwise follow the hover
  return (
    <div className="legend" onMouseLeave={() => setHot(null)}>
      {series.map((s, i) => {
        const vals = data.map((d) => d[s.key]);
        const v = widget.totals?.[s.key] ?? (additive ? vals.reduce((a, b) => a + b, 0) : vals[vals.length - 1]);
        const raw = widget.rawBy?.[s.key] ?? s.label;
        const active = canAct && hot === s.key;
        const on = canAct && filterApi.has(widget.filterField, raw);
        return (
          <span key={s.key} className={`lg pick ${emph && emph !== s.key ? 'dim' : ''} ${sel === s.key ? 'sel' : ''}`} onMouseEnter={() => setHot(s.key)} onClick={() => setSel(sel === s.key ? null : s.key)} role="button" tabIndex={0} aria-pressed={sel === s.key} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(sel === s.key ? null : s.key))}>
            <span className="sw round" style={{ background: colorOf(s, i) }} />
            {s.label}
            {active ? (
              <span className="lg-act">
                {on ? (
                  <button type="button" title={`Remove filter: ${s.label}`} aria-label={`Remove filter ${s.label}`} onClick={(e) => { e.stopPropagation(); filterApi.remove(widget.filterField, raw); }}>✕</button>
                ) : (
                  <>
                    <button type="button" title={`Filter: ${s.label}`} aria-label={`Filter by ${s.label}`} onClick={(e) => { e.stopPropagation(); filterApi.add(widget.filterField, 'eq', raw, s.label); }}><FunnelIcon /></button>
                    <button type="button" title={`Exclude: ${s.label}`} aria-label={`Exclude ${s.label}`} onClick={(e) => { e.stopPropagation(); filterApi.add(widget.filterField, 'neq', raw, s.label); }}><ExcludeIcon /></button>
                  </>
                )}
              </span>
            ) : (
              <>
                {' '}<b>{fmt(unit, v)}</b>
                {!additive && series.length === 1 && widget.totals?.[s.key] == null && <em> now</em>}
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

function DataView({ series, data, unit }) {
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

export default function TimeChart({ widget, range, stacked, filterApi }) {
  const { series, data, unit } = widget;
  const [table, setTable] = useState(false);
  const [hot, setHot] = useState(null); // legend entry being hovered
  const [sel, setSel] = useState(null); // legend entry that was clicked: only this series is drawn
  // Draw-in animation only on first paint and when the range changes, not on every 15s refresh.
  const [animated, setAnimated] = useState(false);
  useSettings(); // re-render on theme change so CSS-var colours repaint
  useEffect(() => setAnimated(false), [range]);

  useEffect(() => { if (sel && !series.some((x) => x.key === sel)) setSel(null); }, [series, sel]);
  const emph = sel ?? hot; // what to emphasise: the clicked entry, else the hovered one
  const colorOf = (s, i) => widget.colors?.[s.key] || COLORS[i] || COLORS[COLORS.length - 1];
  const { ticks, meta, dayView } = useMemo(() => makeTicks(data), [data]);
  const dense = data.length > 150; // hairline bars: a separator stroke would cover them completely
  const anim = { isAnimationActive: !animated, animationDuration: 900, animationEasing: 'ease-out', onAnimationEnd: () => setAnimated(true) };

  const axes = [
    <CartesianGrid key="g" vertical={false} stroke="var(--grid)" strokeDasharray="3 4" />,
    <XAxis key="x" dataKey="t" ticks={ticks} interval={0} tick={<XTick dayView={dayView} meta={meta} />} tickLine={false} axisLine={false} height={26} />,
    <YAxis key="y" width={56} tickFormatter={axisFmt(unit)} tickLine={{ stroke: 'var(--muted)' }} tickSize={6} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} />,
    <Tooltip key="t" content={<ChartTooltip unit={unit} series={series} colorOf={colorOf} />} cursor={stacked ? { fill: 'var(--grid)', opacity: 0.5 } : { stroke: 'var(--muted)', strokeWidth: 1 }} isAnimationActive={false} />,
  ];

  return (
    <>
      <div className="chart-top">
        <Legend widget={widget} series={series} data={data} unit={unit} colorOf={colorOf} hot={hot} setHot={setHot} sel={sel} setSel={setSel} filterApi={filterApi} />
        <button className="link" onClick={() => setTable((t) => !t)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {widget.note && <div className="note">{widget.note}</div>}
      {table ? (
        <DataView series={series} data={data} unit={unit} />
      ) : (
        <div className="chart" role="img" aria-label={`${widget.title} chart`}>
          <ResponsiveContainer width="100%" height={250}>
            {stacked ? (
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={dense ? 0 : "12%"}>
                {axes}
                {series.map((s, i) => (sel && sel !== s.key ? null : (
                  <Bar key={s.key} dataKey={s.key} stackId="a" fill={colorOf(s, i)} fillOpacity={emph && emph !== s.key ? 0.15 : 1} stroke="var(--surface)" strokeWidth={dense ? 0 : 1} {...anim} />
                )))}
              </BarChart>
            ) : (
              <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                {axes}
                {series.map((s, i) => (sel && sel !== s.key ? null : (
                  <Line key={s.key} dataKey={s.key} type="linear" stroke={colorOf(s, i)} strokeWidth={2} strokeOpacity={emph && emph !== s.key ? 0.12 : 1} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} {...anim} />
                )))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
