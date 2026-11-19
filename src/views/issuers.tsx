import type { Ctx } from '../lib/http';
import { fmtNGN } from '../lib/money';
import { Page, Csrf, fmtDay, fmtDate } from './layout';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;
const STATUS: Record<string, [string, string]> = { applied: ['', 'Applying'], certified: ['ok', 'Certified'], suspended: ['bad', 'Suspended'] };
const BASIS: Record<string, string> = { own: 'Owns it', lease: 'Leases it', kitovu_bays: 'Bays in a Kitovu warehouse' };

export function Scorecard({ s }: { s: any }) {
  return (
    <div className="kpis">
      <div><small>Receipts issued</small><b>{s.receipts.toLocaleString('en-NG')}</b><small>{`${s.live_receipts} live · ${kg(s.kg)}`}</small></div>
      <div><small>Live value</small><b>{N(s.live_value)}</b><small>{`${N(s.value_at_storage)} at storage`}</small></div>
      <div><small>Guarantee</small><b>{N(s.guarantee)}</b><small>{s.guarantee_cover != null ? `${(s.guarantee_cover * 100).toFixed(1)}% of live value · ${N(s.guarantee_needed)} needed` : `${N(s.guarantee_needed)} needed`}</small></div>
      <div><small>WareGuard</small><b>{s.devices ? `${s.reporting} of ${s.devices}` : 'None'}</b><small>{s.waiver_until ? `waived to ${fmtDay(s.waiver_until)}` : `devices reporting at ${s.warehouses} warehouse${s.warehouses === 1 ? '' : 's'}`}</small></div>
      <div><small>Stock checks</small><b>{s.open_checks ? `${s.open_checks} open` : 'Clear'}</b><small>{s.shortfall_kg ? `${kg(s.shortfall_kg)} written off as losses` : 'no losses written off'}</small></div>
      <div><small>Loans on its receipts</small><b>{String(s.loans.total)}</b><small>{`${s.loans.repaid} repaid · ${s.loans.overdue} overdue · ${s.loans.written_off} written off`}</small></div>
    </div>
  );
}

export function IssuersPage({ c, rows }: { c: Ctx; rows: any[] }) {
  const kit = c.membership?.org_kind === 'kitovu';
  return (
    <Page c={c} title="Receipt issuers">
      <div className="head"><h1>Receipt issuers</h1>{kit && <a className="button" href="/issuers/charges">Platform fees</a>}</div>
      <p className="muted">{kit ? 'Companies that issue StorageX receipts at their own, leased or shared warehouses. New issuers come in through partner applications; certify them here once they are ready.'
        : 'Companies other than Kitovu that issue StorageX receipts. Each must keep WareGuard reporting, current insurance and a guarantee for lenders. You choose whose receipts you lend against, and you can cap the loan-to-value for each.'}</p>
      {rows.length ? (
        <table>
          <thead><tr><th>Issuer</th><th>Status</th><th>Receipts</th><th>Live value</th><th>Guarantee</th><th>WareGuard</th><th>Loans</th>{!kit && <th>Your terms</th>}</tr></thead>
          <tbody>{rows.map((r) => { const [tone, label] = STATUS[r.status] ?? ['', r.status]; return (
            <tr key={r.id}><td><a href={`/issuers/${r.code}`}>{r.name}</a><br /><small className="muted">{`${r.code} · tier ${r.tier}`}</small></td>
              <td><span className={`badge ${tone}`}>{label}</span></td>
              <td>{`${r.card.receipts} (${r.card.live_receipts} live)`}</td><td>{N(r.card.live_value)}</td>
              <td>{N(r.card.guarantee)}</td><td>{r.card.devices ? `${r.card.reporting}/${r.card.devices} reporting` : r.card.waiver_until ? 'waived' : 'none'}</td>
              <td>{`${r.card.loans.repaid} repaid, ${r.card.loans.overdue} overdue`}</td>
              {!kit && <td>{r.accepted ? `Accepted${r.max_ltv_bp ? `, max ${r.max_ltv_bp / 100}%` : ''}` : r.accepted === false ? 'Declined' : 'Not decided'}</td>}</tr>
          ); })}</tbody>
        </table>
      ) : <p className="muted">{kit ? 'No issuer has applied yet. They apply at /apply as “Receipt issuer”.' : 'No certified issuers yet.'}</p>}
    </Page>
  );
}

