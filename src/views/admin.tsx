import type { Ctx } from '../lib/http';
import { Page, Csrf, Field, fmtDate } from './layout';
import { ROLES, permsOf, type OrgKind } from '../lib/rbac';
import type { Org } from '../lib/auth';

export function HomePage({ c, counts }: { c: Ctx; counts: Record<string, number> }) {
  const s = c.session!;
  const m = s.active;
  return (
    <Page c={c} title="Home">
      <h1>Welcome, {s.user.full_name.split(' ')[0]}</h1>
      {m ? (
        <p className="muted">Acting for <strong>{m.org_name}</strong> as {ROLES[m.org_kind]?.[m.role]?.label ?? m.role}.</p>
      ) : <p className="flash info">You are not a member of any active organisation yet. Ask your administrator.</p>}
      <div className="tiles">
        <div className="tile"><b>{counts.farmers ?? 0}</b><span>Farmers on record</span></div>
        <div className="tile"><b>{counts.warehouses ?? 0}</b><span>Warehouses</span></div>
        <div className="tile"><b>{counts.receipts ?? 0}</b><span>Receipts</span></div>
        <div className="tile"><b>{counts.orgs ?? 0}</b><span>Organisations</span></div>
      </div>
      {m && (
        <details>
          <summary>What your role can do</summary>
          <ul className="perms">{permsOf(m).map((p) => <li key={p} className="mono">{p}</li>)}</ul>
        </details>
      )}
    </Page>
  );
}

