import { useMemo, useState } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import iso from 'i18n-iso-countries';
import { fmt } from '../format.js';

// Computed once: country outlines projected to SVG paths (Antarctica left out, as on the Cloudflare map).
const features = feature(world, world.objects.countries).features.filter((f) => String(f.id) !== '010');
const projection = geoNaturalEarth1().fitExtent([[6, 6], [954, 494]], { type: 'FeatureCollection', features });
const toPath = geoPath(projection);
const SHAPES = features.map((f) => ({ id: String(f.id).padStart(3, '0'), name: f.properties.name, d: toPath(f) }));

// light blue -> navy, like the Cloudflare choropleth
const LIGHT = [189, 215, 250];
const DARK = [11, 58, 122];
const shade = (t) => `rgb(${LIGHT.map((c, i) => Math.round(c + (DARK[i] - c) * t)).join(',')})`;

export default function WorldMap({ widget }) {
  const [tip, setTip] = useState(null);
  const { byId, max } = useMemo(() => {
    const m = new Map();
    for (const it of widget.items) {
      const n = iso.alpha2ToNumeric(it.code);
      if (n) m.set(String(n).padStart(3, '0'), it);
    }
    return { byId: m, max: Math.max(1, ...widget.items.map((i) => i.value)) };
  }, [widget.items]);

  const move = (e, shape, it) => {
    const box = e.currentTarget.ownerSVGElement.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, text: `${it?.label || shape.name}: ${it ? fmt(widget.unit || 'count', it.value) : 'no data'}` });
  };

  return (
    <div className="map" role="img" aria-label={`${widget.title}: ${widget.items.slice(0, 5).map((i) => `${i.label} ${i.value}`).join(', ')}`}>
      <svg viewBox="0 0 960 500" preserveAspectRatio="xMidYMid meet">
        {SHAPES.map((s) => {
          const it = byId.get(s.id);
          return (
            <path
              key={s.id}
              d={s.d}
              fill={it ? shade(Math.sqrt(it.value / max)) : 'var(--surface-2)'}
              stroke="var(--surface)"
              strokeWidth="0.6"
              onMouseMove={(e) => move(e, s, it)}
              onMouseLeave={() => setTip(null)}
            />
          );
        })}
      </svg>
      {tip && <div className="map-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.text}</div>}
    </div>
  );
}
