import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Ctx } from '../lib/http';
import { can, type Permission } from '../lib/rbac';

export const render = (el: ReactNode) => '<!doctype html>' + renderToString(el as any);

export function Csrf({ c }: { c: Ctx }) { return <input type="hidden" name="_csrf" value={c.csrf} />; }

const NAV: { href: string; label: string; perm?: Permission; kitovu?: boolean }[] = [
  { href: '/app', label: 'Home' },
  { href: '/farmers', label: 'Farmers', perm: 'farmers.view' },
  { href: '/kyc/review', label: 'ID checks', perm: 'kyc.review' },
  { href: '/review', label: 'Review queue', perm: 'farmers.edit', kitovu: true },
  { href: '/field-partners', label: 'Field partners', perm: 'field_partners.manage' },
  { href: '/intakes', label: 'Deliveries', perm: 'stock.manage' },
  { href: '/warehouses', label: 'Warehouses', perm: 'warehouses.view' },
  { href: '/admin/applications', label: 'Applications', perm: 'orgs.manage' },
  { href: '/admin/people', label: 'People', perm: 'users.manage' },
  { href: '/admin/orgs', label: 'Organisations', perm: 'orgs.manage' },
  { href: '/admin/audit', label: 'Audit log', perm: 'audit.view' },
  { href: '/admin/settings', label: 'Settings', perm: 'settings.manage' },
  { href: '/account', label: 'My account' },
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
          <a className="brand" href={s ? '/app' : '/login'}>StorageX <span>WRS</span></a>
          {s && (
            <nav>
              {NAV.filter((n) => (!n.perm || can(s.active, n.perm)) && (!n.kitovu || s.active?.org_kind === 'kitovu')).map((n) => (
                <a key={n.href} href={n.href} className={c.path === n.href || (n.href !== '/app' && c.path.startsWith(n.href + '/')) ? 'on' : ''}>{n.label}</a>
              ))}
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
