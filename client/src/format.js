const nf = new Intl.NumberFormat('en-US');

export function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  const shown = v >= 100 || i === 0 ? v.toFixed(0) : String(+v.toFixed(2)); // 15.18 MB, 3.8 MB, 172 kB
  return `${n < 0 ? '-' : ''}${shown} ${u[i]}`;
}

export function compact(n) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

// 829 -> "829", 3869 -> "3.87k", 1250000 -> "1.25M" (same style as the Cloudflare dashboard)
export function count(n) {
  const a = Math.abs(n);
  if (a < 1000) return nf.format(Math.round(n));
  if (a < 1e6) return `${(n / 1e3).toFixed(2)}k`;
  if (a < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmt(kind, v) {
  if (v == null || Number.isNaN(v)) return '—';
  switch (kind) {
    case 'int': return nf.format(Math.round(v));
    case 'bytes': return bytes(v);
    case 'pct': return `${(+v).toFixed(2)}%`;
    case 'count': return count(v);
    case 'ms': return `${Math.round(v)} ms`;
    case 'sec': return `${(+v).toFixed(1)} s`;
    case 'usd': return v >= 10000 ? `$${compact(v)}` : `$${nf.format(+(+v).toFixed(2))}`;
    case 'ago': return ago(v);
    case 'days': return `${v} d`;
    default: return String(v);
  }
}

export function tick(range, t) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return range === '7d' || range === '30d' ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : hm;
}

export function fullTime(t) {
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
