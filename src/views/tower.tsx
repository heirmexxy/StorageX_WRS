import type { Ctx } from '../lib/http';
import { fmtNGN } from '../lib/money';
import { Page, fmtDay } from './layout';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const pct = (bp: number | null) => (bp == null ? '—' : `${(bp / 100).toFixed(1)}%`);
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;

function Shares({ title, rows }: { title: string; rows: { k: string; kobo: number; share: number }[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length ? rows.slice(0, 6).map((r) => (
        <div className="share" key={r.k}>
          <span>{r.k}</span><span className="bar"><i style={{ width: `${Math.max(2, r.share * 100)}%` }} /></span><span className="num">{`${(r.share * 100).toFixed(0)}% · ${N(r.kobo)}`}</span>
        </div>
      )) : <p className="muted small">No loans yet.</p>}
    </div>
  );
}

export function TowerPage({ c, s, b, sites, w, check, kitovu }: { c: Ctx; s: any; b: any[]; sites: any[]; w: any; check: any; kitovu: boolean }) {
  const attention = [
    ...s.liquidation.map((l: any) => ({ l, sev: 'hold', text: `owes ${N(l.outstanding)}, ${pct(l.ltv_bp)} of the stock’s value: at or past your liquidation level (${pct(l.liquidation_ltv_bp)}). Ask Kitovu to arrange a sale or ask the farmer to repay.` })),
    ...s.margin.map((l: any) => ({ l, sev: 'review', text: `${pct(l.ltv_bp)} of the stock’s value, past your warning level (${pct(l.margin_call_ltv_bp)}).` })),
    ...s.overdue.map((l: any) => ({ l, sev: 'hold', text: `${l.overdue_days} days overdue, owes ${N(l.outstanding)}.` })),
    ...s.unpriced.map((l: any) => ({ l, sev: 'review', text: 'no current market price for the stock, so its value is unknown.' })),
    ...s.due14.map((l: any) => ({ l, sev: 'info', text: `due ${fmtDay(l.due_on)} (${l.days_to_due} days), owes ${N(l.outstanding)}.` })),
  ];
  const waiting = w.batches.length + w.disburse.length + w.sales.length + w.accounts.length;
  return (
    <Page c={c} title="Control tower">
      <div className="head"><h1>{kitovu ? 'Control tower · all lenders' : `Control tower · ${c.membership?.org_name}`}</h1><span className="muted">{`as of ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })}`}</span></div>

      <section className="card tower-top">
        <div><span className="muted">Owed to {kitovu ? 'lenders' : 'you'} today</span><b>{N(s.outstanding)}</b><small>{`${s.loans} loan${s.loans === 1 ? '' : 's'} · ${N(s.principal)} lent`}</small></div>
        <div><span className="muted">Stock behind it</span><b>{N(s.market)}</b><small>at today’s reference prices</small></div>
        <div><span className="muted">Loan ÷ stock value</span><b>{pct(s.ltv_bp)}</b><small>across the book</small></div>
        <div><span className="muted">Needs attention</span><b>{s.liquidation.length + s.margin.length + s.overdue.length + s.unpriced.length}</b><small>{`${s.due14.length} due within 14 days`}</small></div>
      </section>

      {!kitovu && check.done < check.items.length && (
        <section className="card">
          <h2>{`Ready for your dry run: ${check.done} of ${check.items.length}`}</h2>
          <ul className="checklist">{check.items.map((i: any) => <li key={i.text} className={i.done ? 'done' : ''}>{i.done ? i.text : <a href={i.link}>{i.text}</a>}</li>)}</ul>
        </section>
      )}

      <section className="card">
        <h2>{waiting ? `Waiting for ${kitovu ? 'lenders' : 'your team'}` : 'Nothing waiting for your team'}</h2>
        {w.batches.map((x: any) => <p key={x.ref}><a className="mono" href={`/loans/batches/${x.ref}`}>{x.ref}</a>{` ${kitovu ? `${x.lender}: ` : ''}${x.lines} loan request${x.lines > 1 ? 's' : ''} to decide, ${N(x.requested)} asked`}</p>)}
        {w.disburse.map((x: any) => <p key={x.loan_no}><a className="mono" href={`/loans/${x.loan_no}`}>{x.loan_no}</a>{` ${x.farmer_name}: approved, ${N(x.principal)} to pay out${x.kyc_level < x.min_kyc_level ? ' after you confirm the farmer’s account' : ''}${x.mine ? ' (a colleague must record it: you approved it)' : ''}`}</p>)}
        {w.sales.map((x: any) => <p key={x.ref}><a className="mono" href={`/sales/${x.ref}`}>{x.ref}</a>{` sale to ${x.buyer_name} at ${fmtNGN(x.perkg)}/kg needs your approval`}</p>)}
        {w.accounts.map((x: any) => <p key={x.code}><a href={`/farmers/${x.code}`}>{x.full_name}</a>{` ${x.code}: confirm the account you opened, so the loan can be paid out`}</p>)}
      </section>

      <section className="card">
        <h2>Needs attention</h2>
        {attention.length ? <ul className="flaglist">{attention.map((x, k) => <li key={k} className={x.sev}><a className="mono" href={`/loans/${x.l.loan_no}`}>{x.l.loan_no}</a>{` ${x.l.farmer_name}${kitovu ? ` (${x.l.lender})` : ''}: ${x.text}`}</li>)}</ul>
          : b.length ? <p className="ok">Every loan is within its limits and on time.</p> : <p className="muted">Nothing yet. Loans appear here once you pay them out.</p>}
      </section>

      <section className="card">
        <h2>Where the stock is</h2>
        {sites.length ? (
          <table>
            <thead><tr><th>Warehouse</th><th>Your stock</th><th>Insurance</th><th>Last count</th><th>Checks</th></tr></thead>
            <tbody>{sites.map((x: any) => (
              <tr key={x.id}><td>{x.name}<br /><small className="muted">{`${x.state} · tier ${x.tier} · ${x.status}`}</small></td><td>{kg(x.kg)}</td>
                <td>{x.insured ? 'Current' : <span className="badge warn">none on record</span>}</td>
                <td>{x.last_count ? fmtDay(x.last_count) : <span className="badge warn">never</span>}</td>
                <td>{x.holds.length || x.under_review ? <ul className="flaglist">{x.under_review ? <li className="hold">{`${x.under_review} of your receipts under review`}</li> : null}{x.holds.map((h: string) => <li key={h} className="hold">{h}</li>)}</ul>
                  : x.reviews.length ? <ul className="flaglist">{x.reviews.map((h: string) => <li key={h} className="review">{h}</li>)}</ul> : <span className="ok">Counts and receipts agree</span>}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="muted">No stock is pledged to you yet.</p>}
      </section>

      {b.length > 0 && <section className="card shares3">
        <Shares title="By warehouse" rows={s.byWarehouse} />
        <Shares title="By crop" rows={s.byCrop} />
        <Shares title="By farmer’s state" rows={s.byState} />
      </section>}

      <section className="card">
        <div className="head"><h2>Loan book</h2><span><a className="button" href="/tower/loan-book.csv">Download (CSV)</a>{!kitovu && <> <a className="button" href="/loans/ncr.csv">Collateral registry file</a></>}</span></div>
        <table>
          <thead><tr><th>Loan</th><th>Farmer</th>{kitovu && <th>Lender</th>}<th>Owed today</th><th>Stock value</th><th>Loan ÷ value</th><th>Due</th></tr></thead>
          <tbody>{b.map((l) => (
            <tr key={l.id}><td><a className="mono" href={`/loans/${l.loan_no}`}>{l.loan_no}</a></td><td>{l.farmer_name}<br /><small className="muted">{l.receipts.map((r: any) => r.receipt_no).join(', ')}</small></td>{kitovu && <td>{l.lender}</td>}
              <td>{N(l.outstanding)}</td><td>{l.market == null ? '—' : N(l.market)}</td><td className={l.ltv_bp != null && l.ltv_bp >= l.margin_call_ltv_bp ? 'bad' : ''}>{pct(l.ltv_bp)}</td>
              <td>{fmtDay(l.due_on)}{l.overdue_days ? <><br /><small className="bad">{`${l.overdue_days} days overdue`}</small></> : null}</td></tr>
          ))}</tbody>
        </table>
        {!b.length && <p className="muted">No loans paid out yet.</p>}
      </section>
    </Page>
  );
}
