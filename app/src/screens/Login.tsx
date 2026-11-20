import { useEffect, useRef, useState } from 'react';
import { call } from '../arena/api';
import { useSession } from '../arena/session';
import { Button, Note, Panel } from '../ui';

/** The bot's App link lands here (#/login?t=…). The token is in the fragment, so it never reaches a server log. */
export function Login({ token }: { token: string }) {
  const { refresh } = useSession();
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'ok'; ref: string; p: string } | { kind: 'error'; msg: string }>({ kind: 'working' });
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    history.replaceState(null, '', `${location.pathname}#/home`); // the token leaves the address bar and history
    if (!token) return setState({ kind: 'error', msg: 'This link has no sign-in code. Ask the bot for a new one.' });
    call<{ kind: string; ref: string }>('session.exchange', { token })
      .then(async (r) => {
        await refresh();
        setState({ kind: 'ok', ref: r.ref, p: r.kind });
        if (r.kind === 'app' || !r.ref) location.hash = '#/arena';
      })
      .catch((e: Error) => setState({ kind: 'error', msg: e.message }));
  }, [token, refresh]);
  return (
    <Panel>
      {state.kind === 'working' && <p className="text-sm">Signing you in…</p>}
      {state.kind === 'ok' && (
        <>
          <p className="text-sm">Signed in on this device for 12 hours.</p>
          <Button className="mt-4" onClick={() => (location.hash = '#/arena')}>Go to the Arena</Button>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <p className="text-sm">{state.msg}</p>
          <Note>Links work once and for 15 minutes.</Note>
        </>
      )}
    </Panel>
  );
}
