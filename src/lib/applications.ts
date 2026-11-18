// Public "Apply to partner" form. Anyone can apply; nobody gets access until Kitovu reviews the application.
// Approving creates the organisation (status: onboarding) and an invitation for the contact as its administrator,
// so the invitation-only, two-step sign-in rules still hold for every account.
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, createOrg, invite, rateLimit, type Actor } from './auth';
import { can, type OrgKind } from './rbac';
import { UserError } from './errors';
import { normPhone, clean } from './util';

export type PartnerGroup = 'finance' | 'storage' | 'markets' | 'public';
/** Partner types are shown in these groups, so people find theirs without reading the whole list. */
export const PARTNER_GROUPS: { key: PartnerGroup; label: string; line: string }[] = [
  { key: 'finance', label: 'Financial institutions', line: 'Lenders, insurers, and banks, fintechs and telcos that move the money.' },
  { key: 'storage', label: 'Storage and field operations', line: 'Warehouses, inspectors, field agent networks and co-operatives.' },
  { key: 'markets', label: 'Markets and supply chain', line: 'Buyers, trading platforms, input suppliers and transporters.' },
  { key: 'public', label: 'Development and government', line: 'Development partners, guarantee funds and public agencies.' },
];
export interface PartnerType { label: string; group: PartnerGroup; kind: OrgKind; adminRole?: string; gives: string; gets: string; ask: string; pitch: string; cta: string }

/** Who can partner with StorageX. `kind` is the account type created on approval; 'other' partners are handled
 *  by the partnerships team without an account until their integration is ready. */
export const PARTNER_TYPES: Record<string, PartnerType> = {
  lender: { label: 'Lender', group: 'finance', pitch: 'Lend against stock you can see, value every day and claim first when it is sold.', cta: 'Partner as a lender', kind: 'lender', adminRole: 'lender_admin',
    gives: 'Loans to farmers against their stored produce.', gets: 'Verified borrowers and receipts you can check every day. A pledged receipt backs only your loan, and you are paid first when the stock is sold.', ask: 'Licence type (e.g. state MFB, commercial bank) and the states you lend in' },
  buyer: { label: 'Buyer or processor', group: 'markets', pitch: 'Buy graded, weighed stock from certified warehouses in the lots you need.', cta: 'Partner as a buyer', kind: 'buyer', adminRole: 'buyer_admin',
    gives: 'Offers for graded stock and payment through Kitovu.', gets: 'Graded, weighed produce in certified warehouses, bought in larger lots.', ask: 'What you buy, typical volumes and where you take delivery' },
  distribution_partner: { label: 'Trading platform', group: 'markets', pitch: 'Offer eligible receipts to your users through the StorageX API.', cta: 'Partner as a platform', kind: 'distribution_partner', adminRole: 'partner_admin',
    gives: 'Your users, who can buy or fund receipts through your platform.', gets: 'Access to eligible receipts through the StorageX API.', ask: 'Your platform, your users and how you would offer receipts to them' },
  insurer: { label: 'Insurer or broker', group: 'finance', pitch: 'Cover stored produce at sites with counts, photos, sensors and records behind every bag.', cta: 'Partner as an insurer', kind: 'insurer', adminRole: 'insurer_viewer',
    gives: 'Cover for stored produce and warehouses.', gets: 'Sites with counts, photos and stock records that support underwriting and claims.', ask: 'NAICOM licence and the cover you offer for stored produce' },
  warehouse_operator: { label: 'Warehouse owner or operator', group: 'storage', pitch: 'Get your store certified, fill it with depositors, and earn storage fees on stock lenders accept.', cta: 'Partner as a warehouse owner', kind: 'warehouse_operator', adminRole: 'warehouse_manager',
    gives: 'Storage space, staff and site security.', gets: 'Depositors, storage fees and receipts lenders accept, once your site is certified.', ask: 'Where your warehouse is, its capacity in tonnes and what you store' },
  field_partner_network: { label: 'Field agent network or extension service', group: 'storage', pitch: 'Your agents register and support farmers, and connect them to storage, loans and buyers.', cta: 'Partner as a network', kind: 'field_partner_network', adminRole: 'network_admin',
    gives: 'Agents who register and support farmers in their communities.', gets: 'A way to connect your farmers to storage, loans and buyers, and fees for the work.', ask: 'How many agents you have and which states and LGAs they cover' },
  cooperative: { label: 'Farmer co-operative or association', group: 'storage', pitch: 'Store together, sell together in larger lots, and give members access to credit.', cta: 'Partner as a co-operative', kind: 'cooperative', adminRole: 'coop_admin',
    gives: 'Members who store and sell together.', gets: 'Receipts for members’ produce, group sales and access to credit.', ask: 'Registration number (if any), number of members and main crops' },
  input_supplier: { label: 'Input supplier or agro-dealer', group: 'markets', pitch: 'Sell next season’s inputs to farmers who can pay from their stored produce.', cta: 'Partner as a supplier', kind: 'other',
    gives: 'Seed, fertiliser and crop protection for the next season.', gets: 'Farmers who can pay for inputs from their stored produce or a receipt-backed loan.', ask: 'What inputs you sell and where your outlets are' },
  logistics: { label: 'Transport and logistics', group: 'markets', pitch: 'Carry planned loads at known weights between farms, warehouses and buyers.', cta: 'Partner as a transporter', kind: 'other',
    gives: 'Trucks to move produce from farm to warehouse and warehouse to buyer.', gets: 'Planned loads at known weights and pickup points.', ask: 'Fleet size, routes and the states you cover' },
  inspection: { label: 'Quality inspector or collateral manager', group: 'storage', pitch: 'Grade, inspect and monitor stock across certified warehouses.', cta: 'Partner as an inspector', kind: 'other',
    gives: 'Independent grading, inspection or collateral management.', gets: 'Paid inspection work across certified warehouses.', ask: 'Accreditations, the crops you grade and where you work' },
  payments: { label: 'Bank, fintech or telco (payments)', group: 'finance', pitch: 'Handle buyer collections and farmer payouts, including mobile money.', cta: 'Partner on payments', kind: 'other',
    gives: 'Collections from buyers and payouts to farmers, including mobile money.', gets: 'Regular payment volume from sales and loans.', ask: 'The payment services you offer and how they connect' },
  development: { label: 'Development partner, donor or guarantee fund', group: 'public', pitch: 'Back farmers with funding or guarantees, and see the results in the data.', cta: 'Partner on a programme', kind: 'other',
    gives: 'Funding, credit guarantees or technical support.', gets: 'Measurable reach: farmers storing, borrowing and selling better, with data to show it.', ask: 'Your programme, the crops and regions it covers, and the support you provide' },
  government: { label: 'Government or public agency', group: 'public', pitch: 'Bring a working receipt system to your state’s farmers and public warehouses.', cta: 'Partner as an agency', kind: 'other',
    gives: 'Policy support, public warehouses or programme reach.', gets: 'A working receipt system for your farmers, with reports you can rely on.', ask: 'Your agency, the programme and the states involved' },
};
/** Kept for the admin page: the account types with a first administrator role. */
export const APPLY_KINDS: Partial<Record<OrgKind, { label: string; adminRole: string; ask: string }>> = Object.fromEntries(
  Object.entries(PARTNER_TYPES).filter(([, t]) => t.adminRole).map(([k, t]) => [k, { label: t.label, adminRole: t.adminRole!, ask: t.ask }]));

