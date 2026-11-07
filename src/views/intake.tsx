import type { Ctx } from '../lib/http';
import type { Flag } from '../lib/intake';
import { Page, Csrf, fmtDate } from './layout';

const kg = (n: number) => `${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg`;
const STATUS: Record<string, string> = { submitted: 'warn', held: 'warn', accepted: 'ok', rejected: '' };
const sevOrder = { hold: 0, review: 1, info: 2 } as Record<string, number>;
export const FlagList = ({ flags }: { flags: Flag[] }) => (
  <ul className="flaglist">{[...flags].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).map((f) => (
    <li key={f.code} className={f.severity}><b>{f.code.replace(/_/g, ' ')}</b>{` — ${f.detail}`}</li>
  ))}</ul>
);

export function IntakesPage({ c, rows, q }: { c: Ctx; rows: any[]; q: Record<string, string> }) {
  return (
    <Page c={c} title="Deliveries">
      <div className="head"><h1>Deliveries</h1><a className="button primary" href="/intake/">Open the gate app</a></div>
      <section className="card">
        <p><b>Gate app for clerks:</b> open <a href="/intake/">/intake</a> on the phone once with network and sign in, then use the browser menu’s <i>Add to Home screen</i>. It records deliveries with no network and uploads them later. Works in Chrome on Android 5 and newer; on older phones, keep the page open while offline.</p>
      </section>
      <nav className="tabs">{[['', 'All'], ['submitted', 'To review'], ['held', 'Held'], ['accepted', 'Accepted'], ['rejected', 'Rejected']].map(([v, l]) => (
        <a key={v} href={`?status=${v}`} className={(q.status ?? '') === v ? 'on' : ''}>{l}</a>
      ))}</nav>
      <section className="card">
        <table>
          <thead><tr><th>Ref</th><th>Farmer</th><th>Crop</th><th>Net</th><th>Moisture</th><th>Warehouse</th><th>Captured</th><th>Flags</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => {
            const holds = (r.flags as Flag[]).filter((f) => f.severity === 'hold').length, reviews = (r.flags as Flag[]).filter((f) => f.severity === 'review').length;
            return (
              <tr key={r.id}>
                <td><a className="mono" href={`/intakes/${r.ref}`}>{r.ref}</a></td>
                <td>{r.farmer_name}<br /><small className="muted">{r.farmer_code}{r.kyc_level < 1 ? ' · ID not checked' : ''}</small></td>
                <td>{r.commodity}</td><td>{kg(r.net_kg)}<br /><small className="muted">{`${r.bags} bags`}</small></td><td>{`${r.moisture_pct}%`}</td>
                <td>{r.wh_name}</td><td>{fmtDate(r.captured_at)}<br /><small className="muted">{r.clerk}</small></td>
                <td>{holds ? <span className="badge warn">{`${holds} serious`}</span> : null} {reviews ? <span className="badge">{`${reviews} to check`}</span> : null}</td>
                <td><span className={`badge ${STATUS[r.status]}`}>{r.status}</span></td>
              </tr>
            );
          })}</tbody>
        </table>
        {!rows.length && <p className="muted">No deliveries yet.</p>}
      </section>
    </Page>
  );
}

