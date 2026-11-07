import type { Ctx } from '../lib/http';
import type { Receipt } from '../lib/receipts';
import { EVENT_LABEL } from '../lib/receipts';
import { can } from '../lib/rbac';
import { qrSvg } from '../lib/qr';
import { Page, Csrf, fmtDate, fmtDay } from './layout';
import { ValuePanel } from './valuation';

const kg = (n: number | string) => `${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg`;
const TONE: Record<string, string> = { issued: 'ok', pledged: 'warn', financed: 'warn', sale_approved: 'warn', partially_released: 'warn', under_exception: 'warn' };

export function ReceiptsPage({ c, rows, q }: { c: Ctx; rows: Receipt[]; q: Record<string, string> }) {
  const live = rows.filter((r) => r.status === 'issued');
  return (
    <Page c={c} title="Receipts">
      <h1>Receipts</h1>
      <p className="muted">{`${live.length} valid receipt${live.length === 1 ? '' : 's'} holding ${kg(live.reduce((s, r) => s + Number(r.net_weight_kg), 0))} on this page.`}
        {c.membership?.org_kind === 'lender' && ' You see receipts of farmers who agreed to share their record with you.'}</p>
      <form className="filters card" method="get">
        <input name="q" defaultValue={q.q} placeholder="Receipt number, farmer name or code" aria-label="Search" />
        <select name="status" defaultValue={q.status ?? ''} aria-label="Status"><option value="">Any status</option>{['issued', 'pledged', 'cancelled', 'closed', 'settled'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <button>Search</button>
      </form>
      <section className="card">
        <table>
          <thead><tr><th>Receipt</th><th>Owner</th><th>Crop</th><th>Net</th><th>Warehouse</th><th>Issued</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><a className="mono" href={`/receipts/${r.receipt_no}`}>{r.receipt_no}</a>{r.lots && r.lots > 1 ? <small className="muted">{` · ${r.lot_no}/${r.lots}`}</small> : null}</td>
              <td>{r.farmer_name ?? '—'}<br /><small className="muted">{r.farmer_code}</small></td>
              <td>{r.commodity}{r.grade ? ` · ${r.grade}` : ''}</td><td>{kg(r.net_weight_kg)}</td><td>{r.wh_name}</td><td>{fmtDay(r.issued_at)}</td>
              <td><span className={`badge ${TONE[r.status] ?? ''}`}>{r.status}</span>{r.source !== 'app' && <> <span className="badge">old system</span></>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <p className="muted">No receipts yet. They are issued from accepted deliveries.</p>}
      </section>
    </Page>
  );
}

export function ReceiptPage({ c, r, events, chainOk, url, bal, rels, value }: { c: Ctx; r: Receipt; events: any[]; chainOk: boolean; url: string; bal?: { remaining_kg: number; released_kg: number }; rels?: any[]; value?: any }) {
  const kitovu = c.membership?.org_kind === 'kitovu';
  return (
    <Page c={c} title={r.receipt_no}>
      <div className="head"><h1 className="mono">{r.receipt_no}</h1><span className={`badge ${TONE[r.status] ?? ''}`}>{r.status}</span></div>
      <div className="cols">
        <section className="card">
          <dl className="facts">
            <dt>Owner</dt><dd>{r.farmer_name ? <a href={`/farmers/${r.farmer_code}`}>{r.farmer_name}</a> : '—'} {r.farmer_code}</dd>
            <dt>Crop</dt><dd>{r.commodity}{r.grade ? `, grade ${r.grade}` : ''}</dd>
            <dt>Net weight</dt><dd><b>{kg(r.net_weight_kg)}</b>{r.bags ? ` in ${r.bags} bags` : ''}</dd>
            {bal && bal.released_kg > 0 && <><dt>Still held</dt><dd><b>{kg(bal.remaining_kg)}</b>{` (${kg(bal.released_kg)} withdrawn)`}</dd></>}
            <dt>Moisture</dt><dd>{r.moisture_pct ? `${Number(r.moisture_pct)}%` : '—'}</dd>
            <dt>Warehouse</dt><dd>{`${r.wh_name} (${r.wh_code}), tier ${r.wh_tier}`}{r.can_back_loans ? '' : ' · cannot back loans now'}</dd>
            <dt>Issued</dt><dd>{`${fmtDate(r.issued_at)}${r.issued_by_name ? ` by ${r.issued_by_name}` : ''}`}</dd>
            <dt>Delivery</dt><dd>{r.intake_ref && can(c.membership, 'stock.manage') ? <a href={`/intakes/${r.intake_ref}`}>{r.intake_ref}</a> : r.intake_ref ?? 'old system'}{r.lots && r.lots > 1 ? ` · receipt ${r.lot_no} of ${r.lots}` : ''}</dd>
            {r.closed_at && <><dt>Closed</dt><dd>{`${fmtDate(r.closed_at)}${r.closed_reason && kitovu ? ` — ${r.closed_reason}` : ''}`}</dd></>}
          </dl>
          <p><a className="button" href={`/receipts/${r.receipt_no}/pdf`}>Download PDF</a> <a className="button" href={url} target="_blank" rel="noopener">Open public page</a></p>
        </section>
        <section className="card center">
          <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg(url, { size: 220 }) }} />
          <p className="small muted">Anyone can scan this to see the live status. The QR carries a signature over the receipt’s facts.</p>
        </section>
      </div>
      {value && <ValuePanel v={value} />}
      <section className="card">
        <h2>History</h2>
        <p className={chainOk ? 'ok' : 'bad'}>{chainOk ? `History intact: ${events.length} event${events.length === 1 ? '' : 's'}, each sealed to the one before.` : 'History check FAILED: an event does not match its seal. Report this to Kitovu at once.'}</p>
        <table>
          <thead><tr><th>#</th><th>Event</th><th>When</th><th>By</th><th>Seal</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.seq}><td>{e.seq}</td><td>{EVENT_LABEL[e.event_type] ?? e.event_type}{e.data?.lot && e.data.lot !== '1/1' ? ` (lot ${e.data.lot})` : ''}</td><td>{fmtDate(e.occurred_at)}</td>
              <td>{e.actor_name ?? e.actor.replace('system:', 'system: ')}</td><td className="mono small">{e.hash.slice(0, 12)}…</td></tr>
          ))}</tbody>
        </table>
      </section>
      {(rels?.length || (kitovu && can(c.membership, 'receipts.issue') && ['issued', 'partially_released'].includes(r.status))) ? (
        <section className="card">
          <h2>Release stock</h2>
          {rels && rels.length > 0 && (
            <table>
              <thead><tr><th>Ref</th><th>Ordered</th><th>Loaded</th><th>Collector</th><th>Status</th></tr></thead>
              <tbody>{rels.map((x: any) => <tr key={x.ref}><td>{can(c.membership, 'stock.manage') ? <a className="mono" href={`/releases/${x.ref}`}>{x.ref}</a> : x.ref}</td><td>{`${kg(x.ordered)} · ${fmtDay(x.ordered_at)}`}</td><td>{x.loaded ? `${kg(x.loaded)} · ${fmtDay(x.loaded_at)}` : '—'}</td><td>{x.collector_name}</td><td>{x.status}</td></tr>)}</tbody>
            </table>
          )}
          {kitovu && can(c.membership, 'receipts.issue') && ['issued', 'partially_released'].includes(r.status) && (
            <form method="post" action={`/receipts/${r.receipt_no}/release`} className="grid">
              <Csrf c={c} />
              <label className="field"><span>Kilograms (empty = all still held)</span><input name="kg" inputMode="decimal" /></label>
              <label className="field"><span>Why</span><select name="reason" required defaultValue=""><option value="">Choose…</option><option value="owner_withdrawal">Owner takes the stock</option><option value="sale_delivery">Delivery to a buyer</option><option value="other">Other</option></select></label>
              <label className="field"><span>Collector’s name (as on their ID)</span><input name="collector_name" required /></label>
              <label className="field"><span>Collector’s phone</span><input name="collector_phone" type="tel" /></label>
              <button>Order release</button>
            </form>
          )}
          <p className="muted small">Kitovu orders a release; someone else at the warehouse weighs it out and photographs the scale and the signed slip. The receipt is reduced or closed when loading is confirmed.</p>
        </section>
      ) : null}
      {kitovu && can(c.membership, 'receipts.issue') && r.status === 'issued' && (
        <section className="card">
          <h2>Cancel this receipt</h2>
          <p className="muted">Only for a receipt issued in error, before any loan or sale. Someone other than the issuer must cancel it. The public page will show “Cancelled”.</p>
          <form method="post" action={`/receipts/${r.receipt_no}/cancel`} className="row">
            <Csrf c={c} /><input name="reason" placeholder="Reason (internal)" aria-label="Reason" required /><button className="danger">Cancel receipt</button>
          </form>
        </section>
      )}
    </Page>
  );
}

