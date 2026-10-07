import { fmt } from '../format.js';

// `replay` changes when the range/tab changes, which remounts the SVG and replays the draw-in animation.
function Spark({ data, replay }) {
  if (!data || data.length < 2) return <div className="spark" />;
  const w = 200;
  const h = 44;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 6)}`).join(' ');
  return (
    <svg key={replay} className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polygon className="spark-fill" points={`0,${h} ${pts} ${w},${h}`} />
      <polyline className="spark-line" points={pts} pathLength="1" fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export default function Kpi({ k, replay }) {
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
      <Spark data={k.spark} replay={replay} />
      {k.spark && k.spark.length > 1 && Math.max(...k.spark) === 0 && <span className="nodata">No data</span>}
    </div>
  );
}
