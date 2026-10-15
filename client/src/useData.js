import { useEffect, useRef, useState } from 'react';
import { useSettings } from './store.jsx';

/** Fetch when `key` changes, and again on every Live tick (one shared 15s timer, see store.jsx). `fn` must be stable per key. */
export function useData(key, fn, deps = []) {
  const { auto, tick } = useSettings();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);

  // the request for this key (shows the loading state)
  useEffect(() => {
    let alive = true;
    keyRef.current = key;
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  // Live: silent refresh whenever the shared timer ticks
  useEffect(() => {
    if (!auto || tick === 0) return undefined;
    let alive = true;
    const k = keyRef.current;
    fnRef
      .current()
      .then((data) => alive && keyRef.current === k && setState({ data, error: null, loading: false }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
