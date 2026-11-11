import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Ctx } from '../lib/http';
import { can, type Permission } from '../lib/rbac';

export const render = (el: ReactNode) => '<!doctype html>' + renderToString(el as any);

export function Csrf({ c }: { c: Ctx }) { return <input type="hidden" name="_csrf" value={c.csrf} />; }

type NavItem = { href: string; label: string; perm?: Permission; kitovu?: boolean };
// Grouped so the menu stays on one line; a group with one item for this person shows as a plain link.
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Home', items: [{ href: '/app', label: 'Home' }] },
  { group: 'Farmers', items: [
    { href: '/farmers', label: 'Farmers', perm: 'farmers.view' },
    { href: '/kyc/review', label: 'ID checks', perm: 'kyc.review' },
    { href: '/field-partners', label: 'Field partners', perm: 'field_partners.manage' },
    { href: '/admin/messages', label: 'Farmer messages', perm: 'farmers.edit', kitovu: true },
  ] },
  { group: 'Stock', items: [
    { href: '/intakes', label: 'Deliveries', perm: 'stock.manage' },
    { href: '/intakes?status=held', label: 'Held deliveries', perm: 'kyc.review', kitovu: true },
    { href: '/receipts', label: 'Receipts', perm: 'receipts.view' },
    { href: '/stock', label: 'Stock', perm: 'stock.manage' },
    { href: '/warehouses', label: 'Warehouses', perm: 'warehouses.view' },
  ] },
  { group: 'Finance', items: [
    { href: '/tower', label: 'Control tower', perm: 'finance.view' },
    { href: '/loans', label: 'Loans', perm: 'finance.view' },
    { href: '/prices', label: 'Prices', perm: 'finance.view' },
    { href: '/sales', label: 'Sales', perm: 'receipts.issue', kitovu: true },
  ] },
  { group: 'Admin', items: [
    { href: '/review', label: 'Review queue', perm: 'farmers.edit', kitovu: true },
    { href: '/admin/applications', label: 'Applications', perm: 'orgs.manage' },
    { href: '/admin/people', label: 'People', perm: 'users.manage' },
    { href: '/admin/orgs', label: 'Organisations', perm: 'orgs.manage' },
    { href: '/admin/audit', label: 'Audit log', perm: 'audit.view' },
    { href: '/admin/settings', label: 'Settings', perm: 'settings.manage' },
  ] },
  { group: 'My account', items: [{ href: '/account', label: 'My account' }] },
];

export function Page({ c, title, children, bare, wide }: { c: Ctx; title: string; children: ReactNode; bare?: boolean; wide?: boolean }) {
  const s = c.session && c.session.twofaOk ? c.session : null;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · StorageX`}</title>
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body className={[bare && 'bare', wide && 'wide'].filter(Boolean).join(' ')}>
        <header className="top">
          <a className="brand" href={s ? '/app' : '/'}>StorageX <span>WRS</span></a>
          {s && (
            <nav>
              {NAV.map(({ group, items }) => {
                const mine = items.filter((n) => (!n.perm || can(s.active, n.perm)) && (!n.kitovu || s.active?.org_kind === 'kitovu'));
                const on = (n: NavItem) => c.path === n.href.split('?')[0] || (n.href !== '/app' && c.path.startsWith(n.href.split('?')[0] + '/'));
                if (!mine.length) return null;
                if (mine.length === 1) return <a key={group} href={mine[0].href} className={on(mine[0]) ? 'on' : ''}>{mine[0].label}</a>;
                return (
                  <details key={group} className={`menu${mine.some(on) ? ' on' : ''}`}>
                    <summary>{group}</summary>
                    <div>{mine.map((n) => <a key={n.href} href={n.href} className={on(n) ? 'on' : ''}>{n.label}</a>)}</div>
                  </details>
                );
              })}
            </nav>
          )}
          {s && (
            <div className="who">
              {s.memberships.length > 1 ? (
                <form method="post" action="/app/switch-org" className="inline">
                  <Csrf c={c} />
                  <select name="org_id" defaultValue={s.active?.org_id} aria-label="Acting for">
                    {s.memberships.map((m) => <option key={m.org_id} value={m.org_id}>{m.org_name}</option>)}
                  </select>
                  <button className="link">Switch</button>
                </form>
              ) : <span className="org">{s.active?.org_name ?? 'No organisation'}</span>}
              <form method="post" action="/logout" className="inline"><Csrf c={c} /><button className="link">Sign out</button></form>
            </div>
          )}
        </header>
        <main>
          {c.flash && <p className={`flash ${c.flash.type}`} role="status">{c.flash.msg}</p>}
          {children}
        </main>
      </body>
    </html>
  );
}

export function Field({ label, name, type = 'text', value, required, autoComplete, hint, inputMode, pattern, accept, capture, step }: {
  label: string; name: string; type?: string; value?: string | number | null; required?: boolean; autoComplete?: string; hint?: string; inputMode?: 'numeric' | 'text' | 'email' | 'decimal' | 'tel';
  pattern?: string; accept?: string; capture?: 'user' | 'environment'; step?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} defaultValue={value ?? undefined} required={required} autoComplete={autoComplete} inputMode={inputMode} pattern={pattern} accept={accept} capture={capture} step={step} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export const fmtDate = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function Select({ label, name, value, options, required, hint, blank }: { label: string; name: string; value?: string | null; options: [string, string][]; required?: boolean; hint?: string; blank?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value ?? ''} required={required}>
        {blank !== undefined && <option value="">{blank}</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export const fmtDay = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** "Showing 101–200 of 4,312" with previous/next links that keep the current filters. */
export function Pager({ c, rows, size = 100 }: { c: Ctx; rows: { total_rows?: number }[]; size?: number }) {
  const total = rows[0]?.total_rows ?? 0;
  if (total <= size) return null;
  const page = Math.max(0, Math.floor(Number(c.query.page) || 0));
  const link = (p: number) => { const u = new URLSearchParams(c.query as Record<string, string>); if (p) u.set('page', String(p)); else u.delete('page'); const qs = u.toString(); return c.path + (qs ? `?${qs}` : ''); };
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted">{`Showing ${(page * size + 1).toLocaleString('en-NG')}–${Math.min(total, (page + 1) * size).toLocaleString('en-NG')} of ${total.toLocaleString('en-NG')}`}</span>
      {page > 0 && <a className="button" href={link(page - 1)}>Previous</a>}
      {(page + 1) * size < total && <a className="button" href={link(page + 1)}>Next</a>}
    </nav>
  );
}
