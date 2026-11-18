import type { Ctx } from '../lib/http';
import { fmtNGN } from '../lib/money';
import { Page, fmtDay } from './layout';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;
const sign = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`);

export function OffersPage({ c, lots }: { c: Ctx; lots: any[] }) {
  const kitovu = c.membership?.org_kind === 'kitovu';
  return (
    <Page c={c} title="Buyer offers">
      <h1>Buyer offers for pledged stock</h1>
      <p className="muted">{`Written offers from buyers, entered by Kitovu, and sales already proposed, sorted best first for each lot of ${kitovu ? 'pledged' : 'your pledged'} stock. Each line shows what the sale would bring after Kitovu’s fees and whether it repays the loans. Nothing here is a sale until Kitovu proposes it and ${kitovu ? 'the lender approves' : 'you approve'} it.`}</p>
      {lots.length ? lots.map((l) => (
        <section className="card" key={`${l.warehouse_id}:${l.commodity_code}`}>
          <div className="head"><h2>{`${l.crop} at ${l.wh_name}`}</h2><span className="muted">{`${kg(l.kg)} on ${l.receipts} receipt${l.receipts === 1 ? '' : 's'} · ${N(l.owed)} owed`}</span></div>
          <p className="small muted">{`Today’s reference price ${l.ref_per_kg ? `${fmtNGN(l.ref_per_kg)}/kg` : 'not available'}${l.storage_per_kg ? ` · at storage ${fmtNGN(l.storage_per_kg)}/kg` : ''}`}</p>
          <p className="flash info">{l.advice}</p>
          {l.offers.length > 0 && (
            <table>
              <thead><tr><th>Buyer</th><th>Price</th><th>vs today</th><th>vs storage</th><th>Brings</th><th>Repays</th><th>Check</th></tr></thead>
              <tbody>{l.offers.map((o: any, i: number) => (
                <tr key={o.id} className={i === 0 ? 'offer-best' : ''}>
                  <td>{o.ref ? <a href={`/sales/${o.ref}`}>{o.buyer}</a> : o.buyer}<br /><small className="muted">{`${o.source === 'sale' ? 'Proposed sale' : 'Written offer'} · ${fmtDay(o.on)}${o.state ? ` · ${o.state}` : ''}`}</small></td>
                  <td>{`${fmtNGN(o.per_kg)}/kg`}</td>
                  <td>{sign(o.vs_ref_pct)}</td><td>{sign(o.vs_storage_pct)}</td>
                  <td>{N(o.gross)}<br /><small className="muted">{`${N(o.fees)} fees`}</small></td>
                  <td>{o.covers === null ? '—' : o.covers >= 1 ? <span className="ok">In full</span> : <span className="bad">{`${Math.round(o.covers * 100)}%`}</span>}</td>
                  <td>{o.flags.length ? <ul className="flaglist">{o.flags.map((f: string) => <li key={f} className="review">{f}</li>)}</ul> : <span className="ok">Nothing to flag</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {kitovu && <p className="small"><a href="/sales">Propose a sale</a> · <a href="/prices">Enter a buyer’s written offer as a price</a></p>}
        </section>
      )) : <p className="muted">{kitovu ? 'No stock is pledged yet.' : 'No stock is pledged to you yet.'}</p>}
    </Page>
  );
}
