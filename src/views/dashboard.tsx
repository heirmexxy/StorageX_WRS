import type { Ctx } from '../lib/http';
import { fmtNGN } from '../lib/money';
import { monthLabel } from '../lib/dashboard';
import { Page } from './layout';
import { BarChart, LineChart, nairaShort } from './charts';
import { ValueHistory } from './history';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const short = nairaShort;
const tons = (kg: number) => (kg >= 1000 ? `${(kg / 1000).toLocaleString('en-NG', { maximumFractionDigits: 1 })} t` : `${Math.round(kg)} kg`);
const int = (n: number) => Math.round(n).toLocaleString('en-NG');
const pct = (a: number, b: number) => (b ? `${a >= b ? '+' : '−'}${Math.abs(((a - b) / b) * 100).toFixed(0)}% on last month` : 'first month with revenue');
const STATE: Record<string, [string, string]> = { ok: ['ok', 'Within limits'], warn: ['warn', 'Needs a look'], bad: ['bad', 'Act now'], none: ['', 'Not connected'] };

export function DashboardPage({ c, rev, growth, flows, snap, book, connected }: { c: Ctx; rev: any[]; growth: any[]; flows: any[]; snap: any; book: any; connected: boolean }) {
  const thisM = rev.at(-1)!, lastM = rev.at(-2)!;
  const year = new Date().getFullYear().toString();
  const ytd = rev.filter((m) => m.ym.startsWith(year)).reduce((n, m) => n + m.total, 0);
  const g = growth.at(-1)!;
  return (
    <Page c={c} title="Business dashboard">
      <div className="head"><h1>Business dashboard</h1><span><a className="button" href="/dashboard/revenue.csv">Revenue (CSV)</a></span></div>

      <section className="card">
        <h2>Revenue</h2>
        <div className="kpis">
          <div><small>This month</small><b>{N(thisM.total)}</b><small>{pct(thisM.total, lastM.total)}</small></div>
          <div><small>Last month</small><b>{N(lastM.total)}</b></div>
          <div><small>{`So far in ${year}`}</small><b>{N(ytd)}</b></div>
          <div><small>Last 12 months</small><b>{N(rev.reduce((n, m) => n + m.total, 0))}</b></div>
        </div>
        <BarChart label="Kitovu revenue by month" fmt={short} rows={rev.map((m) => ({ x: monthLabel(m.ym), parts: [
          { name: 'Storage', y: m.parts.Storage, tone: 'value' }, { name: 'Handling', y: m.parts.Handling, tone: 'soft' },
          { name: 'Commission', y: m.parts.Commission, tone: 'base' }, { name: 'Own-book loan fees', y: m.parts['Own-book loan fees'], tone: 'owed' }] }))} />
        <p className="muted small">Kitovu’s share of each settled sale (storage, handling, commission), counted in the month the sale was settled, plus fees on loans Kitovu made from its own balance sheet.</p>
      </section>

      <section className="card">
        <h2>Farmers</h2>
        <div className="kpis">
          <div><small>Registered</small><b>{int(snap.farmers.total)}</b><small>{`${g.added} added this month`}</small></div>
          <div><small>Identity checked</small><b>{int(snap.farmers.verified)}</b><small>{snap.farmers.total ? `${Math.round((snap.farmers.verified / snap.farmers.total) * 100)}% of registered` : ''}</small></div>
          <div><small>With produce in store</small><b>{int(snap.farmers.with_stock)}</b></div>
          <div><small>Women</small><b>{int(snap.farmers.women)}</b><small>{snap.farmers.total ? `${Math.round((snap.farmers.women / snap.farmers.total) * 100)}% of registered` : ''}</small></div>
        </div>
        <LineChart label="Farmers registered, running total, and farmers delivering each month" fmt={int}
          series={[{ name: 'Registered (total)', tone: 'value', points: growth.map((m) => ({ x: monthLabel(m.ym), y: m.total })) },
            { name: 'Delivering that month', tone: 'base', points: growth.map((m) => ({ x: monthLabel(m.ym), y: m.delivering })) }]} />
      </section>

      <section className="card">
        <h2>What flows through StorageX</h2>
        <div className="kpis">
          <div><small>In store now</small><b>{tons(snap.stockKg)}</b><small>{`worth ${short(snap.stockValue)} today`}</small></div>
          <div><small>Owed to lenders</small><b>{short(snap.book.outstanding)}</b><small>{`${snap.book.loans} loan${snap.book.loans === 1 ? '' : 's'} running`}</small></div>
          <div><small>Loan ÷ stock value</small><b>{snap.book.ltv_bp == null ? '—' : `${(snap.book.ltv_bp / 100).toFixed(1)}%`}</b></div>
          <div><small>Warehouses</small><b>{int(snap.orgs.warehouses)}</b><small>certified or active</small></div>
        </div>
        <BarChart label="Produce received each month" fmt={tons} rows={flows.map((m) => ({ x: monthLabel(m.ym), parts: [{ name: 'Accepted deliveries', y: m.kg }] }))} />
        <BarChart label="Loans paid out and sales settled each month" fmt={short} rows={flows.map((m) => ({ x: monthLabel(m.ym), parts: [{ name: 'Loans paid out', y: m.lent, tone: 'value' }, { name: 'Sales settled', y: m.sold, tone: 'base' }] }))} />
        {Object.keys(snap.byCrop).length > 0 && <table><thead><tr><th>Crop in store</th><th>Weight</th><th>Value today</th></tr></thead>
          <tbody>{Object.entries(snap.byCrop).map(([k, v]: any) => <tr key={k}><td>{k}</td><td>{tons(v.kg)}</td><td>{v.value ? N(v.value) : 'no price'}</td></tr>)}</tbody></table>}
      </section>

      <ValueHistory title="All lenders: stock value and what is owed" value={book.value} owed={book.owed} note="Every running loan, all lenders together: the receipts behind them valued daily, and what was owed each day." />

      <section className="card">
        <h2>WareGuard health</h2>
        {!connected && <p className="flash info">WareGuard is not connected to StorageX yet. When Titan starts sending readings, each warehouse’s conditions show here and alerts start on their own.</p>}
        <table>
          <thead><tr><th>Warehouse</th><th>Status</th><th>Temperature</th><th>Humidity</th><th>Doors (24 h)</th><th>Devices</th><th>Open alerts</th></tr></thead>
          <tbody>{snap.wareguard.map((w: any) => { const h = w.h; const [tone, label] = STATE[h?.state ?? 'none']; return (
            <tr key={w.id}><td><a href={`/stock-watch/${w.code}`}>{w.name}</a><br /><small className="muted">{w.state}</small></td>
              <td><i className={`dot ${tone}`} />{label}</td>
              <td>{h?.temp_c != null ? `${h.temp_c.toFixed(1)}°C` : '—'}</td><td>{h?.rh_pct != null ? `${h.rh_pct.toFixed(0)}%` : '—'}</td>
              <td>{h?.devices ? String(h.door_events_24h) : '—'}</td><td>{h?.devices ? `${h.online} of ${h.devices} reporting` : '—'}</td>
              <td>{h?.alerts?.length ? h.alerts.map((a: any) => a.advice?.headline ?? a.kind).join(' ') : '—'}</td></tr>
          ); })}</tbody>
        </table>
        {!snap.wareguard.length && <p className="muted">No certified warehouses yet.</p>}
      </section>
    </Page>
  );
}