export function IssuerPage({ c, iss, card, links, blockers, terms, whs }: { c: Ctx; iss: any; card: any; links: any[]; blockers: string[]; terms?: any; whs?: any[] }) {
  const kit = c.membership?.org_kind === 'kitovu';
  const lender = c.membership?.org_kind === 'lender';
  const self = c.membership?.org_id === iss.id;
  const [tone, label] = STATUS[iss.status ?? 'applied'] ?? ['', iss.status];
  return (
    <Page c={c} title={iss.name}>
      <div className="head"><h1>{iss.name}</h1><span><span className={`badge ${tone}`}>{label}</span>{` tier ${iss.tier ?? 'C'}`}</span></div>
      {iss.status === 'suspended' && <p className="flash error">{`Suspended ${iss.suspended_at ? fmtDay(iss.suspended_at) : ''}: ${iss.suspend_reason}. Receipts already issued stay valid; no new ones can be issued.`}</p>}
      <section className="card"><h2>Scorecard</h2><Scorecard s={card} /></section>

      {(kit || self) && (
        <section className="card">
          <h2>{iss.status === 'certified' ? 'Ready to issue?' : iss.status === 'suspended' ? 'Issuing is suspended' : 'Before certification'}</h2>
          {blockers.length ? <ul className="flaglist">{blockers.map((b) => <li key={b} className="review">{b}</li>)}</ul> : <p className="ok">Everything is in place: receipts can be issued at every linked warehouse.</p>}
          {self && <p className="small muted">These rules are checked again for every receipt at the moment of issue. If one fails, issuing stops until it is fixed. Ask Kitovu if you need help.</p>}
        </section>
      )}

      <section className="card">
        <h2>Warehouses</h2>
        {links.length ? (
          <table><thead><tr><th>Warehouse</th><th>Use</th><th>Insurance</th><th>WareGuard</th><th>Status</th>{kit && <th></th>}</tr></thead>
            <tbody>{links.map((l) => (
              <tr key={l.id}><td>{`${l.wh_name} (${l.wh_code})`}<br /><small className="muted">{l.state}</small></td>
                <td>{BASIS[l.basis]}{l.detail ? <><br /><small className="muted">{l.detail}</small></> : null}</td>
                <td>{l.insured ? <span className="ok">Current</span> : <span className="bad">None</span>}</td>
                <td>{l.devices ? `${l.reporting} of ${l.devices} reporting` : <span className="bad">Not installed</span>}</td>
                <td>{l.status === 'active' ? `From ${fmtDay(l.starts_on)}${l.ends_on ? ` to ${fmtDay(l.ends_on)}` : ''}` : 'Ended'}</td>
                {kit && <td>{l.status === 'active' && <form method="post" action={`/issuers/${iss.code}/unlink`}><Csrf c={c} /><input type="hidden" name="warehouse" value={l.wh_code} /><button className="link">End</button></form>}</td>}</tr>
            ))}</tbody></table>
        ) : <p className="muted">No warehouse linked yet.</p>}
        {kit && whs && (
          <form method="post" action={`/issuers/${iss.code}/link`} className="inline-form">
            <Csrf c={c} />
            <label className="field"><span>Warehouse</span><select name="warehouse" required><option value="">Choose…</option>{whs.map((w) => <option key={w.code} value={w.code}>{`${w.name} (${w.code})`}</option>)}</select></label>
            <label className="field"><span>How the issuer uses it</span><select name="basis" required><option value="own">Owns it</option><option value="lease">Leases it</option><option value="kitovu_bays">Bays in a Kitovu warehouse</option></select></label>
            <label className="field"><span>Detail (lease reference, or which bays)</span><input name="detail" /></label>
            <label className="field"><span>Ends on (for a lease or bay agreement)</span><input name="ends_on" type="date" /></label>
            <button>Link warehouse</button>
          </form>
        )}
      </section>

      {kit && (
        <section className="card">
          <h2>Kitovu controls</h2>
          <div className="grid2">
            <form method="post" action={`/issuers/${iss.code}/guarantee`}><Csrf c={c} />
              <h3>Guarantee for lenders</h3>
              <p className="small muted">{`Held: ${N(card.guarantee)}${iss.guarantee_ref ? ` (${iss.guarantee_ref})` : ''}. Needed now: ${N(card.guarantee_needed)}.`}</p>
              <label className="field"><span>Amount (₦)</span><input name="amount" inputMode="decimal" required /></label>
              <label className="field"><span>Reference: deposit transfer, bond or bank guarantee</span><input name="reference" required /></label>
              <button>Record guarantee</button></form>
            <form method="post" action={`/issuers/${iss.code}/waiver`}><Csrf c={c} />
              <h3>WareGuard waiver (pilot only)</h3>
              <p className="small muted">{iss.wareguard_waiver_until ? `Waived to ${fmtDay(iss.wareguard_waiver_until)}: ${iss.waiver_reason}` : 'No waiver. Issuing needs WareGuard reporting at the warehouse.'}</p>
              <label className="field"><span>Until (at most three months; blank ends it)</span><input name="until" type="date" /></label>
              <label className="field"><span>Reason</span><input name="reason" /></label>
              <button>Save waiver</button></form>
          </div>
          <div className="grid2">
            <form method="post" action={`/issuers/${iss.code}/tier`}><Csrf c={c} />
              <label className="field"><span>Tier (A best to D)</span><select name="tier" defaultValue={iss.tier ?? 'C'}>{['A', 'B', 'C', 'D'].map((t) => <option key={t}>{t}</option>)}</select></label>
              <button>Set tier</button></form>
            <div>
              {iss.status !== 'certified' && <form method="post" action={`/issuers/${iss.code}/certify`}><Csrf c={c} /><button className="primary" disabled={blockers.filter((b) => !b.startsWith('Suspended')).length > 0}>{iss.status === 'suspended' ? 'Reinstate issuing' : 'Certify to issue receipts'}</button></form>}
              {iss.status === 'certified' && <form method="post" action={`/issuers/${iss.code}/suspend`}><Csrf c={c} /><label className="field"><span>Reason for suspending (lenders will see it)</span><input name="reason" required /></label><button className="danger">Suspend issuing</button></form>}
              {iss.certified_at && <p className="small muted">{`Certified ${fmtDate(iss.certified_at)}.`}</p>}
            </div>
          </div>
        </section>
      )}

      {lender && (
        <section className="card">
          <h2>Your terms</h2>
          <p className="muted">Lend against this issuer’s receipts? Kitovu-issued receipts are always accepted. You can cap the loan-to-value for this issuer below your usual policy.</p>
          <form method="post" action={`/issuers/${iss.code}/terms`}><Csrf c={c} />
            <label className="check"><input type="hidden" name="accepted" value="0" /><input type="checkbox" name="accepted" value="1" defaultChecked={!!terms?.accepted} /> Accept receipts issued by {iss.name}</label>
            <label className="field"><span>Maximum loan-to-value for this issuer (%, blank = your usual policy)</span><input name="max_ltv" type="number" min="10" max="90" step="1" defaultValue={terms?.max_ltv_bp ? String(terms.max_ltv_bp / 100) : ''} /></label>
            <button>Save terms</button>
          </form>
        </section>
      )}
    </Page>
  );
}

