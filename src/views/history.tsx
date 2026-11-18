import { fmtNGN } from '../lib/money';
import { LineChart, nairaShort, type Series } from './charts';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const short = nairaShort;
const pct = (a: number, b: number) => { const d = ((a - b) / b) * 100; return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`; };

/** Value over time, from value at storage to today, with what is owed beside it when there is a loan. */
export function ValueHistory({ title, value, owed, note }: { title: string; value: { on: string; kobo: number }[]; owed?: { on: string; kobo: number }[]; note?: string }) {
  const first = value[0], last = value[value.length - 1];
  const series: Series[] = [{ name: 'Value of the stock', tone: 'value', points: value.map((p) => ({ x: p.on, y: p.kobo })) }];
  if (owed?.length) series.push({ name: 'Owed on the loan', tone: 'owed', points: owed.map((p) => ({ x: p.on, y: p.kobo })) });
  if (first) series.push({ name: 'Value at storage', tone: 'base', points: value.length > 1 ? [{ x: first.on, y: first.kobo }, { x: last.on, y: first.kobo }] : [{ x: first.on, y: first.kobo }] });
  const lastOwed = owed?.[owed.length - 1];
  return (
    <section className="card">
      <h2>{title}</h2>
      {first ? (
        <>
          <div className="kpis">
            <div><small>Value at storage</small><b>{N(first.kobo)}</b><small>{new Date(first.on + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</small></div>
            <div><small>Value now</small><b>{N(last.kobo)}</b><small>{`${pct(last.kobo, first.kobo)} since storage`}</small></div>
            {lastOwed && <div><small>Owed now</small><b>{N(lastOwed.kobo)}</b><small>{last.kobo ? `${((lastOwed.kobo / last.kobo) * 100).toFixed(1)}% of the stock’s value` : ''}</small></div>}
            {value.length > 1 && <div><small>Highest and lowest</small><b>{short(Math.max(...value.map((p) => p.kobo)))}</b><small>{`lowest ${short(Math.min(...value.map((p) => p.kobo)))}`}</small></div>}
          </div>
          <LineChart series={series} fmt={short} label={title} minZero={false} />
          <p className="muted small">{note ?? 'Each point is the day’s reference price times the kilograms still held. Days without an approved price carry the last value forward.'}</p>
        </>
      ) : <p className="muted">No value yet: no market price had been approved for this crop. Values appear here from the first approved price.</p>}
    </section>
  );
}
