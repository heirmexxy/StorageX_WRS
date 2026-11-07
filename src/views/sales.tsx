import type { Ctx } from '../lib/http';
import { can } from '../lib/rbac';
import { fmtNGN } from '../lib/money';
import { Page, Csrf, Field, Select, fmtDate, fmtDay } from './layout';

const N = (k: number) => fmtNGN(Math.round(Number(k)));
const kg = (n: number) => `${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg`;
const TONE: Record<string, string> = { proposed: 'warn', approved: 'warn', settled: 'ok', cancelled: '' };
const fin = (c: Ctx) => c.membership?.org_kind === 'kitovu' && can(c.membership, 'finance.approve');
const ops = (c: Ctx) => c.membership?.org_kind === 'kitovu' && can(c.membership, 'receipts.issue');

export function SalesPage({ c, rows, buyers }: { c: Ctx; rows: any[]; buyers: { id: string; name: string }[] }) {
  return (
    <Page c={c} title="Sales">
      <div className="head"><h1>Sales</h1><a className="button" href="/collections">Payments received</a></div>
      {ops(c) && (
        <section className="card">
          <h2>Arrange a sale</h2>
          <form method="post" action="/sales" className="grid">
            <Csrf c={c} />
            <Select label="Buyer on StorageX" name="buyer_org" blank="Not listed" options={buyers.map((b) => [b.id, b.name])} />
            <Field label="Or buyer’s name" name="buyer" />
            <Field label="Price (₦ per kg)" name="price" inputMode="decimal" required />
            <Field label="Receipts" name="receipts" required hint="Receipt numbers from one warehouse and crop, separated by commas" />
            <Field label="Note" name="note" />
            <button className="primary">Propose sale</button>
          </form>
          <p className="muted small">Each farmer must agree to the price, and a lender holding a pledge must approve, before the receipts are committed.</p>
        </section>
      )}
      <section className="card">
        <table>
          <thead><tr><th>Sale</th><th>Buyer</th><th>Crop · warehouse</th><th>Receipts</th><th>Value</th><th>Paid</th><th>Status</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}><td><a className="mono" href={`/sales/${s.ref}`}>{s.ref}</a></td><td>{s.buyer_name}</td><td>{`${s.commodity} · ${s.wh_name}`}<br /><small className="muted">{`${N(s.perkg)}/kg`}</small></td>
              <td>{s.items}</td><td>{N(s.gross)}</td><td>{N(s.paid)}</td><td><span className={`badge ${TONE[s.status]}`}>{s.status}</span></td></tr>
          ))}</tbody>
        </table>
        {!rows.length && <p className="muted">No sales yet.</p>}
      </section>
    </Page>
  );
}

