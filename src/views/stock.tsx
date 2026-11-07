import type { Ctx } from '../lib/http';
import { can } from '../lib/rbac';
import { Page, Csrf, Field, Select, fmtDate, fmtDay } from './layout';

const kg = (n: number) => `${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg`;
const kitovu = (c: Ctx) => c.membership?.org_kind === 'kitovu';

export function StockOverviewPage({ c, rows }: { c: Ctx; rows: any[] }) {
  return (
    <Page c={c} title="Stock">
      <h1>Stock</h1>
      <p className="muted">The ledger holds every kilo in and out. Receipts say who owns it. Counts check it is really there.</p>
      <section className="card">
        <table>
          <thead><tr><th>Warehouse</th><th>In the ledger</th><th>Owed on receipts</th><th>Last count</th><th>Waiting</th></tr></thead>
          <tbody>{rows.map((w) => (
            <tr key={w.id}>
              <td><a href={`/stock/${w.code}`}>{w.name}</a><br /><small className="muted">{`${w.code} · ${w.status}`}</small></td>
              <td>{kg(w.book_kg)}</td>
              <td className={w.owed_kg > w.book_kg + 0.5 ? 'bad' : ''}>{kg(w.owed_kg)}</td>
              <td>{w.last_count ? fmtDay(w.last_count) : <span className="badge warn">never</span>}</td>
              <td>{w.pending_rel ? <span className="badge">{`${w.pending_rel} release${w.pending_rel > 1 ? 's' : ''} to load`}</span> : null} {w.pending_adj ? <span className="badge warn">{`${w.pending_adj} adjustment${w.pending_adj > 1 ? 's' : ''}`}</span> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}

export function WarehouseStockPage({ c, w, rec, stacks, adj, rels, moves, commodities, flash }: { c: Ctx; w: any; rec: any[]; stacks: any[]; adj: any[]; rels: any[]; moves: any[]; commodities: { code: string; name: string }[]; flash?: string }) {
  const open = stacks.filter((s) => s.status === 'open');
  const stackOpts = (filter?: (s: any) => boolean): [string, string][] => open.filter(filter ?? (() => true)).map((s) => [s.id, `${s.code} · ${s.commodity} · ${kg(s.kg)}`]);
  return (
    <Page c={c} title={`Stock · ${w.name}`}>
      <div className="head"><h1>{`Stock · ${w.name}`}</h1><span className="muted mono">{w.code}</span></div>
      {flash && <p className="flash ok">{flash}</p>}
      <section className="card">
        <h2>Reconciliation</h2>
        <table>
          <thead><tr><th>Crop</th><th>Ledger</th><th>Owed on receipts</th><th>Counted*</th><th>Checks</th>{kitovu(c) && can(c.membership, 'receipts.issue') && <th></th>}</tr></thead>
          <tbody>{rec.map((r) => (
            <tr key={r.commodity_code}>
              <td>{r.commodity}</td>
              <td>{kg(r.book_kg)}<br /><small className="muted">{`${r.book_bags} bags`}</small></td>
              <td>{kg(r.owed_kg)}<br /><small className="muted">{`${r.receipts} receipt${r.receipts === 1 ? '' : 's'}${r.under_review ? ` · ${r.under_review} under review` : ''}`}</small></td>
              <td>{r.counted_kg != null ? kg(r.counted_kg) : '—'}{r.oldest && <><br /><small className="muted">{`oldest ${fmtDay(r.oldest)}`}</small></>}</td>
              <td>{r.flags.length ? <ul className="flaglist">{r.flags.map((f: any) => <li key={f.text} className={f.severity}>{f.text}</li>)}</ul> : <span className="ok">All agree</span>}</td>
              {kitovu(c) && can(c.membership, 'receipts.issue') && (
                <td>
                  <form method="post" action={`/stock/${w.code}/review`}>
                    <Csrf c={c} /><input type="hidden" name="commodity" value={r.commodity_code} /><input type="hidden" name="on" value={r.under_review ? '0' : '1'} />
                    <input name="note" placeholder={r.under_review ? 'Why it is resolved' : 'Why (internal)'} aria-label="Note" required />
                    <button className={r.under_review ? '' : 'danger'}>{r.under_review ? 'End review' : 'Put receipts under review'}</button>
                  </form>
                </td>
              )}
            </tr>
          ))}</tbody>
        </table>
        {!rec.length && <p className="muted">No stock here yet.</p>}
        <p className="muted small">* Each stack’s latest count, plus or minus what has moved on that stack since it was counted. “Put receipts under review” makes every valid receipt for that crop here show “Under review” on its public page, so nobody lends or buys against stock in doubt.</p>
      </section>

      <section className="card">
        <h2>Stacks</h2>
        <table>
          <thead><tr><th>Stack</th><th>Crop</th><th>Ledger</th><th>Last count</th><th>Difference</th></tr></thead>
          <tbody>{stacks.map((s) => {
            const diff = s.count_kg != null ? s.count_kg - s.count_book_kg : null;
            return (
              <tr key={s.id}>
                <td className="mono">{s.code}{s.status !== 'open' && <> <span className="badge">closed</span></>}</td><td>{s.commodity}</td>
                <td>{kg(s.kg)}<br /><small className="muted">{`${s.bags} bags`}</small></td>
                <td>{s.counted_at ? <>{`${kg(s.count_kg)} · ${s.count_bags} bags`}<br /><small className="muted">{fmtDate(s.counted_at)}</small></> : <span className="badge warn">not counted</span>}</td>
                <td className={diff != null && Math.abs(diff) > Math.max(5, s.count_book_kg * 0.01) ? 'bad' : ''}>{diff == null ? '—' : `${diff > 0 ? '+' : ''}${kg(diff)}`}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </section>

      <div className="cols">
        <section className="card">
          <h2>Record a count</h2>
          <form method="post" action={`/stock/${w.code}/count`} encType="multipart/form-data">
            <Csrf c={c} />
            <Select label="Stack" name="stack" blank="Choose…" required options={stackOpts()} />
            <Field label="Bags counted" name="bags" inputMode="numeric" required />
            <div className="grid"><Field label="Sample: bags weighed" name="sample_bags" inputMode="numeric" hint="e.g. 5 bags picked at random" /><Field label="Sample: their total kg" name="sample_kg" inputMode="decimal" /></div>
            <Field label="Photo of the stack and its card" name="photo" type="file" accept="image/*" capture="environment" />
            <Field label="Note" name="note" />
            <button className="primary">Save count</button>
          </form>
        </section>
        <section className="card">
          <h2>Move between stacks</h2>
          <form method="post" action={`/stock/${w.code}/transfer`}>
            <Csrf c={c} />
            <Select label="From" name="from" required options={[['unplaced', 'Not on a stack yet'], ...stackOpts()]} />
            <Select label="To" name="to" blank="Choose…" required options={stackOpts()} />
            <div className="grid"><Field label="kg" name="kg" inputMode="decimal" required /><Field label="Bags" name="bags" inputMode="numeric" /></div>
            <button>Move</button>
          </form>
          <h2>New stack</h2>
          <form method="post" action={`/stock/${w.code}/stack`} className="grid">
            <Csrf c={c} />
            <Field label="Code on the stack card" name="code" required />
            <Select label="Crop" name="commodity" blank="Choose…" required options={commodities.map((k) => [k.code, k.name])} />
            <button>Add stack</button>
          </form>
        </section>
      </div>

      <section className="card">
        <h2>Losses and corrections</h2>
        <form method="post" action={`/stock/${w.code}/adjust`} encType="multipart/form-data" className="grid">
          <Csrf c={c} />
          <Select label="Stack" name="stack" blank="Choose…" required options={stackOpts()} />
          <Field label="Change in kg" name="kg" inputMode="decimal" required hint="Negative for a loss, e.g. -25" />
          <Field label="Change in bags" name="bags" inputMode="numeric" />
          <Select label="Reason" name="reason" blank="Choose…" required options={[['moisture_loss', 'Moisture loss'], ['pest_damage', 'Pest damage'], ['spillage', 'Spillage'], ['theft', 'Theft'], ['recount_correction', 'Recount correction'], ['other', 'Other']]} />
          <Field label="What happened" name="note" required />
          <Field label="Photo" name="photo" type="file" accept="image/*" capture="environment" />
          <button>Propose</button>
        </form>
        <p className="muted small">Nothing changes until a Kitovu person other than you approves it.</p>
        {adj.length > 0 && (
          <table>
            <thead><tr><th>Stack</th><th>Change</th><th>Reason</th><th>Proposed</th><th>Status</th></tr></thead>
            <tbody>{adj.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.stack_code}</td><td>{`${x.kgf > 0 ? '+' : ''}${kg(x.kgf)}`}</td><td>{`${x.reason.replace(/_/g, ' ')}: ${x.note}`}</td><td>{`${x.proposer}, ${fmtDay(x.proposed_at)}`}</td>
                <td>{x.status === 'proposed' && kitovu(c) && x.proposed_by !== c.user?.id ? (
                  <form method="post" action={`/stock/adjustments/${x.id}`} className="row">
                    <Csrf c={c} /><input name="note" placeholder="Note" aria-label="Note" /><button name="decision" value="approve" className="primary">Approve</button><button name="decision" value="reject" className="danger">Reject</button>
                  </form>
                ) : <span className={`badge ${x.status === 'approved' ? 'ok' : x.status === 'proposed' ? 'warn' : ''}`}>{x.status}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Releases</h2>
        {rels.length ? (
          <table>
            <thead><tr><th>Ref</th><th>Receipt</th><th>Owner</th><th>Ordered</th><th>Collector</th><th>Status</th></tr></thead>
            <tbody>{rels.map((x) => (
              <tr key={x.id}><td><a className="mono" href={`/releases/${x.ref}`}>{x.ref}</a></td><td className="mono">{x.receipt_no}</td><td>{x.owner}</td>
                <td>{`${kg(x.ordered)} ${x.commodity}`}<br /><small className="muted">{`${x.orderer}, ${fmtDay(x.ordered_at)}`}</small></td><td>{x.collector_name}</td>
                <td><span className={`badge ${x.status === 'ordered' ? 'warn' : x.status === 'loaded' ? 'ok' : ''}`}>{x.status === 'loaded' ? `loaded ${kg(x.loaded)}` : x.status}</span></td></tr>
            ))}</tbody>
          </table>
        ) : <p className="muted">No releases. Kitovu orders them from the receipt page.</p>}
      </section>

      <section className="card">
        <h2>Ledger (latest 100)</h2>
        <table>
          <thead><tr><th>When</th><th>What</th><th>Stack</th><th>kg</th><th>Bags</th><th>By</th></tr></thead>
          <tbody>{moves.map((m) => (
            <tr key={m.id}><td>{fmtDate(m.created_at)}</td><td>{`${{ in: 'In', out: 'Out', transfer_in: 'Moved in', transfer_out: 'Moved out', adjust: 'Adjustment' }[m.kind as 'in']}${m.ref ? ` · ${m.ref}` : ''}`}<br /><small className="muted">{m.commodity}</small></td>
              <td className="mono">{m.stack_code ?? '—'}</td><td className={m.kgf < 0 ? 'bad' : ''}>{`${m.kgf > 0 ? '+' : ''}${m.kgf.toLocaleString('en-NG')}`}</td><td>{m.bags}</td><td>{m.by_name ?? '—'}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </Page>
  );
}

export function ReleasePage({ c, x, stacks }: { c: Ctx; x: any; stacks: any[] }) {
  return (
    <Page c={c} title={x.ref}>
      <div className="head"><h1 className="mono">{x.ref}</h1><span className={`badge ${x.status === 'ordered' ? 'warn' : x.status === 'loaded' ? 'ok' : ''}`}>{x.status}</span></div>
      <section className="card">
        <dl className="facts">
          <dt>Receipt</dt><dd className="mono">{x.receipt_no}</dd>
          <dt>Owner</dt><dd>{`${x.owner ?? '—'} ${x.owner_code ?? ''}`}</dd>
          <dt>To release</dt><dd><b>{kg(x.ordered)}</b>{` ${x.commodity} from ${x.wh_name}`}</dd>
          <dt>Why</dt><dd>{x.reason.replace(/_/g, ' ')}</dd>
          <dt>Collector</dt><dd>{`${x.collector_name}${x.collector_phone ? `, ${x.collector_phone}` : ''}`}</dd>
          <dt>Ordered</dt><dd>{`${x.orderer}, ${fmtDate(x.ordered_at)}`}</dd>
          {x.status === 'loaded' && <><dt>Loaded</dt><dd>{`${kg(x.loaded)} in ${x.bags_loaded} bags by ${x.loader}, ${fmtDate(x.loaded_at)}`}</dd></>}
          {x.note && <><dt>Note</dt><dd>{x.note}</dd></>}
        </dl>
        {x.status === 'loaded' && <p>{x.scale_photo_id && <a href={`/files/${x.scale_photo_id}`} target="_blank" rel="noopener">Scale photo</a>}{' · '}{x.slip_photo_id && <a href={`/files/${x.slip_photo_id}`} target="_blank" rel="noopener">Signed slip</a>}</p>}
      </section>
      {x.status === 'ordered' && (x.ordered_by === c.user?.id
        ? <p className="flash info">You ordered this release, so someone else at the warehouse must load it.</p>
        : (
          <section className="card">
            <h2>Load and weigh out</h2>
            <p className="muted">Check the collector’s ID matches the name above. Weigh the bags, photograph the scale display, and have the collector sign or thumb-print the release slip.</p>
            <form method="post" action={`/releases/${x.ref}/load`} encType="multipart/form-data" className="grid">
              <Csrf c={c} />
              <Select label="Taken from stack" name="stack" blank="Choose…" required options={stacks.filter((s) => s.commodity_code === x.commodity_code && s.status === 'open').map((s) => [s.id, `${s.code} · ${kg(s.kg)}`])} />
              <Field label="Scale shows (kg)" name="kg" inputMode="decimal" required />
              <Field label="Bags loaded" name="bags" inputMode="numeric" required />
              <Field label="Photo of the scale display" name="scale" type="file" accept="image/*" capture="environment" required />
              <Field label="Photo of the signed release slip" name="slip" type="file" accept="image/*,application/pdf" capture="environment" required />
              <Field label="Note" name="note" />
              <button className="primary">Confirm loading</button>
            </form>
          </section>
        ))}
      {x.status === 'ordered' && kitovu(c) && can(c.membership, 'receipts.issue') && (
        <section className="card">
          <form method="post" action={`/releases/${x.ref}/cancel`} className="row"><Csrf c={c} /><input name="note" placeholder="Why cancel" aria-label="Reason" required /><button className="danger">Cancel release</button></form>
        </section>
      )}
    </Page>
  );
}
