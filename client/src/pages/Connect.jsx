import { useState } from 'react';
import { api } from '../api.js';
import { useSettings } from '../store.jsx';
import Icon from '../components/Icon.jsx';

function Card({ p }) {
  const { enabled, toggle, creds, saveCreds } = useSettings();
  const saved = creds[p.id];
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(saved || {});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await api.test(p.id, vals).catch((err) => ({ ok: false, message: err.message }));
    if (r.ok) saveCreds(p.id, vals);
    setMsg(r);
    setBusy(false);
  };

  return (
    <section className="card conn">
      <div className="conn-h">
        <span className="tile-t"><Icon name={p.icon} /> {p.name}</span>
        <label className="toggle" title="Show in sidebar & overview">
          <input type="checkbox" checked={enabled.includes(p.id)} onChange={() => toggle(p.id)} />
          <span /> Show
        </label>
      </div>
      <p className="muted">{p.description}</p>
      <details>
        <summary>What you can monitor ({p.monitors.length})</summary>
        <ul className="mon">{p.monitors.map((m) => <li key={m}>{m}</li>)}</ul>
        <p className="muted small">Live source: {p.liveApi}</p>
      </details>

      <div className="conn-f">
        <span className={`pill ${saved ? 'ok' : 'neutral'}`}>{saved ? 'Credentials saved (this browser)' : 'Using demo data'}</span>
        <button className="btn sm" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : saved ? 'Edit credentials' : 'Connect'}</button>
      </div>

      {open && (
        <form className="form" onSubmit={submit}>
          {p.credentialFields.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input type={f.type} value={vals[f.key] || ''} autoComplete="off" spellCheck={false} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            </label>
          ))}
          <div className="form-a">
            <button className="btn primary" disabled={busy}>{busy ? 'Testing…' : 'Save & test'}</button>
            {saved && <button type="button" className="btn" onClick={() => { saveCreds(p.id, null); setVals({}); setMsg(null); }}>Remove</button>}
          </div>
          {msg && <div className={`banner ${msg.ok ? '' : 'bad'}`}>{msg.message}</div>}
        </form>
      )}
    </section>
  );
}

export default function Connect({ providers }) {
  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1>Integrations</h1>
          <p>Pick what you want to monitor and bring your own credentials. Everything works with demo data until live APIs are enabled.</p>
        </div>
      </div>
      <div className="banner">
        <b>Privacy:</b> credentials are stored only in this browser’s localStorage and sent to the AkatsukiWatch API per request over HTTPS. The server doesn’t store or log them. Always use <b>read-only</b> keys.
      </div>
      <div className="conn-grid">{providers.map((p) => <Card key={p.id} p={p} />)}</div>
    </div>
  );
}