export function SalePage({ c, s }: { c: Ctx; s: any }) {
  const isLender = c.membership?.org_kind === 'lender';
  return (
    <Page c={c} title={s.ref}>
      <div className="head"><h1 className="mono">{s.ref}</h1><span className={`badge ${TONE[s.status]}`}>{s.status}</span></div>
      <p>{`${s.buyer_name} buys ${s.commodity} at ${N(s.perkg)}/kg from ${s.wh_name}. Arranged by ${s.creator}, ${fmtDate(s.created_at)}.`}{s.note ? ` ${s.note}` : ''}</p>
      {!isLender && <p className="muted">{`Buyer pays ${N(s.money.gross)} quoting ${s.ref}. Received so far: ${N(s.money.paid)}${s.money.due ? `; still due ${N(s.money.due)}` : ''}.`}</p>}
      <section className="card">
        <h2>Receipts</h2>
        <table>
          <thead><tr><th>Receipt</th><th>Farmer</th><th>Stock</th><th>Value</th><th>Farmer agreed</th><th>Lender</th><th>Delivered</th></tr></thead>
          <tbody>{s.items.map((x: any) => (
            <tr key={x.id}>
              <td><a className="mono" href={`/receipts/${x.receipt_no}`}>{x.receipt_no}</a></td><td>{x.farmer_name}<br /><small className="muted">{x.farmer_code}</small></td>
              <td>{kg(x.kgf)}</td><td>{N(x.gross)}</td>
              <td>{x.farmer_agreed_at ? `${x.agreement_method === 'code' ? 'by code' : 'signed slip'}, ${fmtDay(x.farmer_agreed_at)}` : s.status === 'proposed' && ops(c) ? (
                <div>
                  {x.phone_verified_at && <form method="post" action={`/sales/items/${x.id}/code`} className="row"><Csrf c={c} /><button name="channel" value="sms">Text code</button><button name="channel" value="voice">Call</button></form>}
                  <form method="post" action={`/sales/items/${x.id}/agree`} encType="multipart/form-data" className="row">
                    <Csrf c={c} />
                    <select name="method" aria-label="How" defaultValue={x.phone_verified_at ? 'code' : 'paper_slip'}>{x.phone_verified_at && <option value="code">Code</option>}<option value="paper_slip">Signed slip</option></select>
                    <input name="otp" placeholder="Code" aria-label="Code" inputMode="numeric" />
                    <input type="file" name="slip" accept="image/*,application/pdf" capture="environment" aria-label="Slip photo" />
                    <button>Record</button>
                  </form>
                </div>
              ) : <span className="badge warn">waiting</span>}</td>
              <td>{x.lender_org_id ? (x.lender_approved_at ? `${x.lender}: approved` : isLender && can(c.membership, 'finance.approve') && s.status === 'proposed' ? <form method="post" action={`/sales/items/${x.id}/lender-approve`}><Csrf c={c} /><button className="primary">Approve sale</button></form> : `${x.lender}: waiting`) : '—'}</td>
              <td>{x.delivered ? kg(x.delivered) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
        {isLender && <p className="muted small">Approving lets the stock be sold at this price. At settlement, after Kitovu’s fees, the proceeds repay your loan before anything goes to the farmer.</p>}
      </section>

      {!isLender && s.status === 'approved' && (
        <div className="cols">
          <section className="card">
            <h2>Deliver to the buyer</h2>
            {s.releases.length > 0 && <ul>{s.releases.map((r: any) => <li key={r.ref}><a className="mono" href={`/releases/${r.ref}`}>{r.ref}</a>{` · ${r.receipt_no} · ${r.status === 'loaded' ? `loaded ${kg(r.loaded)}` : r.status}`}</li>)}</ul>}
            {ops(c) && <form method="post" action={`/sales/${s.ref}/deliver`} className="grid"><Csrf c={c} /><Field label="Buyer’s collector or driver" name="collector" required /><Field label="Their phone" name="phone" type="tel" /><button>Order delivery</button></form>}
            <p className="muted small">The warehouse loads it out with the usual two-person check, scale photo and signed slip.</p>
          </section>
          <section className="card">
            <h2>Payments from the buyer</h2>
            {s.collections.length ? <ul>{s.collections.map((k: any) => <li key={k.id}>{`${fmtDay(k.received_on)} · ${N(k.amount)} · ${k.reference}`}</li>)}</ul> : <p className="muted">None yet. Record them on <a href="/collections">Payments received</a>; a reference containing {s.ref} matches automatically.</p>}
          </section>
        </div>
      )}

      {s.preview && !isLender && (
        <section className="card">
          <h2>Who gets what</h2>
          <WaterfallTable items={s.preview} />
          {fin(c) && (s.created_by === c.user?.id ? <p className="flash info">You arranged this sale, so a colleague settles it.</p> : (
            <form method="post" action={`/sales/${s.ref}/settle`}><Csrf c={c} /><button className="primary">Settle the sale</button></form>
          ))}
          <p className="muted small">Settling needs the buyer’s payment in full and the stock delivered. It posts the loan repayments, releases the pledges and closes the receipts.</p>
        </section>
      )}

      {s.settlement && (
        <section className="card">
          <h2>{`Settled ${fmtDate(s.settlement.settled_at)}`}</h2>
          <table>
            <thead><tr><th>Receipt</th><th>To</th><th>For</th><th>Amount</th><th>Paid out</th></tr></thead>
            <tbody>{s.settlement.lines.filter((l: any) => !isLender || l.org_id === c.membership?.org_id).map((l: any) => (
              <tr key={l.id}><td className="mono">{l.receipt_no}</td><td>{l.party === 'kitovu' ? 'Kitovu' : l.party === 'lender' ? l.org_name : l.farmer_name}</td><td>{l.label}</td><td>{N(l.amount)}</td>
                <td>{l.party === 'kitovu' ? '—' : l.paid_at ? `${l.paid_ref} · ${fmtDay(l.paid_at)}` : fin(c) && l.amount > 0 ? <form method="post" action={`/settlements/lines/${l.id}/paid`} className="row"><Csrf c={c} /><input name="reference" placeholder="Transfer reference" aria-label="Reference" required /><button>Mark paid</button></form> : l.amount > 0 ? 'to pay' : '—'}</td></tr>
            ))}</tbody>
          </table>
          {!isLender && s.settlement.totals.shortfall > 0 && <p className="flash error">{`Proceeds did not cover the loans: ${N(s.settlement.totals.shortfall)} is still owed to the lender.`}</p>}
        </section>
      )}
      {ops(c) && ['proposed', 'approved'].includes(s.status) && (
        <section className="card"><form method="post" action={`/sales/${s.ref}/cancel`} className="row"><Csrf c={c} /><input name="reason" placeholder="Why cancel" aria-label="Reason" required /><button className="danger">Cancel sale</button></form></section>
      )}
    </Page>
  );
}

function WaterfallTable({ items }: { items: any[] }) {
  return (
    <table>
      <thead><tr><th>Receipt</th><th>Sale value</th><th>Kitovu fees</th><th>Loan</th><th>Farmer</th></tr></thead>
      <tbody>{items.map((it) => {
        const k = it.lines.filter((l: any) => l.party === 'kitovu').reduce((n: number, l: any) => n + l.amount, 0);
        const f = it.lines.find((l: any) => l.party === 'farmer').amount;
        return (
          <tr key={it.item_id}><td className="mono">{it.receipt_no}<br /><small className="muted">{it.farmer}</small></td><td>{N(it.gross)}</td>
            <td>{N(k)}<br /><small className="muted">{it.lines.filter((l: any) => l.party === 'kitovu').map((l: any) => `${l.label}: ${N(l.amount)}`).join('; ')}</small></td>
            <td>{it.toLender ? N(it.toLender) : '—'}{it.shortfall ? <><br /><small className="bad">{`short ${N(it.shortfall)}`}</small></> : null}</td><td><b>{N(f)}</b></td></tr>
        );
      })}</tbody>
    </table>
  );
}

export function CollectionsPage({ c, rows, open }: { c: Ctx; rows: any[]; open: { ref: string; buyer_name: string }[] }) {
  return (
    <Page c={c} title="Payments received">
      <h1>Payments received</h1>
      <section className="card">
        <h2>Record a payment into the collection account</h2>
        <form method="post" action="/collections" className="grid">
          <Csrf c={c} />
          <Field label="Amount (₦)" name="amount" inputMode="decimal" required />
          <Field label="Date received" name="on" type="date" required />
          <Field label="Bank reference or narration" name="reference" required hint="If it contains the sale reference (SL-…), it matches by itself" />
          <Field label="Paid by" name="payer" required />
          <button className="primary">Record</button>
        </form>
      </section>
      <section className="card">
        <h2>Not matched to a sale</h2>
        {rows.length ? (
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Reference</th><th>Payer</th><th>Recorded by</th><th></th></tr></thead>
            <tbody>{rows.map((k) => (
              <tr key={k.id}><td>{fmtDay(k.received_on)}</td><td>{N(k.amount)}</td><td>{k.reference}</td><td>{k.payer}</td><td>{k.recorder}</td>
                <td><form method="post" action={`/collections/${k.id}/match`} className="row"><Csrf c={c} />
                  <select name="sale" required defaultValue="" aria-label="Sale"><option value="">Match to…</option>{open.map((s) => <option key={s.ref} value={s.ref}>{`${s.ref} · ${s.buyer_name}`}</option>)}</select><button>Match</button></form></td></tr>
            ))}</tbody>
          </table>
        ) : <p className="muted">Everything received is matched.</p>}
        <p className="muted small">Matching by hand needs someone other than the person who recorded the payment.</p>
      </section>
    </Page>
  );
}

export function StatementPage({ c, f, st }: { c: Ctx; f: any; st: any }) {
  return (
    <Page c={c} title={`Statement · ${f.full_name}`}>
      <div className="head"><h1>{`Statement for ${f.full_name}`}</h1><span className="mono">{f.code}</span></div>
      <p className="muted">{`Prepared ${fmtDate(new Date())}. Print this page to give the farmer a copy.`}</p>
      <section className="card">
        <dl className="facts">
          <dt>Paid to the farmer</dt><dd><b>{N(st.paid)}</b></dd>
          <dt>Waiting to be paid</dt><dd><b>{N(st.owed)}</b></dd>
          <dt>Still in store</dt><dd>{kg(st.receipts.filter((r: any) => !['settled', 'closed', 'cancelled'].includes(r.status)).reduce((n: number, r: any) => n + r.held, 0))}</dd>
          <dt>Loans owed</dt><dd>{N(st.loans.filter((l: any) => l.status === 'disbursed').reduce((n: number, l: any) => n + l.pos.outstanding, 0))}</dd>
        </dl>
      </section>
      <section className="card"><h2>Deliveries</h2>
        <table><tbody>{st.deliveries.map((d: any) => <tr key={d.ref}><td>{fmtDay(d.at)}</td><td className="mono">{d.ref}</td><td>{`${kg(d.kg)} ${d.commodity}`}</td><td>{d.warehouse}</td><td>{d.status}</td></tr>)}</tbody></table></section>
      <section className="card"><h2>Receipts</h2>
        <table><tbody>{st.receipts.map((r: any) => <tr key={r.receipt_no}><td>{fmtDay(r.at)}</td><td className="mono">{r.receipt_no}</td><td>{`${kg(r.kg)} ${r.commodity}`}</td><td>{r.held < r.kg && r.held > 0 ? `${kg(r.held)} still held` : ''}</td><td>{r.status.replace(/_/g, ' ')}</td></tr>)}</tbody></table></section>
      {st.loans.length > 0 && <section className="card"><h2>Loans</h2>
        <table><tbody>{st.loans.map((l: any) => <tr key={l.id}><td className="mono">{l.loan_no}</td><td>{l.lender}</td><td>{`${N(l.principal)} borrowed`}</td><td>{`${N(l.pos.repaid)} repaid`}</td><td>{l.status === 'repaid' ? 'repaid' : `${N(l.pos.outstanding)} owed`}</td></tr>)}</tbody></table></section>}
      {st.sales.length > 0 && <section className="card"><h2>Sales</h2>
        {st.sales.map((s: any) => (
          <div key={s.ref + s.receipt_no} className="stmt-sale">
            <p><b>{`${s.ref} · ${s.receipt_no}`}</b>{` — ${kg(s.kg)} to ${s.buyer_name} at ${N(s.perkg)}/kg = ${N(s.gross)}, settled ${fmtDay(s.at)}`}</p>
            <table><tbody>{(s.lines ?? []).map((l: any, k: number) => <tr key={k}><td>{l.label}</td><td>{l.party === 'farmer' ? <b>{N(l.amount)}</b> : `− ${N(l.amount)}`}</td><td>{l.party === 'farmer' ? (l.paid_at ? `paid ${fmtDay(l.paid_at)}, ref ${l.paid_ref}` : 'waiting to be paid') : ''}</td></tr>)}</tbody></table>
          </div>
        ))}</section>}
    </Page>
  );
}
