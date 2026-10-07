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
const ALL = ['cloudflare', 'mongodb', 'ec2', 'payments', 'domains', 'docker'];

const Ctx = createContext(null);
export const useSettings = () => useContext(Ctx);

export function SettingsProvider({ children }) {
  const [range, setRange] = useState(() => read('opswatch.range', '24h'));
  const [auto, setAuto] = useState(() => read('opswatch.auto', true));
  const [theme, setTheme] = useState(() => read('opswatch.theme', 'system'));
  const [enabled, setEnabled] = useState(() => read('opswatch.enabled', ALL));
  const [creds, setCreds] = useState(loadCreds);

  useEffect(() => write('opswatch.range', range), [range]);
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

  const toggle = (id) => setEnabled((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  return <Ctx.Provider value={{ range, setRange, auto, setAuto, theme, setTheme, enabled, toggle, creds, saveCreds }}>{children}</Ctx.Provider>;
}
