import type { Ctx } from '../lib/http';
import { can } from '../lib/rbac';
import { fmtNGN } from '../lib/money';
import type { Farmer, Issue, FieldPartner, Warehouse, Commodity } from '../lib/registry';
import { mask, CATEGORIES } from '../lib/registry';
import { ID_TYPES, REJECT_REASONS, CONSENT_TEXT, type Submission } from '../lib/kyc';
import { Page, Csrf, Field, Select, fmtDate, fmtDay, Pager } from './layout';
import { EXPLAIN } from '../lib/agents/data-steward';

type Opt = { code: string; name: string };
const LEVEL = ['Registered', 'ID checked', 'Lender verified'];
export const Level = ({ n }: { n: number }) => <span className={`badge l${n}`}>{`Level ${n} · ${LEVEL[n]}`}</span>;
const kitovu = (c: Ctx) => c.membership?.org_kind === 'kitovu';

// ---------- farmers ----------
export function FarmersPage({ c, rows, q, states }: { c: Ctx; rows: Farmer[]; q: Record<string, string>; states: Opt[] }) {
  return (
    <Page c={c} title="Farmers">
      <div className="head">
        <h1>Farmers</h1>
        {can(c.membership, 'farmers.edit') && <a className="button primary" href="/farmers/new">Register a farmer</a>}
      </div>
      {c.membership?.org_kind === 'lender' && <p className="muted">You see only farmers who have agreed to share their record with {c.membership.org_name}.</p>}
      <form className="filters card" method="get">
        <input name="q" defaultValue={q.q} placeholder="Name, phone, code or community" aria-label="Search" />
        <select name="state" defaultValue={q.state ?? ''} aria-label="State"><option value="">All states</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
        <select name="level" defaultValue={q.level ?? ''} aria-label="Identity level"><option value="">Any level</option>{LEVEL.map((l, i) => <option key={i} value={i}>{`Level ${i}: ${l}`}</option>)}</select>
        {kitovu(c) && <label className="check"><input type="checkbox" name="review" value="1" defaultChecked={q.review === '1'} /> Needs review</label>}
        <button>Search</button>
      </form>
      <section className="card">
        <p className="muted">{`${(rows[0] as any)?.total_rows ?? 0} farmer${(rows[0] as any)?.total_rows === 1 ? '' : 's'}`}</p>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Phone</th><th>Place</th><th>Crops</th><th>Identity</th></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td><a href={`/farmers/${f.code}`}>{f.code}</a></td>
                <td>{f.full_name}{f.needs_review && <> <span className="badge warn">{`review${f.open_issues ? ` (${f.open_issues})` : ''}`}</span></>}{f.source === 'legacy_import' && <> <span className="badge">legacy</span></>}</td>
                <td className="mono">{f.phone_e164 ? mask(f.phone_e164) : '—'}</td>
                <td>{[f.community, f.state_name].filter(Boolean).join(', ') || '—'}</td>
                <td>{f.commodities.join(', ') || '—'}</td>
                <td><Level n={f.kyc_level} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager c={c} rows={rows as any} />
      </section>
    </Page>
  );
}

function FarmerFields({ f, states, crops, partner }: { f?: Partial<Farmer>; states: Opt[]; crops: Opt[]; partner?: boolean }) {
  return (
    <>
      <div className="grid">
        <Select label="Who is storing" name="kind" value={f?.kind ?? 'individual'} options={[['individual', 'A farmer (individual)'], ['agribusiness', 'An agribusiness (company, co-op or enterprise)']]} />
        <Field label="Full name, or business name" name="full_name" value={f?.full_name} required hint="A farmer: first name and surname as on their ID. An agribusiness: its registered name." />
        <Field label="Phone" name="phone" type="tel" value={f?.phone_e164 ?? ''} inputMode="tel" hint="Their own or a family phone they can reach" />
        <Select label="Sex" name="sex" value={f?.sex} blank="Not recorded" options={[['female', 'Female'], ['male', 'Male']]} />
        <Field label="Year of birth" name="year_of_birth" value={f?.year_of_birth ?? ''} inputMode="numeric" />
        <Select label="State" name="state_code" value={f?.state_code} blank="Choose…" options={states.map((s) => [s.code, s.name])} />
        <Field label="Community / village" name="community" value={f?.community ?? ''} />
        {partner && <Field label="Field partner code (optional)" name="field_partner_code" hint="SXA-… of the agent who brought this farmer" />}
      </div>
      <fieldset className="grid">
        <legend>Agribusiness only</legend>
        <Field label="Registration number" name="business_reg_no" value={f?.business_reg_no ?? ''} hint="As on the certificate, e.g. RC 1348965 or BN 3456789" />
        <Field label="Contact person" name="contact_person" value={f?.contact_person ?? ''} hint="Full name of who speaks for the business; their ID is checked" />
        <Field label="Their role" name="contact_role" value={f?.contact_role ?? ''} hint="e.g. Managing director, Co-op secretary" />
      </fieldset>
      <fieldset className="crops">
        <legend>Crops they grow</legend>
        {crops.map((k) => (
          <label key={k.code} className="check"><input type="checkbox" name="commodities" value={k.code} defaultChecked={f?.commodities?.includes(k.code)} /> {k.name}</label>
        ))}
      </fieldset>
    </>
  );
}

export function FarmerNewPage({ c, states, crops, error, values, duplicate }: { c: Ctx; states: Opt[]; crops: Opt[]; error?: string; values?: any; duplicate?: boolean }) {
  return (
    <Page c={c} title="Register a farmer">
      <h1>Register a farmer</h1>
      {error && <p className="flash error">{error}</p>}
      <form method="post" action="/farmers/new" className="card" encType="multipart/form-data">
        <Csrf c={c} />
        <FarmerFields f={values} states={states} crops={crops} partner />
        <Field label="Profile photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="user" hint="A clear face photo (for an agribusiness, the contact person). Optional now; add it later from the record." />
        {duplicate && <label className="check"><input type="checkbox" name="confirm_duplicate" value="1" /> This is a different person who shares the phone</label>}
        <p className="muted">After saving you can confirm the phone by SMS code and start the identity check.</p>
        <button className="primary">Save farmer</button>
      </form>
    </Page>
  );
}

