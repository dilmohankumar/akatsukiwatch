import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const read = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: keep in-memory only */
  }
};

export const loadCreds = () => read('opswatch.creds', {});
// The selected time range lives in localStorage so api.js can read it at call time.
export const loadRange = () => ({ range: read('opswatch.range', '24h'), custom: read('opswatch.custom', null) });
const ALL = ['cloudflare', 'mongodb', 'ec2', 'payments', 'domains', 'docker'];

export const LIVE_MS = 15000;
const Ctx = createContext(null);
export const useSettings = () => useContext(Ctx);

export function SettingsProvider({ children }) {
  const [sel, setSel] = useState(loadRange);
  const [auto, setAuto] = useState(() => read('opswatch.auto', true));
  const [theme, setTheme] = useState(() => read('opswatch.theme', 'system'));
  const [enabled, setEnabled] = useState(() => read('opswatch.enabled', ALL));
  const [creds, setCreds] = useState(loadCreds);
  // Live: one shared timer. `tick` goes up every LIVE_MS; `nextAt` is when the next refresh happens (for the countdown).
  const [tick, setTick] = useState(0);
  const [nextAt, setNextAt] = useState(() => Date.now() + LIVE_MS);
  useEffect(() => {
    if (!auto) return undefined;
    setNextAt(Date.now() + LIVE_MS);
    // turning Live on refreshes right away
    setTick((t) => t + 1);
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setNextAt(Date.now() + LIVE_MS);
    }, LIVE_MS);
    return () => clearInterval(id);
  }, [auto]);

  useEffect(() => write('opswatch.auto', auto), [auto]);
  useEffect(() => write('opswatch.enabled', enabled), [enabled]);
  useEffect(() => {
    write('opswatch.theme', theme);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const saveCreds = useCallback((id, values) => {
    setCreds((c) => {
      const next = { ...c };
      if (values) next[id] = values;
      else delete next[id];
      write('opswatch.creds', next);
      return next;
    });
  }, []);

  // Written synchronously: the data hooks fetch in an effect right after this state change.
  const setRangeSel = useCallback((range, custom = null) => {
    write('opswatch.range', range);
    write('opswatch.custom', custom);
    setSel({ range, custom });
  }, []);
  const range = sel.range;
  const rangeKey = range === 'custom' ? `custom:${sel.custom?.from}-${sel.custom?.to}` : range;

  const toggle = (id) => setEnabled((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  return <Ctx.Provider value={{ range, custom: sel.custom, rangeKey, setRangeSel, auto, setAuto, tick, nextAt, theme, setTheme, enabled, toggle, creds, saveCreds }}>{children}</Ctx.Provider>;
}
