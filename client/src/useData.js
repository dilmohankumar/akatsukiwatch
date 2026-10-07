import { useEffect, useState } from 'react';
import { useSettings } from './store.jsx';

/** Fetch + optional polling. `fn` must be stable per key. */
export function useData(key, fn, deps = []) {
  const { auto } = useSettings();
  const [state, setState] = useState({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    const run = () =>
      fn()
        .then((data) => alive && setState({ data, error: null, loading: false }))
        .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    setState((s) => ({ ...s, loading: true }));
    run();
    const t = auto ? setInterval(run, 15000) : null;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto, ...deps]);

  return state;
}
