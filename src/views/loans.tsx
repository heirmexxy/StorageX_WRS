import type { Ctx } from '../lib/http';
import { can } from '../lib/rbac';
import { fmtNGN } from '../lib/money';
import { Page, Csrf, Field, Select, fmtDate, fmtDay } from './layout';

const pct = (bp: number | null) => (bp == null ? '—' : `${(bp / 100).toFixed(1)}%`);
const N = (k: number) => fmtNGN(Math.round(k));
const kit = (c: Ctx) => c.membership?.org_kind === 'kitovu';
const TONE: Record<string, string> = { approved: 'warn', disbursed: 'ok', repaid: '', cancelled: '', submitted: 'warn', draft: '', decided: 'ok', pending: 'warn', rejected: '' };

export function LoansPage({ c, loans, batches, products, alerts, allProducts }: { c: Ctx; loans: any[]; batches: any[]; products: any[]; alerts: any[]; allProducts: any[] }) {
  const lenderAdmin = can(c.membership, 'finance.configure') && ['lender', 'kitovu'].includes(c.membership!.org_kind);
  return (
    <Page c={c} title="Loans">
      <div className="head"><h1>Loans</h1>{c.membership?.org_kind !== 'kitovu' && <a className="button" href="/loans/ncr.csv">Collateral registry file (CSV)</a>}</div>
      {alerts.length > 0 && (
        <section className="card">
          <h2>Needs attention</h2>
          <ul className="flaglist">{alerts.map((x) => <li key={x.loan_no} className={x.level === 'margin_call' || x.level === 'overdue' ? 'review' : 'hold'}><a href={`/loans/${x.loan_no}`}>{x.loan_no}</a>{` ${x.farmer}: `}
            {x.level === 'no_price' ? 'no usable price for the stock' : `owes ${N(x.outstanding)}, ${pct(x.ltv_bp)} of the stock’s value${x.level === 'liquidation' ? ' — at or past the liquidation level' : x.level === 'margin_call' ? ' — past the warning level' : ''}`}{x.overdue_days ? ` · ${x.overdue_days} days overdue` : ''}</li>)}</ul>
        </section>
      )}
      <section className="card">
        <h2>Loan requests</h2>
        {kit(c) && can(c.membership, 'receipts.issue') && (
          <form method="post" action="/loans/batches" className="row">
            <Csrf c={c} />
            <select name="product" required defaultValue="" aria-label="Product"><option value="">New request for…</option>{allProducts.map((p) => <option key={p.id} value={p.id}>{`${p.lender} · ${p.name}`}</option>)}</select>
            <button className="primary">Start a batch</button>
          </form>
        )}
        <table>
          <thead><tr><th>Batch</th><th>Lender · product</th><th>Farmers</th><th>Requested</th><th>Status</th></tr></thead>
          <tbody>{batches.map((b) => (
            <tr key={b.id}><td><a className="mono" href={`/loans/batches/${b.ref}`}>{b.ref}</a></td><td>{`${b.lender} · ${b.product}`}</td><td>{b.lines}</td><td>{N(b.requested)}</td>
              <td><span className={`badge ${TONE[b.status] ?? ''}`}>{b.status === 'submitted' && b.pending ? `${b.pending} to decide` : b.status}</span></td></tr>
          ))}</tbody>
        </table>
        {!batches.length && <p className="muted">No requests yet.</p>}
      </section>
      <section className="card">
        <h2>Loans</h2>
        <table>
          <thead><tr><th>Loan</th><th>Farmer</th>{kit(c) && <th>Lender</th>}<th>Principal</th><th>Owed now</th><th>Loan ÷ stock value</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{loans.map((l) => (
            <tr key={l.id}><td><a className="mono" href={`/loans/${l.loan_no}`}>{l.loan_no}</a></td><td>{l.farmer_name}<br /><small className="muted">{l.farmer_code}</small></td>{kit(c) && <td>{l.lender}</td>}
              <td>{N(l.principal)}</td><td>{l.pos ? N(l.pos.outstanding) : '—'}</td>
              <td className={l.ltv_bp != null && l.ltv_bp >= l.margin_call_ltv_bp ? 'bad' : ''}>{pct(l.ltv_bp ?? null)}</td>
              <td>{l.due_on ? fmtDay(l.due_on) : '—'}{l.pos?.overdueDays ? <><br /><small className="bad">{`${l.pos.overdueDays} days overdue`}</small></> : null}</td>
              <td><span className={`badge ${TONE[l.status] ?? ''}`}>{l.status}</span></td></tr>
          ))}</tbody>
        </table>
        {!loans.length && <p className="muted">No loans yet.</p>}
      </section>
      {lenderAdmin && (
        <section className="card">
          <h2>{kit(c) ? 'Kitovu’s own loan products' : 'Your loan products'}</h2>
          {products.length > 0 && (
            <table>
              <thead><tr><th>Product</th><th>Interest</th><th>Fee</th><th>Tenor</th><th>Amount</th><th>Crops</th><th>Warning / liquidation</th></tr></thead>
              <tbody>{products.map((p) => <tr key={p.id}><td>{p.name}{!p.active && ' (inactive)'}</td><td>{`${p.interest_bp_month / 100}% a month`}</td><td>{`${p.fee_bp / 100}%`}</td><td>{`${p.tenor_days} days`}</td>
                <td>{`${N(Number(p.min_kobo))} – ${N(Number(p.max_kobo))}`}</td><td>{p.commodity_codes.length ? p.commodity_codes.join(', ') : 'any'}</td><td>{`${pct(p.margin_call_ltv_bp)} / ${pct(p.liquidation_ltv_bp)}`}</td></tr>)}</tbody>
            </table>
          )}
          <form method="post" action="/loans/products" className="grid">
            <Csrf c={c} />
            <Field label="Name" name="name" required hint="e.g. Harvest loan 120 days" />
            <Field label="Interest (% a month)" name="interest_pct_month" inputMode="decimal" required value="2.5" />
            <Field label="Processing fee (%)" name="fee_pct" inputMode="decimal" value="1" />
            <Field label="Tenor (days)" name="tenor_days" inputMode="numeric" required value="120" />
            <Field label="Minimum (₦)" name="min_naira" inputMode="decimal" value="50000" />
            <Field label="Maximum (₦)" name="max_naira" inputMode="decimal" required value="5000000" />
            <Field label="Crops (codes, empty = any)" name="commodities" hint="e.g. MAZ, SBN" />
            <Select label="Farmer identity needed" name="min_kyc_level" value="2" options={[['2', 'Level 2: account opened with you'], ['1', 'Level 1: checked by Kitovu']]} />
            <Field label="Warn when loan ÷ stock value reaches (%)" name="margin_call_pct" inputMode="decimal" value="80" />
            <Field label="Liquidation level (%)" name="liquidation_pct" inputMode="decimal" value="90" />
            <button>Add product</button>
          </form>
        </section>
      )}
    </Page>
  );
}