export function PassportPage({ c, p, sample }: { c: Ctx; p: any; sample?: boolean }) {
  return (
    <Page c={c} title={`Receipt ${p.receipt_no}`} bare wide>
      <section className={`card passport tone-${p.view.tone}`}>
        {sample && <p className="flash info">This is a sample to show what a receipt page looks like. It is not a real receipt. Real receipts are reached by scanning the QR code on the printed copy or the link texted to the farmer.</p>}
        <p className="muted small">StorageX by Kitovu · Receipt Passport</p>
        <h1 className="mono">{p.receipt_no}</h1>
        <p className="status">{p.view.label}</p>
        <p>{p.view.note}</p>
        {p.qr_sig === 'mismatch' && <p className="flash error">The QR code you scanned does not match this receipt. The paper may have been altered. Do not rely on it; call Kitovu.</p>}
        {!p.chain_ok && <p className="flash error">This receipt’s history failed its integrity check. Do not rely on it; call Kitovu.</p>}
        <dl className="facts">
          <dt>Produce</dt><dd>{`${p.commodity}${p.grade ? `, grade ${p.grade}` : ''}`}</dd>
          <dt>Net weight</dt><dd><b>{kg(p.net_kg)}</b>{p.bags ? ` in ${p.bags} bags` : ''}</dd>
          {p.held_kg !== p.net_kg && <><dt>Still held</dt><dd><b>{kg(p.held_kg)}</b></dd></>}
          {p.moisture && <><dt>Moisture at intake</dt><dd>{`${Number(p.moisture)}%`}</dd></>}
          <dt>Warehouse</dt><dd>{`${p.warehouse} (tier ${p.tier})`}</dd>
          <dt>Insurance</dt><dd>{p.insured ? 'Current policy on record' : 'No current policy on record'}</dd>
          <dt>Owner</dt><dd>{p.owner}</dd>
          {p.lot && <><dt>Part</dt><dd>{`Receipt ${p.lot} from one delivery`}</dd></>}
          <dt>Issued</dt><dd>{fmtDate(p.issued_at)}</dd>
        </dl>
        <h2>History</h2>
        <ol className="hist">{p.events.map((e: any, k: number) => <li key={k}>{`${e.label} · ${fmtDate(e.at)}`}</li>)}</ol>
        <p className="small muted">
          {p.legacy ? 'Imported from the earlier StorageX system. ' : p.signature_ok ? 'Facts signed by StorageX' + (p.key_id ? ` (key ${p.key_id})` : '') + (p.qr_sig === 'match' ? '; the QR signature matches. ' : '. ') : 'Signature check failed. '}
          {p.chain_ok ? 'History intact. ' : ''}{`Checked ${fmtDate(p.checked_at)}.`}
        </p>
        <p className="small muted">This page shows the record held by StorageX right now. Lenders and buyers should check it on the day they rely on it. Questions: contact Kitovu Technology Company Limited.</p>
      </section>
    </Page>
  );
}
