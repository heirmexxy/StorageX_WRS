import type { Ctx } from '../lib/http';
import { LANGUAGES, smsParts } from '../lib/notify';
import { Page, Csrf, fmtDate } from './layout';

const TOPIC: Record<string, string> = { receipt: 'a receipt', loan: 'a loan', payment: 'a payment', pin: 'their PIN', other: 'something else' };

export function MessagesPage({ c, rows, callbacks, failed, usage, ussdCode, ussdOn }: { c: Ctx; rows: any[]; callbacks: any[]; failed: any[]; usage: any[]; ussdCode: string; ussdOn: boolean }) {
  return (
    <Page c={c} title="Farmer messages">
      <h1>Farmer messages</h1>

      <section className="card">
        <h2>{callbacks.length ? `${callbacks.length} farmer${callbacks.length > 1 ? 's' : ''} asked to be called` : 'No one waiting for a call'}</h2>
        {callbacks.map((cb) => (
          <form key={cb.id} method="post" action={`/admin/callbacks/${cb.id}`} className="callback">
            <Csrf c={c} />
            <span><a href={`/farmers/${cb.code}`}>{cb.full_name}</a>{` about ${TOPIC[cb.topic]}, asked ${fmtDate(cb.created_at)}`}<br /><span className="mono">{cb.phone_e164}</span></span>
            <input name="note" required placeholder="What was done" /><button>Mark called</button>
          </form>
        ))}
      </section>

      <section className="card">
        <h2>USSD</h2>
        <p>{!ussdOn ? 'Switched off in Settings.' : ussdCode ? `Farmers dial ${ussdCode}.` : 'On, but no code is set yet. Add it in Settings once the network assigns one.'}</p>
        {usage.length ? <p className="muted small">{`Last 30 days: ${usage.map((u) => `${u.n} ${u.screen}`).join(', ')}.`}</p> : null}
      </section>

      {failed.length > 0 && (
        <section className="card">
          <h2>Texts that did not go (last 7 days)</h2>
          <table><thead><tr><th>When</th><th>Farmer</th><th>Why</th></tr></thead>
            <tbody>{failed.map((m, k) => <tr key={k}><td>{fmtDate(m.created_at)}</td><td><a href={`/farmers/${m.code}`}>{m.full_name}</a></td><td>{`${m.status}: ${m.error}`}</td></tr>)}</tbody></table>
        </section>
      )}

      <section className="card">
        <h2>Wording and translations</h2>
        <p className="muted">Words in braces are filled in for each farmer. A new wording is used only after someone else in Kitovu approves it, so have a native speaker write or check translations. Until a language is approved, those farmers get English.</p>
        {rows.map((e) => (
          <details key={e.event} className="tmpl">
            <summary><b>{e.label}</b> <span className="muted small">{e.langs.filter((l: any) => l.live).map((l: any) => LANGUAGES[l.language]).join(', ')}{e.langs.some((l: any) => l.draft) ? ' · draft waiting' : ''}</span></summary>
            <p className="small muted">{`Can use: {${e.vars.join('}, {')}}`}</p>
            {e.langs.map((l: any) => (
              <div key={l.language} className="tmpl-lang">
                <h4>{LANGUAGES[l.language]}</h4>
                {l.live ? <p className="small">{l.live.body}{l.live.shipped ? ' (as shipped)' : ''}</p> : <p className="small muted">Not translated: English is sent.</p>}
                {l.draft && (
                  <div className="flash info small">
                    <p>{`Draft by ${l.draft.proposer}: ${l.draft.body}`}<br />{`About ${smsParts(l.draft.body)} text${smsParts(l.draft.body) > 1 ? 's' : ''} long.`}</p>
                    {l.draft.proposed_by !== c.actor.user.id ? (
                      <form method="post" action={`/admin/messages/${l.draft.id}/decide`} className="inline"><Csrf c={c} />
                        <button name="decision" value="approve" className="primary">Approve</button> <button name="decision" value="reject">Reject</button></form>
                    ) : <p>Someone else must approve it.</p>}
                  </div>
                )}
                <form method="post" action="/admin/messages" className="inline"><Csrf c={c} />
                  <input type="hidden" name="event" value={e.event} /><input type="hidden" name="language" value={l.language} />
                  <textarea name="body" rows={2} maxLength={459} defaultValue={l.draft?.body ?? l.live?.body ?? ''} /><button>Propose</button>
                </form>
              </div>
            ))}
          </details>
        ))}
      </section>
    </Page>
  );
}
