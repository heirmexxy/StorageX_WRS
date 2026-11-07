import type { Ctx } from '../lib/http';
import { can } from '../lib/rbac';
import { fmtNGN } from '../lib/money';
import { UNITS } from '../lib/valuation';
import { Page, Csrf, Field, Select, fmtDay } from './layout';

const perKg = (k: number | null) => (k == null ? '—' : `${fmtNGN(k)}/kg`);
const perBag = (k: number | null) => (k == null ? '' : `${fmtNGN(k * 100, { decimals: false })} per 100 kg`);
const pct = (bp: number) => `${(bp / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}%`;

export function PricesPage({ c, overview, recent, sources, states, crops }: { c: Ctx; overview: any[]; recent: any[]; sources: { id: string; name: string; kind: string }[]; states: { code: string; name: string }[]; crops: { code: string; name: string }[] }) {
  const kit = c.membership?.org_kind === 'kitovu';
  const canEnter = kit && (can(c.membership, 'finance.configure') || can(c.membership, 'stock.manage'));
  const approver = kit && can(c.membership, 'finance.configure');
  return (
    <Page c={c} title="Prices">
      <div className="head"><h1>Market prices</h1><a className="button" href="/valuation/policy">Valuation policy</a></div>
      <p className="muted">Reference price = the median of approved prices over the window set in Settings, for the warehouse’s state when there are enough, otherwise national.</p>
      <section className="card">
        <table>
          <thead><tr><th>Crop</th><th>National reference</th><th>Prices used</th><th>Change in 7 days</th><th>By state</th></tr></thead>
          <tbody>{overview.map((o) => (
            <tr key={o.code}>
              <td>{o.name}</td>
              <td><b>{perKg(o.national.kobo_per_kg)}</b><br /><small className="muted">{perBag(o.national.kobo_per_kg)}</small></td>
              <td>{o.national.scope === 'none' ? <span className="badge warn">{`${o.national.observations.length} — not enough`}</span> : `${o.national.observations.length} (${o.national.from} to ${o.national.to})`}</td>
              <td className={o.change_bp != null && o.change_bp < 0 ? 'bad' : ''}>{o.change_bp == null ? '—' : `${o.change_bp > 0 ? '+' : ''}${pct(o.change_bp)}`}</td>
              <td>{o.byState.map((s: any) => <div key={s.state}><small>{`${s.state}: ${perKg(s.kobo_per_kg)} (${s.n})`}</small></div>)}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {canEnter && (
        <section className="card">
          <h2>Enter a price</h2>
          <form method="post" action="/prices" encType="multipart/form-data" className="grid">
            <Csrf c={c} />
            <Select label="Crop" name="commodity" blank="Choose…" required options={crops.map((k) => [k.code, k.name])} />
            <Select label="State" name="state" blank="Choose…" required options={states.map((s) => [s.code, s.name])} />
            <Field label="Market or buyer" name="market" required hint="e.g. Kure Market, Minna" />
            <Select label="Source" name="source" blank="Choose…" required options={sources.map((s) => [s.id, s.name])} />
            <Field label="Price (₦)" name="price" inputMode="decimal" required />
            <Select label="Quoted" name="unit" value="bag_100kg" options={Object.entries(UNITS).map(([k, u]) => [k, u.label])} />
            <Field label="Date seen" name="observed_on" type="date" required />
            <Field label="Evidence (photo or document)" name="evidence" type="file" accept="image/*,application/pdf" />
            <Field label="Note" name="note" hint="Required if the price is far from the reference" />
            <button className="primary">Submit for approval</button>
          </form>
          <p className="muted small">A price counts only after someone in Kitovu finance other than you approves it.</p>
        </section>
      )}
      <section className="card">
        <h2>Recent prices</h2>
        <table>
          <thead><tr><th>Date</th><th>Crop</th><th>Where</th><th>Quoted</th><th>Per kg</th><th>Entered</th><th>Status</th></tr></thead>
          <tbody>{recent.map((o) => (
            <tr key={o.id}>
              <td>{fmtDay(o.observed_on)}</td><td>{o.commodity}</td><td>{`${o.market}${o.state_name ? `, ${o.state_name}` : ''}`}<br /><small className="muted">{o.source}</small></td>
              <td>{`${fmtNGN(o.quoted, { decimals: false })} ${UNITS[o.unit]?.label ?? o.unit}`}</td>
              <td>{perKg(o.kpk)}{o.outlier_pct != null && Math.abs(Number(o.outlier_pct)) >= 10 && <><br /><small className="warn">{`${Number(o.outlier_pct) > 0 ? '+' : ''}${o.outlier_pct}% vs reference`}</small></>}{o.note && <><br /><small className="muted">{o.note}</small></>}</td>
              <td>{o.enterer}{o.evidence_file_id && <> · <a href={`/files/${o.evidence_file_id}`} target="_blank" rel="noopener">evidence</a></>}</td>
              <td>{o.status === 'pending' && approver && o.entered_by !== c.user?.id ? (
                <form method="post" action={`/prices/${o.id}`} className="row"><Csrf c={c} /><input name="note" placeholder="Note" aria-label="Note" /><button name="decision" value="approve" className="primary">Approve</button><button name="decision" value="reject" className="danger">Reject</button></form>
              ) : <span className={`badge ${o.status === 'approved' ? 'ok' : o.status === 'pending' ? 'warn' : ''}`}>{o.status}</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {approver && (
        <div className="cols">
          <section className="card">
            <h2>Revalue receipts now</h2>
            <p className="muted">Runs every morning by itself. Run it now after approving new prices.</p>
            <form method="post" action="/prices/revalue"><Csrf c={c} /><button>Revalue all receipts</button></form>
          </section>
          <section className="card">
            <h2>Add a price source</h2>
            <form method="post" action="/prices/sources" className="grid">
              <Csrf c={c} />
              <Field label="Name" name="name" required />
              <Select label="Kind" name="kind" options={[['market_survey', 'Market survey'], ['buyer_offer', 'Buyer offer'], ['exchange', 'Commodity exchange'], ['government', 'Government'], ['other', 'Other']]} />
              <button>Add</button>
            </form>
          </section>
        </div>
      )}
    </Page>
  );
}

export function PolicyPage({ c, rows }: { c: Ctx; rows: any[] }) {
  const edit = can(c.membership, 'finance.configure') && ['kitovu', 'lender'].includes(c.membership!.org_kind);
  const whose = c.membership?.org_kind === 'kitovu' ? 'Kitovu’s default (used for the daily valuation and for lenders without their own)' : `${c.membership?.org_name}’s own`;
  return (
    <Page c={c} title="Valuation policy">
      <h1>Valuation policy</h1>
      <p className="muted">{`This is ${whose} policy. Haircut: the discount for price falls and quality risk. Loan-to-value: the share of the discounted value that may be lent.`}</p>
      <section className="card">
        <table>
          <thead><tr><th>Crop</th><th>Haircut</th><th>Loan-to-value</th><th>₦100 of stock supports a loan of</th>{edit && <th></th>}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.code}>
              <td>{r.name}{c.membership?.org_kind === 'lender' && !r.own && <><br /><small className="muted">using Kitovu default</small></>}</td>
              {edit ? (
                <td colSpan={4}>
                  <form method="post" action="/valuation/policy" className="row">
                    <Csrf c={c} /><input type="hidden" name="commodity" value={r.code} />
                    <input name="haircut" defaultValue={String(r.haircut_bp / 100)} aria-label="Haircut %" inputMode="decimal" />%
                    <input name="ltv" defaultValue={String(r.max_ltv_bp / 100)} aria-label="Loan-to-value %" inputMode="decimal" />%
                    <span className="muted">{`→ ₦${((100 * (10000 - r.haircut_bp) * r.max_ltv_bp) / 1e8).toFixed(2)}`}</span>
                    <button>Save</button>
                  </form>
                </td>
              ) : (<><td>{pct(r.haircut_bp)}</td><td>{pct(r.max_ltv_bp)}</td><td>{`₦${((100 * (10000 - r.haircut_bp) * r.max_ltv_bp) / 1e8).toFixed(2)}`}</td></>)}
            </tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}

export function ValuePanel({ v }: { v: any }) {
  if (!v) return null;
  const r = v.ref;
  return (
    <section className="card">
      <h2>Value</h2>
      {r.kobo_per_kg == null ? (
        <p className="flash info">{`No value yet: fewer approved prices than needed for this crop in the last ${r.window_days} days (${r.observations.length} found).`}</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Market value</dt><dd><b>{fmtNGN(v.market)}</b>{` = ${v.held.toLocaleString('en-NG')} kg × ${fmtNGN(r.kobo_per_kg)}/kg`}</dd>
            <dt>After haircut</dt><dd>{`${fmtNGN(v.lending)} (−${pct(v.policy.haircut_bp)})`}</dd>
            <dt>Maximum loan</dt><dd><b>{fmtNGN(v.maxLoan)}</b>{` (${pct(v.policy.max_ltv_bp)} loan-to-value${v.policy.own ? ', your policy' : ', Kitovu default policy'})`}</dd>
            <dt>Price basis</dt><dd>{`Median of ${r.observations.length} approved ${r.scope === 'state' ? 'prices in this state' : 'prices nationally (not enough in this state)'}, ${r.from} to ${r.to}`}</dd>
          </dl>
          <details><summary>Prices used</summary>
            <table><tbody>{r.observations.map((o: any) => <tr key={o.id}><td>{o.on}</td><td>{o.market}</td><td>{o.source}</td><td>{`${fmtNGN(o.kobo_per_kg)}/kg`}</td></tr>)}</tbody></table>
          </details>
        </>
      )}
      {v.history.length > 0 && (
        <details><summary>Daily values</summary>
          <table><tbody>{v.history.map((h: any) => <tr key={String(h.valued_on)}><td>{fmtDay(h.valued_on)}</td><td>{h.kobo_per_kg ? `${fmtNGN(Number(h.kobo_per_kg))}/kg` : 'no price'}</td><td>{h.market_value_kobo ? fmtNGN(Number(h.market_value_kobo)) : '—'}</td><td className={h.change_bp < 0 ? 'bad' : ''}>{h.change_bp == null ? '' : `${h.change_bp > 0 ? '+' : ''}${pct(h.change_bp)}`}</td></tr>)}</tbody></table>
        </details>
      )}
    </section>
  );
}
