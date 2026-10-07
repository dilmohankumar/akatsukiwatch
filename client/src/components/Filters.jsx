import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

// Operator symbols + labels, as in the Cloudflare filter form. "list" fields read as has / does not have.
const OPS = {
  eq: ['=', 'equals'],
  neq: ['≠', 'does not equal'],
  contains: ['⊇', 'contains'],
  ncontains: ['⊉', 'does not contain'],
  starts: ['⇥', 'starts with'],
  nstarts: ['⦸', 'does not start with'],
  ends: ['⇤', 'ends with'],
  nends: ['⦸', 'does not end with'],
  in: ['∈', 'is in'],
  nin: ['∉', 'is not in'],
};
const LIST_LABEL = { eq: 'has', neq: 'does not have', in: 'has any of' };
const opLabel = (op, kind) => (kind === 'list' && LIST_LABEL[op]) || OPS[op]?.[1] || op;
const blank = () => ({ f: '', o: '', v: '' });
const multi = (op, kind) => op === 'in' || op === 'nin' || (kind === 'list' && op === 'in');

function useOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return undefined;
    // composedPath() is the path at dispatch time, so it still works after React removed the clicked element
    const down = (e) => ref.current && !(e.composedPath ? e.composedPath().includes(ref.current) : ref.current.contains(e.target)) && onOutside();
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [ref, onOutside, active]);
}

const Chevron = () => (
  <svg className="cb-chev" width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6l3-3 3 3M3 10l3 3 3-3" /></svg>
);

