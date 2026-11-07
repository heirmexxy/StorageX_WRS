import type { Ctx } from '../lib/http';
import { PARTNER_TYPES } from '../lib/applications';
import { Page, Csrf, Field, Select, fmtDate } from './layout';

export function ApplyPage({ c, states, error, v = {} }: { c: Ctx; states: { code: string; name: string }[]; error?: string; v?: Record<string, string> }) {
  const chosen = v.type ?? String(c.query.type ?? '');
  const groups = [...new Set(Object.values(PARTNER_TYPES).map((t) => t.group))];
  return (
    <Page c={c} title="Partner with StorageX" bare wide>
      <section className="card">
        <h1>Partner with StorageX</h1>
        <p>StorageX by Kitovu turns produce in certified warehouses into receipts that farmers can borrow against and sell. It works because many partners each play a part. Choose yours, tell us about your organisation, and our team will call you, usually within five working days.</p>
        <p className="muted small">Farmers do not apply here: they register through a Kitovu field partner in their community.</p>
        {error && <p className="flash error">{error}</p>}
        <form method="post" action="/apply">
          <Csrf c={c} />
          <fieldset className="ptypes">
            <legend>How would you like to partner with us?</legend>
            {groups.map((g) => (
              <div key={g} className="ptgroup">
                <h2>{g}</h2>
                {Object.entries(PARTNER_TYPES).filter(([, t]) => t.group === g).map(([k, t]) => (
                  <label key={k} className="ptype">
                    <input type="radio" name="type" value={k} defaultChecked={chosen === k} required />
                    <span className="pt-body">
                      <b>{t.label}</b>
                      <span><i>You bring:</i>{` ${t.gives}`}</span>
                      <span><i>You get:</i>{` ${t.gets}`}</span>
                      <small>{`In the form, tell us: ${t.ask.charAt(0).toLowerCase()}${t.ask.slice(1)}.`}</small>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <Field label="Organisation name" name="org_name" value={v.org_name} required />
          <div className="grid">
            <Field label="Your name" name="contact_name" value={v.contact_name} required autoComplete="name" />
            <Field label="Your role" name="contact_role" value={v.contact_role} />
            <Field label="Work email" name="email" type="email" value={v.email} required autoComplete="email" />
            <Field label="Phone" name="phone" type="tel" value={v.phone} required autoComplete="tel" />
          </div>
          <Select label="State (head office or main site)" name="state_code" value={v.state_code} blank="Choose…" options={states.map((s) => [s.code, s.name])} />
          <label className="field"><span>About your organisation</span><textarea name="about" rows={4} defaultValue={v.about} /><small>Answer the question shown under the partner type you chose.</small></label>
          <label className="field"><span>Anything else?</span><textarea name="message" rows={3} defaultValue={v.message} /></label>
          <label className="hp" aria-hidden="true">Website <input name="website" tabIndex={-1} autoComplete="off" /></label>
          <label className="check"><input type="checkbox" name="agree" value="1" required /> Kitovu may contact me about this application and keep these details while it is reviewed.</label>
          <button className="primary">Send application</button>
        </form>
      </section>
    </Page>
  );
}

export function ApplyThanksPage({ c }: { c: Ctx }) {
  return (
    <Page c={c} title="Application received" bare>
      <section className="card narrow">
        <h1>Thank you</h1>
        <p>We have your application. Someone from Kitovu will call or email you. If it is approved, the person you named receives an invitation link to set up their StorageX account.</p>
      </section>
    </Page>
  );
}

export function ApplicationsPage({ c, rows, status, link }: { c: Ctx; rows: any[]; status: string; link?: { code: string | null; link: string | null } }) {
  return (
    <Page c={c} title="Applications">
      <h1>Partner applications</h1>
      <p className="muted">Public form: <a href="/apply">/apply</a>. Approving creates the organisation (onboarding) and an invitation for the contact as its administrator. Check the organisation first: licence, references, a call.</p>
      {link && link.link && (
        <div className="flash ok">
          <p>Organisation {link.code} created. Send this invitation link to the contact (valid 72 hours):</p>
          <p className="copy mono">{link.link}</p>
        </div>
      )}
      <nav className="tabs">{['new', 'approved', 'rejected', 'spam', 'all'].map((s) => <a key={s} href={`?status=${s}`} className={s === status ? 'on' : ''}>{s}</a>)}</nav>
      {!rows.length && <section className="card"><p>No applications here.</p></section>}
      {rows.map((p) => (
        <section className="card" key={p.id}>
          <h2>{p.org_name} <small className="muted">{PARTNER_TYPES[p.partner_type]?.label ?? p.partner_type}{PARTNER_TYPES[p.partner_type] && !PARTNER_TYPES[p.partner_type].adminRole ? ' · no account yet' : ''}</small></h2>
          <dl className="facts">
            <dt>Contact</dt><dd>{p.contact_name}{p.details?.role ? `, ${p.details.role}` : ''} · {p.email} · {p.phone_e164}</dd>
            <dt>State</dt><dd>{p.state_name ?? '—'}</dd>
            <dt>About</dt><dd>{p.details?.about || '—'}</dd>
            {p.message && <><dt>Message</dt><dd>{p.message}</dd></>}
            <dt>Received</dt><dd>{fmtDate(p.created_at)}</dd>
            {p.status !== 'new' && <><dt>Decision</dt><dd>{p.status} by {p.reviewed_by_name} {fmtDate(p.reviewed_at)}{p.review_note ? ` — ${p.review_note}` : ''}{p.org_code ? ` · org ${p.org_code}` : ''}</dd></>}
          </dl>
          {p.status === 'new' && (
            <div className="row">
              <form method="post" action={`/admin/applications/${p.id}/approve`} className="row">
                <Csrf c={c} />{PARTNER_TYPES[p.partner_type]?.adminRole && <input name="code" placeholder="Org code (optional)" aria-label="Organisation code" />}<input name="note" placeholder="Note" aria-label="Note" />
                <button className="primary">{PARTNER_TYPES[p.partner_type]?.adminRole ? 'Approve and invite' : 'Approve for follow-up'}</button>
              </form>
              <form method="post" action={`/admin/applications/${p.id}/reject`} className="row">
                <Csrf c={c} /><input name="note" placeholder="Reason" aria-label="Reason" /><label className="check"><input type="checkbox" name="spam" value="1" /> spam</label><button className="danger">Reject</button>
              </form>
            </div>
          )}
        </section>
      ))}
    </Page>
  );
}