export async function submitApplication(i: Record<string, string>, ip: string) {
  // Bots fill every field; people never see this one.
  if (i.website) return 'spam';
  if (!(await rateLimit(`apply:${ip}`, 5, 60 * 60))) throw new UserError('Too many applications from this network. Try again in an hour.');
  const type = PARTNER_TYPES[String(i.type ?? i.kind)];
  if (!type) throw new UserError('Choose how you would like to partner with us.');
  const kind = type.kind;
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
  await db.run(`INSERT INTO partner_applications (org_name, kind, partner_type, contact_name, email, phone_e164, state_code, details, message, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    org, kind, String(i.type ?? i.kind), name, email, phone, state, { about: clean(i.about, 1000), role: clean(i.contact_role, 80) }, clean(i.message, 2000) || null, ip);
  await audit({ label: `public:${email}`, ip }, 'application.submitted', { data: { type: String(i.type ?? i.kind), org } });
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
  const p = await db.get<{ id: string; status: string; org_name: string; kind: OrgKind; partner_type: string; contact_name: string; email: string }>('SELECT * FROM partner_applications WHERE id=$1', id);
  if (!p || p.status !== 'new') throw new UserError('This application was already handled.');
  const type = PARTNER_TYPES[p.partner_type];
  if (!type?.adminRole) {
    // No account type yet (e.g. transporters, donors): approve for the partnerships team to follow up.
    await db.run(`UPDATE partner_applications SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1`, id, a.user.id, clean(o.note, 500) || 'Partnership to be agreed offline');
    await audit(actorOf(a), 'application.approved', { entity: 'partner_application', entityId: id, data: { type: p.partner_type, account: false } });
    return { code: null as string | null, link: null as string | null };
  }
  let code = clean(o.code, 20).toUpperCase() || codeFrom(p.org_name);
  if (!o.code) for (let n = 2; await db.val('SELECT 1 FROM organisations WHERE code=$1', code); n++) code = `${codeFrom(p.org_name).slice(0, 10)}${n}`;
  return tx(async () => {
    const orgId = await createOrg(a, { code, name: p.org_name, kind: p.kind });
    const inv = await invite({ ...a, membership: a.membership }, { email: p.email, fullName: p.contact_name, orgId, role: type.adminRole });
    await db.run(`UPDATE partner_applications SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3, org_id=$4 WHERE id=$1`, id, a.user.id, clean(o.note, 500) || null, orgId);
    await audit(actorOf(a), 'application.approved', { orgId, entity: 'partner_application', entityId: id, data: { code } });
    return { code: code as string | null, link: inv.link as string | null };
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