/** Searchable list: type to filter, click or Enter to pick, × to clear. */
function FieldCombo({ fields, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const selected = fields.find((f) => f.id === value);
  const list = useMemo(() => fields.filter((f) => f.label.toLowerCase().includes(q.trim().toLowerCase())), [fields, q]);
  const pick = (f) => {
    onChange(f.id);
    setOpen(false);
    setQ('');
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && list[active]) { e.preventDefault(); pick(list[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };
  return (
    <div className="cb" ref={ref}>
      <input
        className="cb-in"
        role="combobox"
        aria-expanded={open}
        aria-label="Field"
        placeholder="Field"
        value={open ? q : selected?.label || ''}
        onFocus={() => { setOpen(true); setQ(''); setActive(0); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKey}
      />
      {selected && !open && <button type="button" className="cb-x" aria-label="Clear field" onClick={() => onChange('')}>×</button>}
      <Chevron />
      {open && (
        <ul className="cb-list" role="listbox">
          {list.length === 0 && <li className="cb-empty">No matching field</li>}
          {list.map((f, i) => (
            <li key={f.id} role="option" aria-selected={f.id === value} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(f); }}>
              {f.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Operator list showing a symbol, label and a check mark on the current choice. */
function OpSelect({ ops, kind, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div className="cb" ref={ref}>
      <button type="button" className="cb-in cb-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label="Operator" onClick={() => setOpen((o) => !o)}>
        {value ? <span className="op-sym">{OPS[value]?.[0]}</span> : <span className="ph">Operator</span>}
      </button>
      <Chevron />
      {open && (
        <ul className="cb-list ops" role="listbox">
          {ops.map((op) => (
            <li key={op} role="option" aria-selected={op === value} className={op === value ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); onChange(op); setOpen(false); }}>
              <span className="op-sym">{OPS[op][0]}</span>
              <span className="op-lbl">{opLabel(op, kind)}</span>
              {op === value && <span className="op-ck" aria-hidden>✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Free-text value with suggestions from the zone's own data (paths, browsers, countries...). */
function ValueBox({ provider, spec, op, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const many = multi(op, spec?.kind);
  // for "is in" the text is a comma separated list; suggest for the last item being typed
  const token = many ? value.split(',').pop().trim() : value.trim();

  useEffect(() => {
    if (!open || !spec?.suggest) return undefined;
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      api.suggest(provider, spec.id, token)
        .then((r) => alive && setItems(r.values || []))
        .catch(() => alive && setItems([]))
        .finally(() => alive && setBusy(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, token, spec, provider]);

  const pick = (v) => {
    if (many) {
      const head = value.split(',').slice(0, -1).map((x) => x.trim()).filter(Boolean);
      onChange([...head, v].join(','));
    } else {
      onChange(v);
      setOpen(false);
    }
  };
  const shown = items.filter((v) => v !== value).slice(0, 12);
  return (
    <div className="cb" ref={ref}>
      <input
        className="cb-in"
        aria-label="Value"
        disabled={disabled}
        value={value}
        placeholder={many ? 'comma separated' : spec?.placeholder || 'Value'}
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}
      />
      {spec?.suggest && !disabled && <Chevron />}
      {open && !disabled && (shown.length > 0 || busy) && (
        <ul className="cb-list" role="listbox">
          {shown.length === 0 && <li className="cb-empty">Searching…</li>}
          {shown.map((v) => (
            <li key={v} role="option" onMouseDown={(e) => { e.preventDefault(); pick(v); }}>{v}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Add filter" button (with a count badge) and its popover. */
export function FilterButton({ provider, fields, filters, onApply }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([blank()]);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const byId = useMemo(() => Object.fromEntries(fields.map((f) => [f.id, f])), [fields]);

  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);

  const openIt = () => {
    setRows(filters.length ? filters.map((f) => ({ ...f })) : [blank()]);
    setOpen(true);
  };
  // an edited row no longer matches the readable label it came with
  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, l: undefined } : r)));
  const pickField = (i, id) => {
    // choosing a field resets the value and defaults the operator to "equals"
    set(i, { f: id, o: id ? 'eq' : '', v: '' });
  };
  const pickOp = (i, o) => set(i, { o, v: multi(o, byId[rows[i].f]?.kind) === multi(rows[i].o, byId[rows[i].f]?.kind) ? rows[i].v : '' });
  const complete = rows.every((r) => r.f && r.o && r.v.trim());

  return (
    <div className="flt" ref={ref}>
      <button className={`btn flt-btn ${filters.length ? 'has' : ''}`} onClick={() => (open ? setOpen(false) : openIt())} aria-haspopup="dialog" aria-expanded={open}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 5h18l-7 8v6l-4-2v-4z" /></svg>
        Add filter
        {filters.length > 0 && <span className="flt-badge" aria-label={`${filters.length} active`}>{filters.length}</span>}
      </button>
      {open && (
        <div className="flt-pop" role="dialog" aria-label="Filters">
          {rows.map((r, i) => {
            const spec = byId[r.f];
            return (
              <Fragment key={i}>
                {i > 0 && <div className="and-wrap"><span className="and">AND</span></div>}
                <div className="flt-row">
                  <span className="bar" aria-hidden />
                  <FieldCombo fields={fields} value={r.f} onChange={(id) => pickField(i, id)} />
                  <OpSelect ops={spec?.ops || []} kind={spec?.kind} value={r.o} disabled={!r.f} onChange={(o) => pickOp(i, o)} />
                  <ValueBox provider={provider} spec={spec} op={r.o} value={r.v} disabled={!r.f || !r.o} onChange={(v) => set(i, { v })} />
                  <button type="button" className="icon-btn" aria-label="Remove filter" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [blank()]))}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                  </button>
                </div>
              </Fragment>
            );
          })}
          <div className="flt-foot">
            <button type="button" className="add" disabled={rows.length >= 8} onClick={() => setRows((rs) => [...rs, blank()])}>+ Add filter</button>
            <span>
              <button type="button" className="txt" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary apply" disabled={!complete} onClick={() => { onApply(rows.map((r) => ({ ...r, v: r.v.trim() }))); setOpen(false); }}>Apply</button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The "Filters" row between the tabs and the KPI cards. */
export function FilterChips({ fields, filters, onChange }) {
  if (!filters.length) return null;
  const spec = (id) => fields.find((f) => f.id === id);
  return (
    <div className="fchips" aria-label="Active filters">
      <span className="lbl">Filters</span>
      {filters.map((f, i) => (
        <span key={i} className="fchip">
          <span className="g">{spec(f.f)?.label || f.f}</span>
          <span className="g">{opLabel(f.o, spec(f.f)?.kind)}</span>
          <b>{f.l || f.v}</b>
          <button type="button" aria-label={`Remove filter ${spec(f.f)?.label || f.f}`} onClick={() => onChange(filters.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
      <button type="button" className="clear" onClick={() => onChange([])}>Clear all</button>
    </div>
  );
}
