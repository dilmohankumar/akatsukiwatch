import { fmt } from '../format.js';

function Spark({ data }) {
  if (!data || data.length < 2) return <div className="spark" />;
  const w = 200;
  const h = 44;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 8)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--s1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export default function Kpi({ k }) {
  const arrow = k.delta > 0 ? '↗' : '↘';
  return (
    <div className="kpi">
      <div className="kpi-l">{k.label}</div>
      <div className="kpi-v">
        {fmt(k.fmt, k.value)}
        {k.delta != null && k.delta !== 0 && (
          <span className={`delta ${k.tone}`} title={k.basis === 'previous' ? 'Change vs the previous period of the same length' : 'Second half of the window vs first half'}>
            {arrow} {Math.abs(k.delta).toFixed(1)}%
          </span>
        )}
      </div>
      {k.sub && <div className="kpi-s">{k.sub}</div>}
      <Spark data={k.spark} />
    </div>
  );
}
