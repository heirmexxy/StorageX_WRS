// Public "Apply to partner" form. Anyone can apply; nobody gets access until Kitovu reviews the application.
// Approving creates the organisation (status: onboarding) and an invitation for the contact as its administrator,
// so the invitation-only, two-step sign-in rules still hold for every account.
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, createOrg, invite, rateLimit, type Actor } from './auth';
import { can, type OrgKind } from './rbac';
import { UserError } from './errors';
import { normPhone, clean } from './util';

export const APPLY_KINDS: Partial<Record<OrgKind, { label: string; adminRole: string; ask: string }>> = {
  lender: { label: 'Bank, microfinance bank or other lender', adminRole: 'lender_admin', ask: 'Licence type (e.g. MFB state, commercial bank) and the states you lend in' },
  warehouse_operator: { label: 'Warehouse owner or operator', adminRole: 'warehouse_manager', ask: 'Where your warehouse is, its capacity in tonnes and what you store' },
  field_partner_network: { label: 'Field agent network or extension service', adminRole: 'network_admin', ask: 'How many agents you have and which states and LGAs they cover' },
  cooperative: { label: 'Farmer co-operative or association', adminRole: 'coop_admin', ask: 'Registration number (if any), number of members and main crops' },
  buyer: { label: 'Commodity buyer or processor', adminRole: 'buyer_admin', ask: 'What you buy, typical volumes and where' },
  insurer: { label: 'Insurer or broker', adminRole: 'insurer_viewer', ask: 'NAICOM licence and the cover you offer for stored produce' },
  distribution_partner: { label: 'Trading platform or distribution partner', adminRole: 'partner_admin', ask: 'Your platform and how you would offer receipts to your users' },
};

export async function submitApplication(i: Record<string, string>, ip: string) {
  // Bots fill every field; people never see this one.
  if (i.website) return 'spam';
  if (!(await rateLimit(`apply:${ip}`, 5, 60 * 60))) throw new UserError('Too many applications from this network. Try again in an hour.');
  const kind = i.kind as OrgKind;
  if (!APPLY_KINDS[kind]) throw new UserError('Choose what kind of organisation you are.');
  const org = clean(i.org_name, 120), name = clean(i.contact_name, 120), email = clean(i.email, 160).toLowerCase();
  if (org.length < 3) throw new UserError('Enter your organisation’s name.');
  if (name.length < 3) throw new UserError('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new UserError('Enter a valid email address. We send the invitation there.');
  const phone = normPhone(i.phone);
  if (!phone) throw new UserError('Enter a phone number we can call (e.g. 08031234567).');
  const state = clean(i.state_code, 2).toUpperCase() || null;
  if (state && !(await db.val('SELECT 1 FROM states WHERE code=$1', state))) throw new UserError('Choose a state from the list.');
  if (i.agree !== '1') throw new UserError('Tick the box to let Kitovu contact you about this application.');
  if (await db.val(`SELECT 1 FROM partner_applications WHERE email=$1 AND status='new'`, email)) return 'duplicate';
  await db.run(`INSERT INTO partner_applications (org_name, kind, contact_name, email, phone_e164, state_code, details, message, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    org, kind, name, email, phone, state, { about: clean(i.about, 1000), role: clean(i.contact_role, 80) }, clean(i.message, 2000) || null, ip);
  await audit({ label: `public:${email}`, ip }, 'application.submitted', { data: { kind, org } });
  return 'ok';
}

export async function listApplications(a: Actor, status = 'new') {
  if (!can(a.membership, 'orgs.manage')) throw new UserError('Only Kitovu administrators review applications.');
  return db.all(`SELECT p.*, s.name AS state_name, u.full_name AS reviewed_by_name, o.code AS org_code FROM partner_applications p
    LEFT JOIN states s ON s.code=p.state_code LEFT JOIN users u ON u.id=p.reviewed_by LEFT JOIN organisations o ON o.id=p.org_id
    WHERE ($1 = 'all' OR p.status=$1) ORDER BY p.created_at DESC LIMIT 200`, ['new', 'approved', 'rejected', 'spam', 'all'].includes(status) ? status : 'new');
}

function codeFrom(name: string) {
  const w = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter((x) => x && !['LTD', 'LIMITED', 'PLC', 'NIGERIA', 'THE', 'OF', 'AND'].includes(x));
  return (w.length > 1 ? w.map((x) => x[0]).join('') : (w[0] || 'ORG')).slice(0, 12).padEnd(2, 'X');
}

export async function approveApplication(a: Actor, id: string, o: { code?: string; note?: string }) {
  if (!can(a.membership, 'orgs.manage')) throw new UserError('Only Kitovu administrators review applications.');
  const p = await db.get<{ id: string; status: string; org_name: string; kind: OrgKind; contact_name: string; email: string }>('SELECT * FROM partner_applications WHERE id=$1', id);
  if (!p || p.status !== 'new') throw new UserError('This application was already handled.');
  let code = clean(o.code, 20).toUpperCase() || codeFrom(p.org_name);
  if (!o.code) for (let n = 2; await db.val('SELECT 1 FROM organisations WHERE code=$1', code); n++) code = `${codeFrom(p.org_name).slice(0, 10)}${n}`;
  return tx(async () => {
    const orgId = await createOrg(a, { code, name: p.org_name, kind: p.kind });
    const inv = await invite({ ...a, membership: a.membership }, { email: p.email, fullName: p.contact_name, orgId, role: APPLY_KINDS[p.kind]!.adminRole });
    await db.run(`UPDATE partner_applications SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3, org_id=$4 WHERE id=$1`, id, a.user.id, clean(o.note, 500) || null, orgId);
    await audit(actorOf(a), 'application.approved', { orgId, entity: 'partner_application', entityId: id, data: { code } });
    return { code, link: inv.link };
  });
}

export async function rejectApplication(a: Actor, id: string, o: { note?: string; spam?: string }) {
  if (!can(a.membership, 'orgs.manage')) throw new UserError('Only Kitovu administrators review applications.');
  const status = o.spam === '1' ? 'spam' : 'rejected';
  if (status === 'rejected' && clean(o.note).length < 3) throw new UserError('Give a short reason (it helps if they apply again).');
  const n = await db.run(`UPDATE partner_applications SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1 AND status='new'`, id, status, a.user.id, clean(o.note, 500) || null);
  if (!n) throw new UserError('This application was already handled.');
  await audit(actorOf(a), `application.${status}`, { entity: 'partner_application', entityId: id });
}