export interface FarmerView {
  f: Farmer; states: Opt[]; crops: Opt[]; subs: Submission[]; consents: any[]; verifs: any[]; issues: Issue[]; lenders: { id: string; name: string }[];
  codeSent?: 'phone' | 'consent'; consentLender?: string;
  pm: { required: boolean; sms: boolean; voice: boolean; attested: boolean };
  deliveries: any[];
  messaging?: { msgs: any[]; ussd: any; languages: Record<string, string> };
  credit?: any;
  money?: { payout: any; banks: { name: string; code: string }[]; checks: any[]; canPay: boolean; canBvn: boolean };
}

export function FarmerPage({ c, v }: { c: Ctx; v: FarmerView }) {
  const { f } = v;
  const edit = can(c.membership, 'farmers.edit');
  const pending = v.subs.find((s) => s.status === 'pending');
  const lender = c.membership?.org_kind === 'lender';
  const myVerif = v.verifs.find((x) => x.customer_ref && !x.revoked_at);
  const phoneDone = !!f.phone_verified_at || (f.phone_check_method === 'attested' && v.pm.attested);
  return (
    <Page c={c} title={f.full_name}>
      <div className="head">
        <h1>{f.full_name} <small className="mono">{f.code}</small></h1>
        <span><Level n={f.kyc_level} />{c.membership?.org_kind !== 'lender' && <> <a className="button" href={`/farmers/${f.code}/statement`}>Statement</a></>}</span>
      </div>
      {f.status !== 'active' && <p className="flash info">This record is {f.status}.</p>}

      <div className="cols">
        <section className="card">
          <h2>Details</h2>
          <div className="profile-head">
            {f.profile_photo_id ? <img className="avatar" src={`/files/${f.profile_photo_id}`} alt={`Photo of ${f.kind === 'agribusiness' ? f.contact_person ?? f.full_name : f.full_name}`} width="96" height="96" />
              : <span className="avatar avatar-empty" aria-hidden="true">{f.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>}
            <div>
              <b>{f.kind === 'agribusiness' ? 'Agribusiness' : 'Farmer'}</b>
              {f.kind === 'agribusiness' && <p className="small">{[f.business_reg_no, f.contact_person && `contact: ${f.contact_person}${f.contact_role ? `, ${f.contact_role}` : ''}`].filter(Boolean).join(' · ')}</p>}
              {edit && (
                <form method="post" action={`/farmers/${f.code}/photo`} encType="multipart/form-data" className="row">
                  <Csrf c={c} />
                  <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" capture="user" aria-label="Profile photo" required />
                  <button>{f.profile_photo_id ? 'Replace photo' : 'Add photo'}</button>
                </form>
              )}
            </div>
          </div>
          {edit ? (
            <form method="post" action={`/farmers/${f.code}`}>
              <Csrf c={c} />
              <FarmerFields f={f} states={v.states} crops={v.crops} />
              <button className="primary">Save changes</button>
            </form>
          ) : (
            <dl className="facts">
              <dt>Phone</dt><dd>{f.phone_e164 ?? '—'}</dd>
              <dt>Place</dt><dd>{[f.community, f.state_name].filter(Boolean).join(', ') || '—'}</dd>
              <dt>Crops</dt><dd>{f.commodities.join(', ') || '—'}</dd>
              <dt>Sex · born</dt><dd>{f.sex ?? '—'} · {f.year_of_birth ?? '—'}</dd>
            </dl>
          )}
          <p className="muted small">Registered {fmtDay(f.created_at)}{f.registered_by_name ? ` by ${f.registered_by_name}` : ''} · source: {f.source.replace('_', ' ')} · updated {fmtDate(f.updated_at)}</p>
        </section>

        <section className="card">
          <h2>Identity check</h2>
          <ol className="steps">
            <li className={phoneDone ? 'done' : ''}>
              <b>{f.phone_check_method === 'attested' && !f.phone_verified_at ? 'Presence witnessed (no phone check)' : 'Phone confirmed'}</b>{' '}
              {f.phone_verified_at ? <small>{`${f.phone_check_method === 'voice' ? 'by voice call' : 'by text'} · ${fmtDate(f.phone_verified_at)}`}</small>
                : f.phone_check_method === 'attested' ? <small>{`witness: ${f.phone_attestation?.witness_name}, ${f.phone_attestation?.witness_role} · recorded by ${f.phone_attestation?.by_name}`}</small>
                : !v.pm.required ? <small>optional</small> : null}
              {edit && !f.phone_verified_at && f.kyc_level === 0 && (
                <div>
                  {f.phone_e164 && (v.pm.sms || v.pm.voice) && (
                    <form method="post" action={`/farmers/${f.code}/phone/send`} className="row">
                      <Csrf c={c} />
                      {v.pm.sms && <button name="channel" value="sms" className={v.codeSent === 'phone' ? '' : 'primary'}>Text a code</button>}
                      {v.pm.voice && <button name="channel" value="voice">Call with a code</button>}
                      <small className="muted">The call reads the code aloud: use it for basic phones or if the farmer does not read texts.</small>
                    </form>
                  )}
                  {v.codeSent === 'phone' && (
                    <form method="post" action={`/farmers/${f.code}/phone/confirm`} className="row">
                      <Csrf c={c} /><input name="otp" inputMode="numeric" placeholder="6-digit code" aria-label="Code the farmer received" required /><button className="primary">Confirm</button>
                    </form>
                  )}
                  {!f.phone_e164 && <p className="muted">No phone on the record.</p>}
                  {v.pm.attested && f.phone_check_method !== 'attested' && (
                    <details className="attest" open={!f.phone_e164}>
                      <summary>No working phone or no signal? Record a witnessed attestation</summary>
                      <form method="post" action={`/farmers/${f.code}/attest`} className="grid">
                        <Csrf c={c} />
                        <Select label="Why no code" name="reason" blank="Choose…" required options={[['no_phone', 'Farmer has no phone'], ['no_signal', 'No network here'], ['code_not_received', 'Code did not arrive'], ['shared_phone', 'Phone belongs to someone else']]} />
                        <Field label="Witness full name" name="witness_name" required hint="Someone local who knows the farmer" />
                        <Field label="Witness role" name="witness_role" required hint="e.g. cooperative chairman, village head" />
                        <Field label="Witness phone" name="witness_phone" type="tel" required hint="Kitovu may call to confirm" />
                        <label className="check"><input type="checkbox" name="declare" value="1" required /> I met this farmer in person with the witness, who confirmed who they are</label>
                        <button>Record attestation</button>
                      </form>
                    </details>
                  )}
                </div>
              )}
            </li>
            <li className={f.kyc_level >= 1 ? 'done' : pending ? 'wait' : ''}>
              <b>ID and photo checked by Kitovu</b>{' '}
              {f.kyc_level >= 1 ? <small>{ID_TYPES[f.id_type!]?.label} ending {f.id_last4}</small> : pending ? <small>{`waiting for review since ${fmtDate(pending.submitted_at)}`}</small> : null}
              {edit && f.kyc_level === 0 && (phoneDone || !v.pm.required) && !pending && (
                <form method="post" action={`/farmers/${f.code}/kyc`} encType="multipart/form-data" className="kyc">
                  <Csrf c={c} />
                  <Select label="ID type" name="id_type" blank="Choose…" required options={Object.entries(ID_TYPES).map(([k, t]) => [k, t.label])} />
                  <Field label="ID number" name="id_number" required autoComplete="off" hint="Only the last 4 characters are kept." />
                  <Field label="Photo of the ID (front)" name="id_doc" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required />
                  <Field label="Photo of the farmer’s face" name="selfie" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required hint="Plain background, good light, no cap or glasses." />
                  <button className="primary">Send for review</button>
                </form>
              )}
            </li>
            <li className={f.kyc_level >= 2 ? 'done' : ''}>
              <b>Lender has opened an account</b>
              {v.verifs.filter((x) => !x.revoked_at).map((x, i) => <div key={i}><small>{x.org_name}{x.customer_ref ? ` · your ref ${x.customer_ref}` : ''} · {fmtDay(x.verified_at)}</small></div>)}
              {lender && can(c.membership, 'farmers.verify_account') && (
                myVerif ? (
                  <form method="post" action={`/farmers/${f.code}/lender-revoke`}><Csrf c={c} /><button className="link danger">Withdraw our confirmation</button></form>
                ) : f.kyc_level >= 1 ? (
                  <form method="post" action={`/farmers/${f.code}/lender-verify`} className="row">
                    <Csrf c={c} /><input name="customer_ref" placeholder="Your customer reference" aria-label="Customer reference" required /><button className="primary">Confirm account opened</button>
                  </form>
                ) : <p className="muted">Available after Kitovu checks the farmer’s ID.</p>
              )}
            </li>
          </ol>
          {v.subs.filter((s) => s.status !== 'pending').length > 0 && (
            <details><summary>Earlier checks</summary>
              <ul>{v.subs.filter((s) => s.status !== 'pending').map((s) => <li key={s.id}>{fmtDay(s.submitted_at)}: {s.status} by {s.reviewed_by_name}{s.review_note ? ` — ${s.review_note}` : ''}</li>)}</ul>
            </details>
          )}
        </section>
      </div>

      {(edit || kitovu(c)) && (
        <section className="card">
          <h2>Consent to share with lenders</h2>
          <p className="muted">A lender sees this farmer only after the farmer agrees. Read the statement aloud in a language they understand.</p>
          {v.consents.length > 0 && (
            <table>
              <thead><tr><th>Lender</th><th>How</th><th>Given</th><th>Recorded by</th><th></th></tr></thead>
              <tbody>{v.consents.map((x) => (
                <tr key={x.id}>
                  <td>{x.org_name}</td>
                  <td>{x.method === 'sms_code' ? 'SMS code' : 'Signed form'}{x.evidence_file_id && kitovu(c) && <> · <a href={`/files/${x.evidence_file_id}`}>form</a></>}</td>
                  <td>{fmtDay(x.given_at)}{x.withdrawn_at && <><br /><span className="badge warn">{`withdrawn ${fmtDay(x.withdrawn_at)}`}</span></>}</td>
                  <td>{x.recorded_by_name}</td>
                  <td>{!x.withdrawn_at && kitovu(c) && edit && (
                    <form method="post" action={`/farmers/${f.code}/consent/${x.id}/withdraw`} className="row"><Csrf c={c} /><input name="reason" placeholder="Reason" aria-label="Reason" required /><button className="link danger">Withdraw</button></form>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {edit && v.lenders.length > 0 && (
            <div className="consent">
              {f.phone_verified_at && (v.pm.sms || v.pm.voice) ? <form method="post" action={`/farmers/${f.code}/consent/send`} className="row">
                <Csrf c={c} />
                <select name="org_id" defaultValue={v.consentLender ?? ''} aria-label="Lender" required><option value="">Choose lender…</option>{v.lenders.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
                {v.pm.sms && <button name="channel" value="sms">Text a consent code</button>}
                {v.pm.voice && <button name="channel" value="voice">Call with a consent code</button>}
              </form> : <p className="muted">No confirmed phone: record consent on the signed or thumb-printed paper form.</p>}
              {v.consentLender && <blockquote>{CONSENT_TEXT(v.lenders.find((l) => l.id === v.consentLender)?.name ?? 'the lender')}</blockquote>}
              <form method="post" action={`/farmers/${f.code}/consent`} encType="multipart/form-data" className="grid">
                <Csrf c={c} />
                <Select label="Lender" name="org_id" value={v.consentLender} blank="Choose…" required options={v.lenders.map((l) => [l.id, l.name])} />
                <Select label="How the farmer agreed" name="method" value={v.consentLender ? 'sms_code' : 'paper_form'} options={f.phone_verified_at ? [['sms_code', 'Gave the code (text or call)'], ['paper_form', 'Signed or thumb-printed the paper form']] : [['paper_form', 'Signed or thumb-printed the paper form']]} />
                {f.phone_verified_at && <Field label="Code (if by code)" name="otp" inputMode="numeric" />}
                <Field label="Photo of the form (if on paper)" name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" />
                <label className="check"><input type="checkbox" name="read_aloud" value="1" required /> I read the statement to the farmer and they agreed</label>
                <button className="primary">Record consent</button>
              </form>
            </div>
          )}
        </section>
      )}

      {v.money && (v.money.canPay || v.money.canBvn || v.money.payout || v.money.checks.length > 0) && (
        <section className="card">
          <h2>Payout account and identity checks</h2>
          <p>{v.money.payout ? `Payouts go to ${v.money.payout.bank_name} …${v.money.payout.account_last4} (${v.money.payout.account_name})${v.money.payout.name_match === 'override' ? `; name differs: ${v.money.payout.override_note}` : ''}.` : 'No payout account saved.'}</p>
          {v.money.canPay && v.money.banks.length > 0 && (
            <form method="post" action={`/farmers/${v.f.code}/payout-account`} className="inline-form"><Csrf c={c} />
              <label className="field"><span>Bank</span><select name="bank_code" required><option value="">Choose…</option>{v.money.banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
              <label className="field"><span>Account number (checked with the bank, not kept)</span><input name="account_number" inputMode="numeric" pattern="[0-9]{10}" required /></label>
              <label className="field"><span>Note, only if the bank’s name differs</span><input name="override_note" /></label>
              <button>{v.money.payout ? 'Replace account' : 'Save account'}</button>
            </form>
          )}
          {v.money.checks.length > 0 && <ul>{v.money.checks.map((k: any, i: number) => <li key={i}>{`${k.kind.toUpperCase()} …${k.last4}: ${k.result.replace('_', ' ')} (${k.provider}, ${fmtDay(k.checked_at)}, ${k.checked_by})`}</li>)}</ul>}
          {v.money.canBvn && (
            <form method="post" action={`/farmers/${v.f.code}/bvn-check`} className="row"><Csrf c={c} /><input name="bvn" inputMode="numeric" pattern="[0-9]{11}" placeholder="BVN (11 digits, not kept)" aria-label="BVN" required /><button>Check BVN</button></form>
          )}
        </section>
      )}
      {v.credit && (
        <section className="card">
          <h2>Credit history</h2>
          <p><span className={`badge ${v.credit.tier === 'problem' ? 'bad' : v.credit.tier === 'new' ? '' : 'ok'}`}>{v.credit.label}</span>{` ${v.credit.summary}`}</p>
          {v.credit.uplift_bp > 0 && <p className="small">{`On this record a lender may choose to allow up to ${v.credit.uplift_bp / 100} points more loan-to-value than its usual policy. The lender decides; StorageX does not change any limit.`}</p>}
          {v.credit.loans.length > 0 && (
            <table><thead><tr><th>Loan</th><th>Lender</th><th>Amount</th><th>Paid out</th><th>Due</th><th>Result</th></tr></thead>
              <tbody>{v.credit.loans.map((l: any) => <tr key={l.loan_no}><td className="mono">{l.loan_no}</td><td>{l.lender}</td><td>{fmtNGN(l.principal, { decimals: false })}</td><td>{l.disbursed_on ? fmtDay(l.disbursed_on) : '—'}</td><td>{l.due_on ? fmtDay(l.due_on) : '—'}</td><td>{l.result}</td></tr>)}</tbody></table>
          )}
        </section>
      )}
      {v.deliveries.length > 0 && (
        <section className="card">
          <h2>Deliveries</h2>
          <table>
            <thead><tr><th>Ref</th><th>Crop</th><th>Net</th><th>Warehouse</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>{v.deliveries.map((d) => (
              <tr key={d.ref}><td>{can(c.membership, 'stock.manage') ? <a className="mono" href={`/intakes/${d.ref}`}>{d.ref}</a> : d.ref}</td><td>{d.commodity}</td>
                <td>{`${Number(d.net).toLocaleString('en-NG')} kg`}</td><td>{d.warehouse}</td><td>{fmtDay(d.captured_at)}</td><td>{d.status}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}

      {v.messaging && (
        <section className="card">
          <h2>Messages and USSD</h2>
          <p className="muted small">{v.messaging.ussd?.ussd_pin_set_at ? `USSD PIN set ${fmtDay(v.messaging.ussd.ussd_pin_set_at)}${v.messaging.ussd.last_used ? `, last used ${fmtDay(v.messaging.ussd.last_used)}` : ', not used yet'}.` : 'No USSD PIN yet: the farmer chooses one the first time they dial.'}
            {v.messaging.ussd?.ussd_locked_until && new Date(v.messaging.ussd.ussd_locked_until) > new Date() ? ' Locked after wrong PINs.' : ''}</p>
          {edit && (
            <form method="post" action={`/farmers/${f.code}/messaging`} className="inline">
              <Csrf c={c} />
              <label className="field"><span>Language for texts</span><select name="language" defaultValue={v.messaging.ussd?.language ?? 'en'}>{Object.entries(v.messaging.languages).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                <small>Texts go in English until Kitovu approves wording in this language.</small></label>
              <label className="check"><input type="hidden" name="reminders" value="0" /><input type="checkbox" name="reminders" value="1" defaultChecked={v.messaging.ussd?.sms_reminders ?? true} /> Send due-date reminders</label>
              <button>Save</button>
            </form>
          )}
          {kitovu(c) && edit && (v.messaging.ussd?.ussd_pin_set_at || v.messaging.ussd?.ussd_locked_until) && (
            <form method="post" action={`/farmers/${f.code}/ussd-reset`} className="inline">
              <Csrf c={c} />
              <label className="field"><span>Reset USSD PIN</span><input name="reason" required placeholder="How you confirmed it is the farmer asking" /></label>
              <button>Reset PIN</button>
            </form>
          )}
          {v.messaging.msgs.length ? (
            <table>
              <thead><tr><th>Sent</th><th>Message</th><th>Status</th></tr></thead>
              <tbody>{v.messaging.msgs.map((m, k) => <tr key={k}><td>{fmtDate(m.created_at)}</td><td className="small">{m.body}</td><td>{m.status === 'sent' ? 'Sent' : <span className="badge warn">{`${m.status}: ${m.error ?? ''}`}</span>}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted">No messages yet.</p>}
        </section>
      )}

      {kitovu(c) && v.issues.length > 0 && (
        <section className="card">
          <h2>Data issues</h2>
          <IssueTable c={c} rows={v.issues} />
        </section>
      )}
    </Page>
  );
}

// ---------- identity review (maker-checker) ----------
export function KycReviewPage({ c, rows }: { c: Ctx; rows: Submission[] }) {
  return (
    <Page c={c} title="ID checks">
      <h1>Identity checks to review</h1>
      <p className="muted">Compare the ID photo, the face photo and the record. An AI pre-check reads the photos first and flags problems; you make the decision. You cannot review a check you submitted. ID photos are deleted automatically after the retention period; the decision stays.</p>
      {!rows.length && <section className="card"><p>Nothing waiting. Well done.</p></section>}
      {rows.map((k) => (
        <section className="card review" key={k.id}>
          <div className="pics">
            <figure><a href={`/files/${k.id_doc_file_id}`} target="_blank" rel="noopener"><img src={`/files/${k.id_doc_file_id}`} alt={`ID document of ${k.full_name}`} /></a><figcaption>{ID_TYPES[k.id_type]?.label} ending {k.id_last4}</figcaption></figure>
            <figure><a href={`/files/${k.selfie_file_id}`} target="_blank" rel="noopener"><img src={`/files/${k.selfie_file_id}`} alt={`Photo of ${k.full_name}`} /></a><figcaption>Face photo · click either photo to enlarge</figcaption></figure>
          </div>
          <div>
            <h2><a href={`/farmers/${k.farmer_code}`}>{k.full_name}</a> <small className="mono">{k.farmer_code}</small></h2>
            <dl className="facts">
              <dt>Place</dt><dd>{[k.community, k.state_name].filter(Boolean).join(', ') || '—'}</dd>
              <dt>Born</dt><dd>{k.year_of_birth ?? '—'}</dd>
              <dt>Phone</dt><dd>{k.phone_e164 ? mask(k.phone_e164) : 'none'}{' · '}{k.phone_check_method === 'sms' ? 'confirmed by text' : k.phone_check_method === 'voice' ? 'confirmed by voice call' : k.phone_check_method === 'attested' ? `not checked; witnessed by ${k.phone_attestation?.witness_name} (${k.phone_attestation?.witness_role}, ${k.phone_attestation?.witness_phone})` : 'not checked'}
                {k.records_on_phone > 2 && <> <span className="badge warn">{`on ${k.records_on_phone} farmer records`}</span></>}</dd>
              <dt>Submitted</dt><dd>{fmtDate(k.submitted_at)} by {k.submitted_by_name}</dd>
              {k.provider_result && <><dt>Lookup</dt><dd>{String(k.provider_result.match)}</dd></>}
            </dl>
            <AiPanel k={k} />
            <form method="post" action={`/kyc/${k.id}/ai-recheck`}><Csrf c={c} /><button className="link small">{k.ai ? 'Run the AI pre-check again' : 'Run the AI pre-check'}</button></form>
            {k.submitted_by === c.user?.id ? <p className="flash info">You submitted this, so a colleague must review it.</p> : (
              <>
                <form method="post" action={`/kyc/${k.id}/approve`}>
                  <Csrf c={c} />
                  <label className="check"><input type="checkbox" name="checks" value="name_matches" /> The name on the ID matches the record</label>
                  <label className="check"><input type="checkbox" name="checks" value="face_matches" /> The face photo matches the ID photo</label>
                  <label className="check"><input type="checkbox" name="checks" value="id_original" /> It is a photo of the original ID (not a copy or a screen)</label>
                  <input name="note" placeholder="Note (optional)" aria-label="Note" />
                  <button className="primary">Approve</button>
                </form>
                <form method="post" action={`/kyc/${k.id}/reject`} className="row">
                  <Csrf c={c} />
                  <select name="reason" aria-label="Reason" required defaultValue={k.ai?.result?.suggested_reject_reason ?? ''}><option value="">Reject because…</option>{Object.entries(REJECT_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  <input name="note" placeholder="Note to the field partner" aria-label="Note" />
                  <button className="danger">Reject</button>
                </form>
              </>
            )}
          </div>
        </section>
      ))}
    </Page>
  );
}

function AiPanel({ k }: { k: Submission }) {
  const a = k.ai;
  if (!a) return null;
  if (a.status !== 'done') return <p className="muted small">{`AI pre-check ${a.status}${a.error ? `: ${a.error}` : ''}. Review as usual.`}</p>;
  const r = a.result, d = r.document;
  const label = { green: 'Nothing found', amber: 'Look closely', red: 'Likely problem' }[a.flag as 'green'];
  return (
    <div className={`ai ${a.flag}`}>
      <p><b>{`AI pre-check: ${label}`}</b> <small className="muted">{`${a.model} · advisory only; you decide`}</small></p>
      {r.reasons?.length > 0 && <ul>{r.reasons.map((x: string) => <li key={x}>{x}</li>)}</ul>}
      <dl className="facts small">
        <dt>Document seen</dt><dd>{d.type_seen.replace(/_/g, ' ')}{d.legible ? '' : ' (not legible)'}</dd>
        <dt>Name on ID</dt><dd>{d.name_on_document ?? '—'} ({d.name_match})</dd>
        <dt>Last 4 seen</dt><dd>{d.last4_seen ?? '—'}</dd>
        {d.expiry_date && <><dt>Expires</dt><dd>{d.expiry_date}</dd></>}
        <dt>ID photo</dt><dd>{`original: ${d.original_capture}`}{d.original_note ? ` · ${d.original_note}` : ''}</dd>
        <dt>Face photo</dt><dd>{`${r.face_photo.one_clear_face ? 'one clear face' : 'no single clear face'} · live: ${r.face_photo.live_capture}`}{r.face_photo.quality_note ? ` · ${r.face_photo.quality_note}` : ''}</dd>
      </dl>
      {r.concerns?.length > 0 && <p className="small">{r.concerns.join(' · ')}</p>}
      <p className="muted small">The AI does not compare the faces. That check is yours.</p>
    </div>
  );
}

// ---------- legacy / data-quality review ----------
export function IssueTable({ c, rows, showRecord }: { c: Ctx; rows: Issue[]; showRecord?: boolean }) {
  return (
    <table>
      <thead><tr>{showRecord && <th>Record</th>}<th>Issue</th><th>Detail</th><th></th></tr></thead>
      <tbody>{rows.map((i) => (
        <tr key={i.id}>
          {showRecord && <td>{i.link ? <a href={i.link}>{i.label}</a> : i.label ?? i.legacy_ref}<br /><small className="muted">{i.entity.replace('_', ' ')}</small></td>}
          <td><span className={`badge ${i.severity === 'info' ? '' : 'warn'}`}>{i.severity}</span> {i.code.replace(/_/g, ' ')}</td>
          <td>{i.detail}{EXPLAIN[i.code] && !i.resolved_at && <><br /><small className="muted">{EXPLAIN[i.code]}</small></>}{i.resolved_at && <><br /><small className="muted">{`Resolved ${fmtDay(i.resolved_at)}: ${i.resolved_by}`}</small></>}</td>
          <td>{!i.resolved_at && i.severity !== 'info' && (
            <form method="post" action={`/review/${i.id}/resolve`} className="row"><Csrf c={c} /><input name="note" placeholder="How it was resolved" aria-label="Resolution" required /><button>Resolve</button></form>
          )}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function ReviewQueuePage({ c, rows, q, run, summary }: { c: Ctx; rows: Issue[]; q: Record<string, string>; run?: any; summary?: { entity: string; code: string; severity: string; n: number }[] }) {
  const open = rows.filter((r) => !r.resolved_at && r.severity !== 'info').length;
  return (
    <Page c={c} title="Review queue">
      <h1>Review queue</h1>
      <p className="muted">Records from the old StorageX system that need a person to confirm something, plus what the data steward finds in its daily check. {open} open.</p>
      <form method="post" action="/review/steward-run" className="row card">
        <Csrf c={c} />
        <span>{run ? `Data steward last checked ${fmtDate(run.finished_at)}: ${run.opened} new, ${run.closed} fixed since the run before, ${run.still_open} open.` : 'The data steward has not run yet.'}
          <br /><small className="muted">It closes its own items once the problem is fixed. Resolve one by hand only if it is not a problem (for example, two farmers who really share a name); it will not be raised again.</small></span>
        <button>Check now</button>
      </form>
      {summary && summary.length > 0 && (
        <section className="card">
          <h2>Records to complete</h2>
          <p className="muted">Each item closes itself once the record is filled in to today’s standard. Download the list to share the work out.</p>
          <table>
            <thead><tr><th>Record</th><th>What is missing</th><th>Open</th><th></th></tr></thead>
            <tbody>{summary.map((s) => (
              <tr key={s.entity + s.code}>
                <td>{s.entity.replace('_', ' ')}</td>
                <td>{s.code.replace(/_/g, ' ')}<br /><small className="muted">{EXPLAIN[s.code] ?? ''}</small></td>
                <td>{s.n}</td>
                <td><a href={`/review?entity=${s.entity}&code=${s.code}`}>Show</a> · <a href={`/review.csv?entity=${s.entity}&code=${s.code}`}>Download</a></td>
              </tr>
            ))}</tbody>
          </table>
          <p><a href="/review.csv">Download everything open (CSV)</a></p>
        </section>
      )}
      <form className="filters card" method="get">
        <select name="entity" defaultValue={q.entity ?? ''} aria-label="Record type">
          <option value="">All records</option><option value="farmer">Farmers</option><option value="field_partner">Field partners</option><option value="warehouse">Warehouses</option><option value="insurance_policy">Insurance</option><option value="receipt">Receipts</option><option value="user">User accounts</option>
        </select>
        {q.code && <input type="hidden" name="code" value={q.code} />}
        <label className="check"><input type="checkbox" name="info" value="1" defaultChecked={q.info === '1'} /> Include notes</label>
        <label className="check"><input type="checkbox" name="resolved" value="1" defaultChecked={q.resolved === '1'} /> Include resolved</label>
        <button>Show</button>
      </form>
      <section className="card"><IssueTable c={c} rows={rows} showRecord /></section>
    </Page>
  );
}

// ---------- field partners ----------
export function FieldPartnersPage({ c, rows, states, networks }: { c: Ctx; rows: FieldPartner[]; states: Opt[]; networks: { id: string; name: string }[] }) {
  const k = kitovu(c);
  return (
    <Page c={c} title="Field partners">
      <h1>Field partners</h1>
      <section className="card">
        <h2>Add a field partner</h2>
        {!k && <p className="muted">Kitovu verifies each new field partner before they can register farmers.</p>}
        <form method="post" action="/field-partners" className="grid">
          <Csrf c={c} />
          <Field label="Full name" name="full_name" required />
          <Field label="Phone" name="phone" type="tel" required />
          <Field label="Email (optional)" name="email" type="email" />
          <Select label="State" name="state_code" blank="Choose…" options={states.map((s) => [s.code, s.name])} />
          <Field label="Community / LGA" name="community" />
          {k && <Select label="Network" name="org_id" blank="Kitovu (direct)" options={networks.map((n) => [n.id, n.name])} />}
          <button className="primary">Add</button>
        </form>
      </section>
      <section className="card">
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Phone</th><th>Network</th><th>Area</th><th>Farmers</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id} id={p.code}>
              <td className="mono">{p.code}</td><td>{p.full_name}</td><td className="mono">{p.phone_e164 ?? <span className="badge warn">missing</span>}</td>
              <td>{p.org_name ?? '—'}</td><td>{[p.community, p.state_code].filter(Boolean).join(', ') || '—'}</td><td>{p.farmers}</td>
              <td><span className={`badge ${p.status === 'active' ? 'ok' : p.status === 'legacy_unverified' || p.status === 'invited' ? 'warn' : ''}`}>{p.status.replace('_', ' ')}</span></td>
              <td>{k && (p.status === 'active'
                ? <form method="post" action={`/field-partners/${p.id}/suspend`}><Csrf c={c} /><button className="link danger">Suspend</button></form>
                : <form method="post" action={`/field-partners/${p.id}/verify`}><Csrf c={c} /><button className="link">Verify</button></form>)}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}

// ---------- warehouses ----------
type WhForm = { states: Opt[]; operators: { id: string; name: string; kind: string }[]; crops: Opt[] };
export function WarehousesPage({ c, rows, form, error, values }: { c: Ctx; rows: Warehouse[]; form?: WhForm; error?: string; values?: any }) {
  const v = values ?? {};
  return (
    <Page c={c} title="Warehouses">
      <h1>Warehouses</h1>
      <p className="muted">Tier A: Kitovu-operated · B: partner-operated, Kitovu-managed · C: two-key village store · D: listed only (never backs loans).</p>
      {error && <p className="flash error">{error}</p>}
      {form && (
        <details className="card" open={!!error || !rows.length}>
          <summary><b>Add a warehouse</b></summary>
          <form method="post" action="/warehouses">
            <Csrf c={c} />
            <div className="grid">
              <Field label="Warehouse name" name="name" value={v.name} required hint="As the community knows it, e.g. Iseyin Grain Store" />
              <Select label="Run by" name="operator_org_id" value={v.operator_org_id} blank="Choose…" options={form.operators.map((o) => [o.id, `${o.name}${o.kind === 'kitovu' ? '' : ` (${o.kind.replace(/_/g, ' ')})`}`])} hint="New operator? Add it under Organisations first." />
              <Select label="Tier" name="tier" value={v.tier ?? 'B'} options={[['A', 'A · Kitovu-operated'], ['B', 'B · partner-operated'], ['C', 'C · village store'], ['D', 'D · listed only']]} />
              <Select label="State" name="state_code" value={v.state_code} blank="Choose…" options={form.states.map((s) => [s.code, s.name])} />
              <Field label="Local government area" name="lga" value={v.lga} />
              <Field label="Town" name="town" value={v.town} required />
              <Field label="Site code (optional)" name="site_code" value={v.site_code} hint="3–6 letters for the warehouse code; blank = from the town" />
              <Field label="Address" name="address_text" value={v.address_text} hint="Street or landmark" />
              <Field label="Latitude" name="lat" value={v.lat} inputMode="decimal" hint="From the phone’s map at the gate, e.g. 7.9667" />
              <Field label="Longitude" name="lng" value={v.lng} inputMode="decimal" hint="e.g. 3.6000" />
              <Field label="Capacity (tonnes)" name="capacity_tonnes" value={v.capacity_tonnes} inputMode="decimal" />
              <Field label="Site contact" name="contact_name" value={v.contact_name} />
              <Field label="Contact phone" name="contact_phone" value={v.contact_phone} type="tel" />
            </div>
            <fieldset className="crops">
              <legend>Crops it stores</legend>
              {form.crops.map((k) => <label key={k.code} className="check"><input type="checkbox" name="commodities" value={k.code} defaultChecked={(v.commodities ?? []).includes(k.code)} /> {k.name}</label>)}
            </fieldset>
            <p className="muted small">The warehouse code is made from the state, site and a number, e.g. WH-OY-ISY-01. It starts as onboarding; certify it on its page once GPS, capacity and insurance are in. Crops missing from the list are added under <a href="/commodities">Commodities</a>.</p>
            <button className="primary">Add warehouse</button>
          </form>
        </details>
      )}
      <section className="card">
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Operator</th><th>Tier</th><th>Status</th><th>Capacity</th><th>Can back loans</th></tr></thead>
          <tbody>{rows.map((w) => (
            <tr key={w.id}>
              <td><a href={`/warehouses/${w.code}`} className="mono">{w.code}</a></td>
              <td>{w.name}{w.needs_review && <> <span className="badge warn">review</span></>}<br /><small className="muted">{[w.town, w.lga_name, w.state_name].filter(Boolean).join(', ')}</small></td>
              <td>{w.operator_name}</td><td>{w.tier}</td><td>{w.status}</td>
              <td>{w.capacity_kg ? `${(Number(w.capacity_kg) / 1000).toLocaleString('en-NG')} t` : '—'}</td>
              <td>{w.can_back_loans ? 'Yes' : 'No'}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}

export function WarehousePage({ c, w, policies, issues, titanSites }: { c: Ctx; w: Warehouse; policies: any[]; issues: Issue[]; titanSites?: { id: string; name: string; externalRef: string | null }[] | null }) {
  const edit = kitovu(c) && can(c.membership, 'warehouses.edit');
  return (
    <Page c={c} title={w.name}>
      <div className="head"><h1>{w.name} <small className="mono">{w.code}</small></h1><span className={`badge ${w.can_back_loans ? 'ok' : ''}`}>{w.can_back_loans ? 'Can back loans' : 'Cannot back loans yet'}</span></div>
      <section className="card">
        <h2>Profile</h2>
        {edit ? (
          <form method="post" action={`/warehouses/${w.code}`} className="grid">
            <Csrf c={c} />
            <Field label="Name" name="name" value={w.name} required />
            <Select label="Tier" name="tier" value={w.tier} options={[['A', 'A · Kitovu-operated'], ['B', 'B · partner-operated'], ['C', 'C · village store'], ['D', 'D · listed only']]} />
            <Select label="Status" name="status" value={w.status} options={['onboarding', 'certified', 'active', 'dormant', 'closed'].map((s) => [s, s])} hint="Certified/active needs GPS and capacity." />
            <Field label="Local government area" name="lga" value={w.lga_name} />
            <Field label="Town" name="town" value={w.town} />
            <Field label="Address" name="address_text" value={w.address_text} />
            <Field label="Latitude" name="lat" value={w.lat} inputMode="decimal" hint="e.g. 9.6139" />
            <Field label="Longitude" name="lng" value={w.lng} inputMode="decimal" hint="e.g. 6.5569" />
            <Field label="Capacity (tonnes)" name="capacity_tonnes" value={w.capacity_kg ? Number(w.capacity_kg) / 1000 : ''} inputMode="decimal" />
            <Field label="Commodities (codes)" name="commodities" value={w.commodities.join(', ')} hint="e.g. MAZ, SGM, SBN" />
            <Field label="Site contact" name="contact_name" value={w.contact_name} />
            <Field label="Contact phone" name="contact_phone" value={w.contact_phone} type="tel" />
            <button className="primary">Save</button>
          </form>
        ) : (
          <dl className="facts">
            <dt>Operator</dt><dd>{w.operator_name}</dd><dt>Tier · status</dt><dd>{w.tier} · {w.status}</dd>
            <dt>Location</dt><dd>{[w.address_text, w.town, w.lga_name, w.state_name].filter(Boolean).join(', ')}{w.lat && ` (${w.lat}, ${w.lng})`}</dd>
            <dt>Capacity</dt><dd>{w.capacity_kg ? `${Number(w.capacity_kg) / 1000} t` : '—'}</dd><dt>Commodities</dt><dd>{w.commodities.join(', ') || '—'}</dd>
          </dl>
        )}
      </section>
      <section className="card">
        <h2>Insurance</h2>
        <table>
          <thead><tr><th>Insurer</th><th>Policy</th><th>Cover</th><th>Sum insured</th><th>Status</th><th></th></tr></thead>
          <tbody>{policies.map((p) => (
            <tr key={p.id}>
              <td>{p.insurer_name}</td><td className="mono">{p.policy_number ?? '—'}</td><td>{fmtDay(p.cover_from)} – {fmtDay(p.cover_to)}</td>
              <td>{p.sum_insured_kobo != null ? `₦${(Number(p.sum_insured_kobo) / 100).toLocaleString('en-NG')}` : '—'}</td>
              <td><span className={`badge ${p.status === 'active' ? 'ok' : 'warn'}`}>{p.status}</span></td>
              <td>{edit && p.status === 'unverified' && <form method="post" action={`/warehouses/${w.code}/insurance/${p.id}/verify`}><Csrf c={c} /><button className="link">Verify with insurer</button></form>}</td>
            </tr>
          ))}</tbody>
        </table>
        {edit && (
          <form method="post" action={`/warehouses/${w.code}/insurance`} className="grid">
            <Csrf c={c} />
            <Field label="Insurer" name="insurer_name" required /><Field label="Policy number" name="policy_number" />
            <Field label="Cover from" name="cover_from" type="date" required /><Field label="Cover to" name="cover_to" type="date" required />
            <Field label="Sum insured (₦)" name="sum_insured_naira" inputMode="decimal" /><Field label="Perils" name="perils" hint="comma-separated: fire, flood, theft" />
            <button>Add policy</button>
          </form>
        )}
        <p className="muted small">A second Kitovu person verifies each policy against the insurer’s schedule before it counts.</p>
      </section>
      {edit && (
        <section className="card">
          <h2>WareGuard on Titan</h2>
          <p className="muted">{w.titan_site_id ? `Linked to Titan site ${w.titan_site_id}. Readings and alerts from its devices show on Stock watch.` : `Not linked. In Titan, set the site’s external reference to ${w.code} and it links itself within 10 minutes, or choose the site here.`}</p>
          {titanSites === null && <p className="flash error">Titan could not be reached just now. Try again in a few minutes.</p>}
          {titanSites && (
            <form method="post" action={`/warehouses/${w.code}/titan`} className="row">
              <Csrf c={c} />
              <select name="site_id" defaultValue={w.titan_site_id ?? ''} aria-label="Titan site">
                <option value="">Not linked</option>
                {titanSites.map((s) => <option key={s.id} value={s.id}>{`${s.name}${s.externalRef ? ` (${s.externalRef})` : ''}`}</option>)}
              </select>
              <button>Save link</button>
            </form>
          )}
        </section>
      )}
      {kitovu(c) && issues.length > 0 && <section className="card"><h2>Data issues</h2><IssueTable c={c} rows={issues} /></section>}
    </Page>
  );
}

export function CommoditiesPage({ c, rows }: { c: Ctx; rows: Commodity[] }) {
  const cats = CATEGORIES.map((k) => [k, k.replace('_', ' ')] as [string, string]);
  const months = [1, 2, 3, 4, 5, 6].map((m) => [String(m), `${m} month${m === 1 ? '' : 's'}`] as [string, string]);
  return (
    <Page c={c} title="Commodities">
      <h1>Commodities</h1>
      <p className="muted">The crops StorageX handles. Each has a moisture limit checked at the gate and a longest storage term (1 to 6 months) for its receipts. A crop that is switched off stays on its old records but cannot be chosen for new farmers, deliveries or prices.</p>
      <details className="card">
        <summary><b>Add a commodity</b></summary>
        <form method="post" action="/commodities" className="grid">
          <Csrf c={c} />
          <Field label="Code" name="code" required hint="Three letters, e.g. GNT" />
          <Field label="Name" name="name" required hint="e.g. Groundnut (shelled)" />
          <Select label="Category" name="category" blank="Choose…" options={cats} />
          <Select label="Unit" name="unit" value="kg" options={[['kg', 'Kilograms'], ['l', 'Litres']]} />
          <Field label="Maximum moisture at intake (%)" name="max_moisture_pct" inputMode="decimal" hint="Blank = not checked" />
          <Select label="Longest storage term" name="max_storage_months" value="6" options={months} />
          <label className="check"><input type="checkbox" name="storable" value="1" defaultChecked /> Can back receipts</label>
          <button className="primary">Add commodity</button>
        </form>
      </details>
      <section className="card">
        <table>
          <thead><tr><th>Code</th><th>Commodity</th><th>Moisture limit</th><th>Longest term</th><th>In use</th><th></th></tr></thead>
          <tbody>{rows.map((k) => (
            <tr key={k.code} className={k.active ? '' : 'muted'}>
              <td className="mono">{k.code}</td>
              <td>{k.name}<br /><small className="muted">{`${k.category.replace('_', ' ')} · ${k.unit}${k.storable ? '' : ' · cannot back receipts'}${k.active ? '' : ' · switched off'}`}</small></td>
              <td>{k.max_moisture_pct ? `${Number(k.max_moisture_pct)}%` : '—'}</td>
              <td>{`${k.max_storage_months} mo`}</td>
              <td><small>{`${k.farmers} farmers · ${k.receipts} receipts`}</small></td>
              <td>
                <details>
                  <summary>Edit</summary>
                  <form method="post" action={`/commodities/${k.code}`} className="grid">
                    <Csrf c={c} />
                    <Field label="Name" name="name" value={k.name} required />
                    <Select label="Category" name="category" value={k.category} options={cats} />
                    <Select label="Unit" name="unit" value={k.unit} options={[['kg', 'Kilograms'], ['l', 'Litres']]} />
                    <Field label="Maximum moisture (%)" name="max_moisture_pct" value={k.max_moisture_pct ? Number(k.max_moisture_pct) : ''} inputMode="decimal" />
                    <Select label="Longest storage term" name="max_storage_months" value={String(k.max_storage_months)} options={months} />
                    <label className="check"><input type="checkbox" name="storable" value="1" defaultChecked={k.storable} /> Can back receipts</label>
                    <label className="check"><input type="checkbox" name="active" value="1" defaultChecked={k.active} /> In use (offered in forms)</label>
                    <button>Save</button>
                  </form>
                </details>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}