export function PeoplePage({ c, members, invites, orgs, link }: { c: Ctx; members: any[]; invites: any[]; orgs: Org[]; link?: string }) {
  const kitovu = c.membership?.org_kind === 'kitovu';
  return (
    <Page c={c} title="People">
      <h1>People</h1>
      {link && (
        <div className="flash ok">
          <p>Send this link to the person (by WhatsApp or email). It works once and expires in 72 hours:</p>
          <p className="mono copy">{link}</p>
        </div>
      )}
      <section className="card">
        <h2>Invite someone</h2>
        <form method="post" action="/admin/people/invite" className="grid">
          <Csrf c={c} />
          <Field label="Full name" name="full_name" required />
          <Field label="Email" name="email" type="email" required />
          <label className="field"><span>Organisation</span>
            <select name="org_id" required defaultValue={kitovu ? '' : c.membership?.org_id}>
              {kitovu && <option value="">Choose…</option>}
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind.replace(/_/g, ' ')})</option>)}
            </select>
          </label>
          <label className="field"><span>Role</span>
            <select name="role" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {Object.entries(ROLES).filter(([k]) => kitovu || k === c.membership?.org_kind).map(([kind, roles]) => (
                <optgroup key={kind} label={kind.replace(/_/g, ' ')}>
                  {Object.entries(roles).map(([r, d]) => <option key={kind + r} value={r}>{d.label}</option>)}
                </optgroup>
              ))}
            </select>
            <small>The role must match the organisation type.</small>
          </label>
          <button className="primary">Create invitation</button>
        </form>
      </section>

      <section className="card">
        <h2>Members</h2>
        <table>
          <thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Two-step</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.membership_id}>
                <td>{m.full_name}<br /><small className="muted">{m.email}{m.status !== 'active' ? ` · ${m.status}` : ''}</small></td>
                <td>{m.org_name}</td>
                <td>{ROLES[m.org_kind as OrgKind]?.[m.role]?.label ?? m.role}</td>
                <td>{m.totp_enabled ? 'App' : m.second_factor === 'sms' && m.sms_enrolled_at ? 'SMS' : 'Not set'}</td>
                <td>{fmtDate(m.last_login_at)}</td>
                <td className="actions">
                  {m.user_id !== c.user?.id && (
                    <>
                      <form method="post" action={`/admin/people/${m.membership_id}/remove`} className="inline"><Csrf c={c} /><button className="link danger">Remove</button></form>
                      <form method="post" action={`/admin/users/${m.user_id}/reset-password`} className="inline"><Csrf c={c} /><button className="link">Password link</button></form>
                      <form method="post" action={`/admin/users/${m.user_id}/reset-2fa`} className="inline"><Csrf c={c} /><button className="link">Reset two-step</button></form>
                      {kitovu && (
                        <form method="post" action={`/admin/users/${m.user_id}/${m.status === 'suspended' ? 'reactivate' : 'suspend'}`} className="inline"><Csrf c={c} /><button className="link danger">{m.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button></form>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {invites.length > 0 && (
        <section className="card">
          <h2>Open invitations</h2>
          <table>
            <thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Expires</th></tr></thead>
            <tbody>{invites.map((i) => <tr key={i.id}><td>{i.full_name}<br /><small className="muted">{i.email}</small></td><td>{i.org_name}</td><td>{i.role.replace(/_/g, ' ')}</td><td>{fmtDate(i.expires_at)}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </Page>
  );
}

export function OrgsPage({ c, orgs }: { c: Ctx; orgs: (Org & { members: number })[] }) {
  return (
    <Page c={c} title="Organisations">
      <h1>Organisations</h1>
      <section className="card">
        <h2>Add an organisation</h2>
        <form method="post" action="/admin/orgs" className="grid">
          <Csrf c={c} />
          <Field label="Name" name="name" required />
          <Field label="Short code" name="code" required hint="e.g. ACCION, FARMLINK" />
          <label className="field"><span>Type</span>
            <select name="kind" required>
              {Object.keys(ROLES).filter((k) => k !== 'kitovu' && k !== 'other').map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <button className="primary">Add</button>
        </form>
      </section>
      <section className="card">
        <table>
          <thead><tr><th>Name</th><th>Code</th><th>Type</th><th>Status</th><th>Members</th><th></th></tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td><td className="mono">{o.code}</td><td>{o.kind.replace(/_/g, ' ')}</td><td>{o.status}</td><td>{o.members}</td>
                <td className="actions">
                  {o.kind !== 'kitovu' && (['active', 'suspended'] as const).filter((s) => s !== o.status).map((s) => (
                    <form key={s} method="post" action={`/admin/orgs/${o.id}/status`} className="inline"><Csrf c={c} /><input type="hidden" name="status" value={s} /><button className={`link ${s === 'suspended' ? 'danger' : ''}`}>{s === 'active' ? 'Activate' : 'Suspend'}</button></form>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Page>
  );
}

export function AuditPage({ c, rows, chainBrokenAt, q }: { c: Ctx; rows: any[]; chainBrokenAt: string | null; q: Record<string, string> }) {
  return (
    <Page c={c} title="Audit log">
      <h1>Audit log</h1>
      {c.membership?.org_kind === 'kitovu' && (chainBrokenAt
        ? <p className="flash error">Integrity check failed at entry {chainBrokenAt}. Someone has altered the log. Escalate now.</p>
        : <p className="flash ok">Integrity check passed: no entry has been changed or removed.</p>)}
      <form method="get" className="filters">
        <input name="action" placeholder="Action, e.g. auth.login" defaultValue={q.action} />
        <input name="who" placeholder="Email" defaultValue={q.who} />
        <button>Filter</button>
      </form>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtDate(r.at)}</td><td>{r.actor_label.replace(/^user:/, '')}<br /><small className="muted">{r.ip}</small></td>
              <td className="mono">{r.action}</td><td>{r.entity ? `${r.entity}` : ''}</td>
              <td className="mono small">{JSON.stringify(r.data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

export function AccountPage({ c }: { c: Ctx }) {
  const u = c.session!.user;
  return (
    <Page c={c} title="My account">
      <h1>My account</h1>
      <section className="card">
        <p>{u.full_name} · {u.email}</p>
        <p>Two-step sign-in: <strong>{u.factor === 'totp' ? 'authenticator app' : u.factor === 'sms' ? `text-message codes to ${u.phone_e164}` : 'not set up'}</strong></p>
        <h2>Organisations</h2>
        <ul>{c.session!.memberships.map((m) => <li key={m.org_id}>{m.org_name}: {ROLES[m.org_kind]?.[m.role]?.label ?? m.role}</li>)}</ul>
      </section>
      <section className="card">
        <h2>Change password</h2>
        <form method="post" action="/account/password" className="grid">
          <Csrf c={c} />
          <Field label="Current password" name="current" type="password" required autoComplete="current-password" />
          <Field label="New password" name="next" type="password" required autoComplete="new-password" hint="At least 12 characters." />
          <button className="primary">Change</button>
        </form>
      </section>
    </Page>
  );
}
