import type { Ctx } from '../lib/http';
import { fmtNGN } from '../lib/money';
import { KIND_LABEL } from '../lib/alerts';
import { Page, Csrf, fmtDate, fmtDay } from './layout';
import { LineChart, hourKey } from './charts';

const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;
const chg = (now: number | null, then: number | null) => (now == null || !then ? '' : `${now >= then ? '+' : '−'}${Math.abs(((now - then) / then) * 100).toFixed(1)}%`);
const ago = (d: string | Date | null) => { if (!d) return 'never'; const m = (Date.now() - new Date(d).getTime()) / 60_000; return m < 2 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const STATE: Record<string, [string, string]> = { ok: ['ok', 'Conditions within limits'], warn: ['warn', 'Needs a look'], bad: ['bad', 'Act now'], none: ['', 'WareGuard not connected yet'] };

export function AlertsPage({ c, rows, all }: { c: Ctx; rows: any[]; all: boolean }) {
  const unseen = rows.filter((r) => !r.seen_at).length;
  return (
    <Page c={c} title="Alerts">
      <div className="head"><h1>Alerts</h1>
        {unseen > 0 && <form method="post" action="/alerts/seen"><Csrf c={c} /><input type="hidden" name="id" value="all" /><button>Mark all as seen</button></form>}</div>
      <p className="muted">Prices closing in on a loan’s limits, offers and sales of pledged stock, and warehouse conditions from WareGuard. Each alert says what to do.</p>
      {rows.length ? (
        <ul className="alert-list">{rows.map((r) => (
          <li key={r.id} className={`${r.level}${r.seen_at ? ' seen' : ''}`}>
            <small className="muted">{`${KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind} · ${fmtDate(r.created_at)}`}</small>
            <b>{r.title}</b>
            <p>{r.body}</p>
            <span className="small">{r.link && <a href={r.link}>Open</a>}{r.seen_at ? <span className="muted">{` · seen by ${r.seen_name ?? 'someone'} ${fmtDay(r.seen_at)}`}</span>
              : <form method="post" action="/alerts/seen" className="inline"><Csrf c={c} /><input type="hidden" name="id" value={r.id} /> <button className="link">Mark as seen</button></form>}</span>
          </li>
        ))}</ul>
      ) : <p className="ok">No alerts. You will see one here as soon as something needs your attention.</p>}
      {!all && <p className="small"><a href="/alerts?all=1">Show older alerts</a></p>}
    </Page>
  );
}

function Conditions({ wg }: { wg: any }) {
  if (!wg || !wg.devices) return <p className="muted">This warehouse has no WareGuard readings in StorageX yet. Once WareGuard is connected through Titan, temperature, humidity and door openings appear here and alerts start automatically.</p>;
  const [tone, label] = STATE[wg.state];
  return (
    <div className="wg">
      <span><i className={`dot ${tone}`} />{label}</span>
      <span>{wg.temp_c != null ? `${wg.temp_c.toFixed(1)}°C` : '—'}</span>
      <span>{wg.rh_pct != null ? `${wg.rh_pct.toFixed(0)}% humidity` : '—'}</span>
      <span>{wg.door_open_now ? 'Door open now' : `${wg.door_events_24h} door opening${wg.door_events_24h === 1 ? '' : 's'} in 24 h`}</span>
      <span className="muted">{`${wg.online} of ${wg.devices} device${wg.devices === 1 ? '' : 's'} reporting · ${ago(wg.last_at)}`}</span>
    </div>
  );
}

export function WatchListPage({ c, rows, connected }: { c: Ctx; rows: any[]; connected: boolean }) {
  const lender = c.membership?.org_kind === 'lender';
  return (
    <Page c={c} title="Stock watch">
      <h1>Stock watch</h1>
      <p className="muted">{lender ? 'Every warehouse holding stock pledged to you: conditions inside, what the stock was worth when stored and what it is worth today.' : 'Every warehouse holding stock: conditions inside and the value of what is stored.'}</p>
      {!connected && <p className="flash info">WareGuard is not connected to StorageX yet. Values, insurance and counts below are live; conditions appear once Titan sends readings.</p>}
      {rows.length ? (
        <table>
          <thead><tr><th>Warehouse</th><th>Conditions</th><th>{lender ? 'Your stock' : 'Stock'}</th><th>Value at storage</th><th>Value today</th></tr></thead>
          <tbody>{rows.map((w) => (
            <tr key={w.id}><td><a href={`/stock-watch/${w.code}`}>{w.name}</a><br /><small className="muted">{`${w.state} · tier ${w.tier}`}</small></td>
              <td><Conditions wg={w.wg} /></td>
              <td>{kg(w.kg)}<br /><small className="muted">{`${w.receipts} receipt${w.receipts === 1 ? '' : 's'}`}</small></td>
              <td>{w.value_storage ? N(w.value_storage) : '—'}</td>
              <td>{w.value_now ? N(w.value_now) : '—'}{w.value_storage && w.value_now ? <><br /><small className={w.value_now >= w.value_storage ? 'ok' : 'bad'}>{chg(w.value_now, w.value_storage)}</small></> : null}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="muted">{lender ? 'No stock is pledged to you yet.' : 'No stock in store yet.'}</p>}
    </Page>
  );
}

export function WatchSitePage({ c, s, devices }: { c: Ctx; s: any; devices?: any[] }) {
  const { w, stock, wg, flags } = s;
  const lender = c.membership?.org_kind === 'lender';
  const totNow = stock.reduce((n: number, r: any) => n + (r.value_now ?? 0), 0), totBase = stock.reduce((n: number, r: any) => n + (r.value_storage ?? 0), 0);
  const series = wg?.series ?? [];
  return (
    <Page c={c} title={`Stock watch · ${w.name}`}>
      <div className="head"><h1>{w.name}</h1><span className="muted">{`${w.state} State · tier ${w.tier} · run by ${w.operator}`}</span></div>
      <section className="card">
        <h2>Conditions inside</h2>
        <Conditions wg={wg} />
        {wg?.alerts?.length ? (
          <ul className="alert-list">{wg.alerts.map((a: any) => (
            <li key={a.id} className={a.severity}>
              <b>{a.advice?.headline ?? a.kind}</b>
              {a.advice?.note && <p>{a.advice.note}</p>}
              <p>{a.advice?.why}</p>
              {!lender && a.advice?.actions && <ol>{a.advice.actions.map((x: string) => <li key={x}>{x}</li>)}</ol>}
              {lender && <p>{a.advice?.for_lenders}</p>}
              <small className="muted">{`Since ${fmtDate(a.started_at)}`}</small>
            </li>
          ))}</ul>
        ) : null}
        {series.length > 1 && <>
          <h3>Last 48 hours</h3>
          <LineChart label="Temperature" fmt={(n) => `${n.toFixed(0)}°C`} minZero={false}
            series={[{ name: 'Temperature', tone: 'temp', points: series.filter((p: any) => p.t != null).map((p: any) => ({ x: hourKey(p.h), y: p.t })) },
              { name: `Limit ${wg.limits.temp}°C`, tone: 'base', points: [{ x: hourKey(series[0].h), y: wg.limits.temp }, { x: hourKey(series.at(-1).h), y: wg.limits.temp }] }]} />
          <LineChart label="Relative humidity" fmt={(n) => `${n.toFixed(0)}%`} minZero={false}
            series={[{ name: 'Humidity', tone: 'rh', points: series.filter((p: any) => p.rh != null).map((p: any) => ({ x: hourKey(p.h), y: p.rh })) },
              { name: `Limit ${wg.limits.rh}%`, tone: 'base', points: [{ x: hourKey(series[0].h), y: wg.limits.rh }, { x: hourKey(series.at(-1).h), y: wg.limits.rh }] }]} />
        </>}
      </section>
      {devices && (
        <section className="card">
          <h2>WareGuard devices</h2>
          {devices.length ? (
            <table><thead><tr><th>Device</th><th>Last reading</th><th>Temperature</th><th>Humidity</th><th>Door</th><th>Battery</th><th></th></tr></thead>
              <tbody>{devices.map((d) => (
                <tr key={d.id} className={d.active ? '' : 'muted'}><td>{d.label}<br /><small className="mono muted">{d.device_ref}</small></td>
                  <td>{d.last_at ? ago(d.last_at) : 'never'}</td><td>{d.temp_c != null ? `${d.temp_c.toFixed(1)}°C` : '—'}</td><td>{d.rh_pct != null ? `${d.rh_pct.toFixed(0)}%` : '—'}</td>
                  <td>{d.door_open == null ? '—' : d.door_open ? 'Open' : 'Closed'}</td><td>{d.battery_pct != null ? `${d.battery_pct.toFixed(0)}%` : '—'}</td>
                  <td>{d.active ? <form method="post" action={`/stock-watch/${w.code}/devices/${d.id}/retire`}><Csrf c={c} /><button className="link">Retire</button></form> : 'Retired'}</td></tr>
              ))}</tbody></table>
          ) : <p className="muted">No devices yet. Titan adds them automatically; you can also add one by its id.</p>}
          <form method="post" action={`/stock-watch/${w.code}/devices`} className="inline-form"><Csrf c={c} />
            <label className="field"><span>Device id (on the unit)</span><input name="ref" required /></label>
            <label className="field"><span>Where it is</span><input name="label" placeholder="Bay 2, north wall" /></label>
            <button>Add device</button>
          </form>
        </section>
      )}
      <section className="card">
        <h2>{lender ? 'Your stock here' : 'Stock here'}</h2>
        <div className="kpis">
          <div><small>Held</small><b>{kg(stock.reduce((n: number, r: any) => n + r.kg, 0))}</b><small>{`${stock.length} receipt${stock.length === 1 ? '' : 's'}`}</small></div>
          <div><small>Value at storage</small><b>{totBase ? N(totBase) : '—'}</b></div>
          <div><small>Value today</small><b>{totNow ? N(totNow) : '—'}</b><small>{chg(totNow, totBase)}</small></div>
          <div><small>Insurance</small><b>{w.policy ? 'Current' : 'None'}</b><small>{w.policy ? `${w.policy.insurer_name}, to ${fmtDay(w.policy.cover_to)}` : 'no active policy on record'}</small></div>
          <div><small>Last count</small><b>{w.last_count ? fmtDay(w.last_count) : 'Never'}</b><small>{flags.length ? `${flags.length} open check${flags.length === 1 ? '' : 's'}` : 'counts agree with receipts'}</small></div>
        </div>
        <table>
          <thead><tr><th>Receipt</th><th>Stock</th><th>Loan</th><th>Value at storage</th><th>Value today</th><th>Insured at issue</th></tr></thead>
          <tbody>{stock.map((r: any) => (
            <tr key={r.id}><td><a className="mono" href={`/receipts/${r.receipt_no}`}>{r.receipt_no}</a><br /><small className="muted">{r.farmer_name}</small></td>
              <td>{`${kg(r.kg)} ${r.crop}${r.grade ? `, ${r.grade}` : ''}`}</td>
              <td>{r.loan_no ? <a className="mono" href={`/loans/${r.loan_no}`}>{r.loan_no}</a> : '—'}</td>
              <td>{r.value_storage != null ? N(r.value_storage) : '—'}</td>
              <td>{r.value_now != null ? N(r.value_now) : 'no price'}{r.value_now != null && r.value_storage ? <><br /><small className={r.value_now >= r.value_storage ? 'ok' : 'bad'}>{chg(r.value_now, r.value_storage)}</small></> : null}</td>
              <td>{r.insurer_name ? `${r.insurer_name}${r.policy_number ? ` ${r.policy_number}` : ''}` : <span className="badge warn">no</span>}</td></tr>
          ))}</tbody>
        </table>
        {flags.length > 0 && <ul className="flaglist">{flags.map((f: any, k: number) => <li key={k} className={f.severity}>{`${f.commodity}: ${f.text}`}</li>)}</ul>}
      </section>
    </Page>
  );
}