export function IntakePage({ c, i, issue }: { c: Ctx; i: any; issue?: { blockers: string[]; receipts: any[] } }) {
  const kitovu = c.membership?.org_kind === 'kitovu';
  const photo = (sha: string) => i.photos.find((p: any) => p.sha256 === sha);
  const ai = i.ai_check;
  const map = i.lat ? `https://www.openstreetmap.org/?mlat=${i.lat}&mlon=${i.lng}#map=16/${i.lat}/${i.lng}` : null;
  return (
    <Page c={c} title={i.ref}>
      <div className="head">
        <h1>{`Delivery ${i.ref}`}</h1>
        <span className={`badge ${STATUS[i.status]}`}>{i.status}</span>
      </div>
      {(i.flags as Flag[]).length > 0 && <section className="card"><h2>For the reviewer</h2><FlagList flags={i.flags} /></section>}
      <div className="cols">
        <section className="card">
          <h2>What was recorded</h2>
          <dl className="facts">
            <dt>Farmer</dt><dd><a href={`/farmers/${i.farmer_code}`}>{i.farmer_name}</a> {i.farmer_code}{i.kyc_level < 1 ? ' · identity not checked' : ` · level ${i.kyc_level}`}</dd>
            <dt>Crop</dt><dd>{i.commodity}{i.grade ? ` · grade ${i.grade}` : ''}</dd>
            <dt>Net weight</dt><dd><b>{kg(i.net)}</b>{` = ${kg(i.gross)} on the scale − ${i.bags} bags × ${Number(i.tare_per_bag_kg)} kg`}</dd>
            <dt>Moisture</dt><dd>{`${Number(i.moisture_pct)}%`}{i.max_moisture ? ` (limit ${i.max_moisture}%)` : ''}</dd>
            {i.foreign_matter_pct != null && <><dt>Foreign matter</dt><dd>{`${Number(i.foreign_matter_pct)}%`}</dd></>}
            {i.damaged_pct != null && <><dt>Damaged</dt><dd>{`${Number(i.damaged_pct)}%`}</dd></>}
            <dt>Warehouse</dt><dd>{i.wh_name}{i.stack_ref ? ` · stack ${i.stack_ref}` : ''}</dd>
            <dt>Farmer confirmed</dt><dd>{i.farmer_confirmation === 'code' ? 'by code on their phone' : 'signed or thumb-printed slip (photo below)'}</dd>
            <dt>Clerk</dt><dd>{i.clerk}</dd>
            <dt>Captured</dt><dd>{`${fmtDate(i.captured_at)} (phone clock) · uploaded ${fmtDate(i.received_at)}`}</dd>
            <dt>Location</dt><dd>{map ? <a href={map} target="_blank" rel="noopener">{`${Number(i.lat).toFixed(5)}, ${Number(i.lng).toFixed(5)} (±${i.gps_accuracy_m} m)`}</a> : (i.gps_note || 'not recorded')}</dd>
            {i.notes && <><dt>Notes</dt><dd>{i.notes}</dd></>}
          </dl>
          <h2>Weighings</h2>
          <table>
            <thead><tr><th>#</th><th>Bags</th><th>Scale showed</th><th>Display photo</th></tr></thead>
            <tbody>{(i.weighings as any[]).map((w, n) => {
              const p = photo(w.photo);
              const read = ai?.readings?.find((r: any) => r.kind === 'scale' && Number(r.entered) === Number(w.gross_kg));
              return (
                <tr key={n}>
                  <td>{n + 1}</td><td>{w.bags}</td>
                  <td>{kg(w.gross_kg)}{read && <><br /><small className={read.result === 'mismatch' ? 'bad' : 'muted'}>{`AI read: ${read.read ?? 'unreadable'}`}</small></>}</td>
                  <td>{p && <a href={`/files/${p.file_id}`} target="_blank" rel="noopener"><img className="mini" src={`/files/${p.file_id}`} alt={`Scale display, weighing ${n + 1}`} /></a>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </section>
        <section className="card">
          <h2>Photos</h2>
          <div className="gallery">{(i.photos as any[]).filter((p) => p.kind !== 'scale').map((p) => (
            <figure key={p.idx}><a href={`/files/${p.file_id}`} target="_blank" rel="noopener"><img src={`/files/${p.file_id}`} alt={p.kind} /></a><figcaption>{{ moisture: 'Moisture meter', bags: 'Bags', slip: 'Farmer’s slip', other: 'Other' }[p.kind as string]}</figcaption></figure>
          ))}</div>
          <h2>AI reading of the displays</h2>
          {!ai ? <p className="muted">Not run yet.</p> : ai.status !== 'done' ? <p className="muted">{`${ai.status}${ai.error || ai.reason ? `: ${ai.error || ai.reason}` : ''}`}</p> : (
            <table>
              <thead><tr><th>Display</th><th>Typed</th><th>AI read</th><th></th></tr></thead>
              <tbody>{ai.readings.map((r: any) => <tr key={r.photo}><td>{r.label}</td><td>{r.entered}</td><td>{r.read ?? '—'}</td><td className={r.result === 'mismatch' ? 'bad' : ''}>{r.result}</td></tr>)}</tbody>
            </table>
          )}
          {kitovu && <form method="post" action={`/intakes/${i.ref}/ai-recheck`}><Csrf c={c} /><button className="link small">Run the AI reading again</button></form>}
          <p className="muted small">{`Seal ${i.evidence_hash.slice(0, 16)}… · phone record ${i.device_seq} · chain ${i.prev_hash ? i.prev_hash.slice(0, 8) + '…' : 'start'}`}</p>
        </section>
      </div>
      <section className="card">
        <h2>Decision</h2>
        {i.reviewed_at && <p>{`${i.status} by ${i.reviewer} on ${fmtDate(i.reviewed_at)}${i.review_note ? ` — ${i.review_note}` : ''}`}</p>}
        {kitovu && ['submitted', 'held'].includes(i.status) && (i.clerk_user_id === c.user?.id
          ? <p className="flash info">You recorded this delivery, so a colleague must review it.</p>
          : (
            <form method="post" action={`/intakes/${i.ref}/review`} className="row">
              <Csrf c={c} />
              <input name="note" placeholder="Note (required to hold or reject, or to accept with serious flags)" aria-label="Note" />
              <button name="decision" value="accept" className="primary">Accept</button>
              <button name="decision" value="hold">Hold</button>
              <button name="decision" value="reject" className="danger">Reject</button>
            </form>
          ))}
        <p className="muted small">Accepting confirms the stock is in the warehouse as recorded. Records cannot be edited: reject a wrong one and record it again.</p>
      </section>
      {issue && (
        <section className="card">
          <h2>Receipt</h2>
          {issue.receipts.length > 0 && <ul>{issue.receipts.map((r: any) => <li key={r.receipt_no}><a className="mono" href={`/receipts/${r.receipt_no}`}>{r.receipt_no}</a>{` · ${kg(r.net_weight_kg)} · ${r.status}`}</li>)}</ul>}
          {issue.blockers.length > 0
            ? <ul className="flaglist">{issue.blockers.map((b) => <li key={b} className="review">{b}</li>)}</ul>
            : (
              <form method="post" action={`/intakes/${i.ref}/issue`} className="row">
                <Csrf c={c} />
                <input name="split" placeholder="One receipt, or split: a number (e.g. 2) or weights (e.g. 500, 500.5)" aria-label="Split" />
                <button className="primary">Issue receipt</button>
              </form>
            )}
          <p className="muted small">Splitting lets the farmer pledge or sell part of the stock. The farmer gets a text with the receipt number and a link to check it.</p>
        </section>
      )}
    </Page>
  );
}