export function BatchPage({ c, b }: { c: Ctx; b: any }) {
  const preparer = kit(c) && can(c.membership, 'receipts.issue');
  const officer = c.membership?.org_id === b.lender_org_id && can(c.membership, 'finance.approve') && c.user?.id !== b.created_by && c.user?.id !== b.submitted_by;
  return (
    <Page c={c} title={b.ref}>
      <div className="head"><h1 className="mono">{b.ref}</h1><span className={`badge ${TONE[b.status] ?? ''}`}>{b.status}</span></div>
      <p className="muted">{`${b.lender} · ${b.product}: ${b.interest_bp_month / 100}% a month, ${b.fee_bp / 100}% fee, ${b.tenor_days} days, ${N(Number(b.min_kobo))}–${N(Number(b.max_kobo))}. Identity needed before disbursement: level ${b.min_kyc_level}.`}</p>
      {b.lines.map((l: any) => (
        <section className="card" key={l.id}>
          <div className="head"><h2>{`${l.farmer_name} `}<small className="mono">{l.farmer_code}</small></h2><span className={`badge ${TONE[l.status] ?? ''}`}>{l.loan_no ? `${l.status} · ${l.loan_no}` : l.status}</span></div>
          <dl className="facts">
            <dt>Receipts</dt><dd className="mono">{l.receipt_nos}</dd>
            <dt>Asks</dt><dd><b>{N(l.requested)}</b>{l.market ? ` against stock worth ${N(l.market)} (limit ${N(l.max_loan)})` : ''}</dd>
            {l.approved && <><dt>Approved</dt><dd>{`${N(l.approved)} by ${l.decider}, ${fmtDate(l.decided_at)}`}</dd></>}
            {l.decision_note && <><dt>Note</dt><dd>{l.decision_note}</dd></>}
          </dl>
          {l.review && (
            <div className={`ai ${l.review.summary === 'ok' ? 'green' : l.review.summary === 'warn' ? 'amber' : 'red'}`}>
              <p><b>Batch reviewer</b> <small className="muted">automatic checks{l.review.note ? ' and AI note' : ''} · advisory, the credit officer decides</small></p>
              <ul className="flaglist">{l.review.checks.map((k: any) => <li key={k.code} className={k.result === 'fail' ? 'hold' : k.result === 'warn' ? 'review' : 'info'}><b>{k.result === 'ok' ? '✓' : k.result === 'warn' ? '!' : '✗'}</b>{` ${k.detail}`}</li>)}</ul>
              {l.review.note && <p className="small">{l.review.note}</p>}
            </div>
          )}
          {b.status === 'draft' && preparer && <form method="post" action={`/loans/lines/${l.id}/remove`}><Csrf c={c} /><button className="link danger">Remove</button></form>}
          {b.status === 'submitted' && l.status === 'pending' && officer && (
            <form method="post" action={`/loans/lines/${l.id}/decide`} className="row">
              <Csrf c={c} />
              <input name="amount" placeholder={`Amount (₦), default ${(l.requested / 100).toLocaleString('en-NG')}`} aria-label="Amount" inputMode="decimal" />
              <input name="note" placeholder="Note (required to reject)" aria-label="Note" />
              <button name="decision" value="approve" className="primary">Approve</button><button name="decision" value="reject" className="danger">Reject</button>
            </form>
          )}
        </section>
      ))}
      {b.status === 'draft' && preparer && (
        <section className="card">
          <h2>Add a farmer</h2>
          <form method="post" action={`/loans/batches/${b.ref}/lines`} className="grid">
            <Csrf c={c} />
            <Field label="Farmer code" name="farmer" required hint="SXF-…" />
            <Field label="Receipts" name="receipts" required hint="Receipt numbers, separated by commas" />
            <Field label="Amount (₦)" name="amount" inputMode="decimal" hint="Empty = the most the receipts support" />
            <button>Add</button>
          </form>
          <form method="post" action={`/loans/batches/${b.ref}/submit`}><Csrf c={c} /><button className="primary" disabled={!b.lines.length}>{`Submit to ${b.lender}`}</button></form>
          <p className="muted small">Submitting runs the batch reviewer on every line. The lender decides each line; approval pledges the receipts.</p>
        </section>
      )}
    </Page>
  );
}

