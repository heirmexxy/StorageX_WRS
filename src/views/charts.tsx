// Small server-drawn SVG charts. No scripts and no inline styles (the site's security policy forbids both):
// colours come from classes in app.css. Each chart has a text summary for screen readers.

type Pt = { x: string; y: number };   // x = YYYY-MM-DD or a label
export interface Series { name: string; points: Pt[]; tone?: 'value' | 'owed' | 'base' | 'temp' | 'rh' }

const W = 720, H = 240, PL = 64, PR = 16, PT = 16, PB = 34;

/** A tidy axis: round step (1, 2, 2.5 or 5 × a power of ten) and bounds on that step. */
function niceAxis(lo: number, hi: number, n = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks: number[] = []; for (let v = a; v <= b + step / 2; v += step) ticks.push(v);
  return { lo: a, hi: b, ticks };
}
const shortDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  : /^\d{4}-\d{2}-\d{2} \d{2}$/.test(s) ? `${new Date(s.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${s.slice(11)}:00` : s;
/** A sortable hour label in Lagos time, for hourly charts. */
export const hourKey = (d: Date | string) => { const x = new Date(d); return `${x.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })} ${x.toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).slice(0, 2)}`; };

/** Lines over time. Points are joined in x order; x values shared across series are lined up. */
export function LineChart({ series, fmt, label, minZero = true }: { series: Series[]; fmt: (n: number) => string; label: string; minZero?: boolean }) {
  const seen = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))];
  const sortable = seen.every((x) => /^\d{4}-\d{2}-\d{2}/.test(x));
  const xs = sortable ? seen.sort() : seen;   // labels such as "Nov 26" keep the order they were given in
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length || !ys.length) return <p className="muted small">No values yet.</p>;
  const ymin = Math.min(...ys), ymax = Math.max(...ys), pad = (ymax - ymin) * 0.08 || Math.abs(ymax) * 0.05 || 1;
  const ax = niceAxis(minZero ? 0 : Math.max(0, ymin - pad), ymax + pad);
  const lo = ax.lo, hi = ax.hi;
  const X = (x: string) => PL + (xs.length === 1 ? (W - PL - PR) / 2 : (xs.indexOf(x) / (xs.length - 1)) * (W - PL - PR));
  const Y = (y: number) => PT + (1 - (y - lo) / (hi - lo || 1)) * (H - PT - PB);
  const ticks = ax.ticks;
  const step = Math.max(1, Math.ceil(xs.length / 6));
  const last = series.map((s) => ({ s, p: s.points[s.points.length - 1] })).filter((x) => x.p);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${last.map((x) => `${x.s.name}: ${fmt(x.p.y)} on ${shortDay(x.p.x)}`).join('; ')}`}>
        {ticks.map((t) => <g key={t}><line className="grid" x1={PL} x2={W - PR} y1={Y(t)} y2={Y(t)} /><text className="tick" x={PL - 8} y={Y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
        {xs.map((x, i) => (i % step === 0 || i === xs.length - 1) && <text key={x} className="tick" x={X(x)} y={H - 10} textAnchor="middle">{shortDay(x)}</text>)}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => xs.indexOf(a.x) - xs.indexOf(b.x));
          return (
            <g key={s.name} className={`ln ${s.tone ?? 'value'}`}>
              {pts.length > 1 && <polyline points={pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')} />}
              {pts.map((p) => <circle key={p.x} cx={X(p.x)} cy={Y(p.y)} r={pts.length > 40 ? 0 : 3}><title>{`${s.name}, ${shortDay(p.x)}: ${fmt(p.y)}`}</title></circle>)}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && <figcaption className="legend">{series.map((s) => <span key={s.name} className={`key ${s.tone ?? 'value'}`}>{s.name}</span>)}</figcaption>}
    </figure>
  );
}

/** Bars, one per label, optionally stacked by part. */
export function BarChart({ rows, fmt, label }: { rows: { x: string; parts: { name: string; y: number; tone?: string }[] }[]; fmt: (n: number) => string; label: string }) {
  if (!rows.length) return <p className="muted small">Nothing yet.</p>;
  const tot = rows.map((r) => r.parts.reduce((n, p) => n + p.y, 0));
  const ax = niceAxis(0, Math.max(...tot, 0) || 1);
  const hi = ax.hi;
  const bw = (W - PL - PR) / rows.length;
  const Y = (y: number) => PT + (1 - y / hi) * (H - PT - PB);
  const names = [...new Map(rows.flatMap((r) => r.parts.map((p) => [p.name, p.tone ?? 'value'] as const))).entries()];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${rows.map((r, i) => `${r.x}: ${fmt(tot[i])}`).join('; ')}`}>
        {ax.ticks.map((v) => <g key={v}><line className="grid" x1={PL} x2={W - PR} y1={Y(v)} y2={Y(v)} /><text className="tick" x={PL - 8} y={Y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        {rows.map((r, i) => {
          let base = 0;
          return (
            <g key={r.x}>
              {r.parts.map((p) => {
                const y0 = Y(base), y1 = Y(base + p.y); base += p.y;
                return <rect key={p.name} className={`bar ${p.tone ?? 'value'}`} x={PL + i * bw + bw * 0.18} width={bw * 0.64} y={y1} height={Math.max(0, y0 - y1)}><title>{`${r.x}, ${p.name}: ${fmt(p.y)}`}</title></rect>;
              })}
              <text className="tick" x={PL + i * bw + bw / 2} y={H - 10} textAnchor="middle">{r.x}</text>
            </g>
          );
        })}
      </svg>
      {names.length > 1 && <figcaption className="legend">{names.map(([n, t]) => <span key={n} className={`key ${t}`}>{n}</span>)}</figcaption>}
    </figure>
  );
}

/** Compact naira for axes and tiles: ₦950, ₦1.5k, ₦612k, ₦1.25m, ₦2.1bn (kobo in). */
export function nairaShort(kobo: number) {
  const n = kobo / 100, f = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-NG', { maximumFractionDigits: v < 10 ? 2 : 1 });
  return n >= 1e9 ? `₦${f(n / 1e9)}bn` : n >= 1e6 ? `₦${f(n / 1e6)}m` : n >= 1e3 ? `₦${f(n / 1e3)}k` : `₦${Math.round(n).toLocaleString('en-NG')}`;
}