export function ChargesPage({ c, rows }: { c: Ctx; rows: any[] }) {
  const kit = c.membership?.org_kind === 'kitovu';
  const due = rows.filter((r) => r.status === 'due').reduce((n, r) => n + r.amount, 0);
  return (
    <Page c={c} title="Platform fees">
      <h1>Platform fees</h1>
      <p className="muted">{`Fees partners owe Kitovu for issuing receipts, loans paid out and certification, at the rates in Settings. ${N(due)} is due.`}</p>
      {rows.length ? (
        <table><thead><tr><th>When</th><th>Partner</th><th>Fee</th><th>For</th><th>Amount</th><th>Status</th>{kit && <th></th>}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td>{fmtDay(r.created_at)}</td><td>{r.org_name}</td><td>{r.kind}</td><td className="mono">{r.ref}</td><td>{fmtNGN(r.amount)}</td>
              <td>{r.status}{r.note ? <><br /><small className="muted">{r.note}</small></> : null}</td>
              {kit && <td>{r.status === 'due' && <form method="post" action={`/issuers/charges/${r.id}`} className="inline"><Csrf c={c} /><input name="note" placeholder="Payment reference or reason" required /> <button name="status" value="paid">Paid</button> <button name="status" value="waived" className="link">Waive</button></form>}</td>}</tr>
          ))}</tbody></table>
      ) : <p className="muted">No platform fees yet. Set the rates in Settings; they apply from then on.</p>}
    </Page>
  );
}