export function LoanPage({ c, ln }: { c: Ctx; ln: any }) {
  const lenderFin = c.membership?.org_id === ln.lender_org_id && can(c.membership, 'finance.approve');
  const p = ln.pos;
  return (
    <Page c={c} title={ln.loan_no}>
      <div className="head"><h1 className="mono">{ln.loan_no}</h1><span className={`badge ${TONE[ln.status] ?? ''}`}>{ln.status}</span></div>
      <div className="cols">
        <section className="card">
          <dl className="facts">
            <dt>Farmer</dt><dd>{`${ln.farmer_name} ${ln.farmer_code} · identity level ${ln.kyc_level}`}</dd>
            <dt>Lender</dt><dd>{`${ln.lender} · ${ln.product}`}</dd>
            <dt>Principal</dt><dd><b>{N(ln.principal)}</b>{` at ${ln.interest_bp_month / 100}% a month, ${ln.fee_bp / 100}% fee, ${ln.tenor_days} days`}</dd>
            <dt>Approved</dt><dd>{`${ln.approver}, ${fmtDate(ln.approved_at)}`}</dd>
            {ln.disbursed_on && <><dt>Disbursed</dt><dd>{`${fmtDay(ln.disbursed_on)} by ${ln.disburser} · ref ${ln.disbursement_ref}`}</dd><dt>Due</dt><dd>{fmtDay(ln.due_on)}</dd></>}
          </dl>
        </section>
        <section className="card">
          {p ? (
            <dl className="facts">
              <dt>Owed now</dt><dd><b>{N(p.outstanding)}</b></dd>
              <dt>Made of</dt><dd>{`principal ${N(p.principalOut)} · interest ${N(p.interestOut)} · fees ${N(p.feeOut)}`}</dd>
              <dt>Paid so far</dt><dd>{`${N(p.repaid)}${p.waived ? ` (+${N(p.waived)} waived)` : ''}`}</dd>
              <dt>Interest to date</dt><dd>{`${N(p.interest)} over ${p.daysIn} days`}</dd>
              <dt>Stock value</dt><dd>{ln.mv.total ? `${N(ln.mv.total)} · loan is ${pct(ln.ltv_bp)} of it (warn at ${pct(ln.margin_call_ltv_bp)}, liquidate at ${pct(ln.liquidation_ltv_bp)})` : 'no usable price'}</dd>
              {p.overdueDays > 0 && <><dt>Overdue</dt><dd className="bad">{`${p.overdueDays} days`}</dd></>}
            </dl>
          ) : <p className="muted">Nothing paid out yet.</p>}
        </section>
      </div>
      <section className="card">
        <h2>Pledged receipts</h2>
        <table><thead><tr><th>Receipt</th><th>Stock</th><th>Warehouse</th><th>Pledged</th><th>Status</th></tr></thead>
          <tbody>{ln.liens.map((l: any) => <tr key={l.id}><td><a className="mono" href={`/receipts/${l.receipt_no}`}>{l.receipt_no}</a></td><td>{`${l.kg.toLocaleString('en-NG')} kg ${l.commodity}`}</td><td>{l.wh_name}</td>
            <td>{fmtDay(l.created_at)}</td><td>{l.released_at ? `released ${fmtDay(l.released_at)}` : l.receipt_status}</td></tr>)}</tbody></table>
      </section>
      {ln.entries.length > 0 && (
        <section className="card">
          <h2>Money</h2>
          <table><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Reference</th><th>By</th></tr></thead>
            <tbody>{ln.entries.map((e: any) => <tr key={e.id}><td>{fmtDay(e.on_date)}</td><td>{e.kind}</td><td>{N(Number(e.amount_kobo))}</td><td>{e.reference ?? e.note ?? ''}</td><td>{e.by_name}</td></tr>)}</tbody></table>
        </section>
      )}
      {lenderFin && ln.status === 'approved' && (
        <section className="card">
          <h2>Record the disbursement</h2>
          {ln.approved_by === c.user?.id ? <p className="flash info">You approved this loan, so a colleague records the disbursement.</p> : (
            <form method="post" action={`/loans/${ln.loan_no}/disburse`} className="grid">
              <Csrf c={c} /><Field label="Transfer reference" name="reference" required /><Field label="Date sent" name="on" type="date" required /><button className="primary">Record disbursement</button>
            </form>
          )}
          <form method="post" action={`/loans/${ln.loan_no}/cancel`} className="row"><Csrf c={c} /><input name="reason" placeholder="Why cancel" aria-label="Reason" required /><button className="danger">Cancel the loan and release the receipts</button></form>
        </section>
      )}
      {ln.status === 'disbursed' && (lenderFin || (kit(c) && can(c.membership, 'finance.approve'))) && (
        <section className="card">
          <h2>Record a payment</h2>
          <form method="post" action={`/loans/${ln.loan_no}/repay`} className="grid">
            <Csrf c={c} />
            <Field label="Amount (₦)" name="amount" inputMode="decimal" required />
            <Field label="Date received" name="on" type="date" required />
            <Field label="Payment reference" name="reference" />
            {lenderFin && <Select label="Kind" name="kind" value="repayment" options={[['repayment', 'Repayment'], ['waiver', 'Waiver (interest or fee forgiven)']]} />}
            <Field label="Note" name="note" />
            <button className="primary">Record</button>
          </form>
          <p className="muted small">Payments go to fees first, then interest, then principal. When nothing is owed the loan closes and the receipts are released.</p>
        </section>
      )}
    </Page>
  );
}
