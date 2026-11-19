// Receipt issuers: companies other than Kitovu that issue StorageX receipts to their own farmers, at warehouses
// they own, lease, or share with Kitovu. The rules are enforced here, not in a contract:
//   - Kitovu certifies an issuer only when it is ready (a warehouse, insurance, WareGuard, a guarantee, two people);
//   - every receipt is checked against the same gates at the moment of issue, so a lapsed policy, a silent
//     WareGuard or an under-sized guarantee stops issuing at once;
//   - lenders choose which issuers' receipts they lend against, and may cap the loan-to-value for each;
//   - Kitovu can suspend an issuer with one switch. Receipts already issued stay valid; lenders are told.
import { db, tx } from './db';
import { audit } from './audit';
import { actorOf, type Actor } from './auth';
import { can } from './rbac';
import { UserError } from './errors';
import { getSettings } from './settings';
import { clean } from './util';
import { toKobo, fmtNGN } from './money';
const naira = (v: string, label: string) => { try { const k = toKobo(v); if (k < 0) throw 0; return k; } catch { throw new UserError(`${label}: enter an amount in naira, e.g. 500000.`); } };
import { LIVE, reconcile } from './stock';
import { referencePrice } from './valuation';
import { raise } from './alerts';

const kitovuAdmin = (a: Actor) => {
  if (a.membership?.org_kind !== 'kitovu' || !(can(a.membership, 'orgs.manage') || can(a.membership, 'kyc.review'))) throw new UserError('Only Kitovu administrators or compliance manage issuers.');
};
const N = (k: number) => fmtNGN(Math.round(k), { decimals: false });

export async function issuerByCode(code: string) {
  return db.get<any>(`SELECT o.id, o.code, o.name, o.status AS org_status, p.* , p.guarantee_kobo::float AS guarantee FROM organisations o LEFT JOIN issuer_profiles p ON p.org_id=o.id
    WHERE o.code=upper($1) AND o.kind='issuer'`, clean(code, 20));
}
async function profile(orgId: string) {
  await db.run(`INSERT INTO issuer_profiles (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, orgId);
  return (await db.get<any>('SELECT *, guarantee_kobo::float AS guarantee FROM issuer_profiles WHERE org_id=$1', orgId))!;
}

/** Value of the issuer's live receipts at today's prices (falls back to the value at storage). */
export async function liveValue(orgId: string) {
  const rs = await db.all<any>(`SELECT r.commodity_code, w.state_code, sum(b.remaining_kg)::float AS kg, sum(COALESCE(r.issue_value_kobo,0))::float AS at_storage FROM receipts r
    JOIN receipt_balances b ON b.receipt_id=r.id JOIN warehouses w ON w.id=r.warehouse_id WHERE r.issuer_org_id=$1 AND r.status::text = ANY($2) AND b.remaining_kg > 0 GROUP BY 1,2`, orgId, LIVE);
  let v = 0;
  for (const r of rs) { const p = (await referencePrice(r.commodity_code, r.state_code)).kobo_per_kg; v += p ? r.kg * p : r.at_storage; }
  return v;
}
async function guaranteeNeeded(orgId: string, extra = 0) {
  const s = await getSettings();
  return Math.max(s['issuers.guarantee_min_kobo'], Math.round(((await liveValue(orgId)) + extra) * s['issuers.guarantee_pct'] / 100));
}

export async function links(orgId: string) {
  return db.all<any>(`SELECT iw.*, w.code AS wh_code, w.name AS wh_name, w.status AS wh_status, s.name AS state,
      (SELECT 1 FROM insurance_policies ip WHERE ip.warehouse_id=w.id AND ip.status='active' AND ip.cover_to >= current_date LIMIT 1) IS NOT NULL AS insured,
      (SELECT count(*)::int FROM sensor_devices d WHERE d.warehouse_id=w.id AND d.active) AS devices,
      (SELECT count(*)::int FROM sensor_devices d WHERE d.warehouse_id=w.id AND d.active AND d.last_seen_at > now() - make_interval(mins => $2::int)) AS reporting
    FROM issuer_warehouses iw JOIN warehouses w ON w.id=iw.warehouse_id JOIN states s ON s.code=w.state_code WHERE iw.issuer_org_id=$1 ORDER BY iw.status, w.name`, orgId, (await getSettings())['wareguard.offline_minutes']);
}

/** What stands between an issuer and issuing at one warehouse (or anywhere, without a warehouse). Empty = ready. */
export async function blockers(orgId: string, warehouseId?: string, extraValue = 0) {
  const s = await getSettings();
  const p = await profile(orgId);
  const out: string[] = [];
  if (p.status === 'suspended') out.push(`Suspended by Kitovu: ${p.suspend_reason ?? 'no reason given'}.`);
  const ls = (await links(orgId)).filter((l) => l.status === 'active' && (!warehouseId || l.warehouse_id === warehouseId));
  if (!ls.length) out.push(warehouseId ? 'This warehouse is not linked to the issuer.' : 'No warehouse is linked yet (owned, leased or bays in a Kitovu warehouse).');
  const waived = p.wareguard_waiver_until && new Date(p.wareguard_waiver_until) >= new Date(new Date().toDateString());
  for (const l of ls) {
    if (!['certified', 'active'].includes(l.wh_status)) out.push(`${l.wh_name} is not a certified warehouse.`);
    if (!l.insured) out.push(`${l.wh_name} has no current insurance policy.`);
    if (s['issuers.require_wareguard'] && !waived && !l.reporting) out.push(l.devices ? `WareGuard at ${l.wh_name} is not reporting.` : `WareGuard is not installed at ${l.wh_name}.`);
  }
  const need = await guaranteeNeeded(orgId, extraValue);
  if (p.guarantee < need) out.push(`Guarantee of ${N(p.guarantee)} is below the ${N(need)} required.`);
  const people = await db.all<{ role: string }>(`SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.status='active' AND u.status='active'`, orgId);
  if (people.filter((x) => x.role !== 'issuer_clerk').length < 1 || people.length < 2) out.push('At least two people are needed: one to record deliveries and another to review them and issue.');
  return out;
}

/** Checked inside issueFromIntake for every receipt an issuer issues. */
export async function assertCanIssue(orgId: string, warehouseId: string, valueKobo: number) {
  const p = await profile(orgId);
  if (p.status !== 'certified') throw new UserError(p.status === 'suspended' ? `Issuing is suspended: ${p.suspend_reason ?? 'ask Kitovu'}.` : 'Your company is not certified to issue receipts yet.');
  const b = await blockers(orgId, warehouseId, valueKobo);
  if (b.length) throw new UserError(`Receipt not issued: ${b.join(' ')}`);
}

// ---------- Kitovu actions ----------
export async function linkWarehouse(a: Actor, issuerCode: string, i: { warehouse?: string; basis?: string; detail?: string; starts_on?: string; ends_on?: string }) {
  kitovuAdmin(a);
  const iss = await issuerByCode(issuerCode);
  if (!iss) throw new UserError('Issuer not found.');
  const w = await db.get<{ id: string; code: string }>('SELECT id, code FROM warehouses WHERE code=upper($1)', clean(i.warehouse, 20));
  if (!w) throw new UserError('Warehouse not found.');
  const basis = String(i.basis);
  if (!['own', 'lease', 'kitovu_bays'].includes(basis)) throw new UserError('Choose how the issuer uses this warehouse.');
  if (basis !== 'own' && clean(i.detail, 200).length < 3) throw new UserError(basis === 'lease' ? 'Give the lease reference and its end date.' : 'Say which bays the issuer uses.');
  await profile(iss.id);
  await db.run(`INSERT INTO issuer_warehouses (issuer_org_id, warehouse_id, basis, detail, starts_on, ends_on, added_by) VALUES ($1,$2,$3,$4,COALESCE($5::date,current_date),$6::date,$7)
    ON CONFLICT (issuer_org_id, warehouse_id) DO UPDATE SET basis=EXCLUDED.basis, detail=EXCLUDED.detail, starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on, status='active'`,
    iss.id, w.id, basis, clean(i.detail, 200) || null, i.starts_on || null, i.ends_on || null, a.user.id);
  await audit(actorOf(a), 'issuer.warehouse_linked', { orgId: iss.id, data: { warehouse: w.code, basis } });
}
export async function endLink(a: Actor, issuerCode: string, whCode: string) {
  kitovuAdmin(a);
  const iss = (await issuerByCode(issuerCode))!;
  const n = await db.run(`UPDATE issuer_warehouses SET status='ended', ends_on=LEAST(COALESCE(ends_on,current_date), current_date) WHERE issuer_org_id=$1 AND warehouse_id=(SELECT id FROM warehouses WHERE code=upper($2))`, iss.id, clean(whCode, 20));
  if (!n) throw new UserError('No such link.');
  await audit(actorOf(a), 'issuer.warehouse_unlinked', { orgId: iss.id, data: { warehouse: whCode } });
}
export async function setGuarantee(a: Actor, issuerCode: string, i: { amount?: string; reference?: string }) {
  kitovuAdmin(a);
  const iss = await issuerByCode(issuerCode);
  if (!iss) throw new UserError('Issuer not found.');
  const amount = naira(i.amount ?? '0', 'Guarantee');
  const ref = clean(i.reference, 120);
  if (ref.length < 3) throw new UserError('Give the reference: the deposit transfer, bond or bank guarantee number.');
  await profile(iss.id);
  await db.run('UPDATE issuer_profiles SET guarantee_kobo=$2, guarantee_ref=$3 WHERE org_id=$1', iss.id, amount, ref);
  await audit(actorOf(a), 'issuer.guarantee_set', { orgId: iss.id, data: { kobo: amount, ref } });
}
export async function setWaiver(a: Actor, issuerCode: string, i: { until?: string; reason?: string }) {
  kitovuAdmin(a);
  const iss = (await issuerByCode(issuerCode))!;
  const until = i.until ? String(i.until) : null;
  if (until) {
    const d = new Date(until + 'T12:00:00Z');
    if (isNaN(d.getTime()) || d.getTime() > Date.now() + 92 * 86_400_000) throw new UserError('A WareGuard waiver can last at most three months.');
    if (clean(i.reason, 300).length < 5) throw new UserError('Say why WareGuard is waived (e.g. devices ordered, installation date).');
  }
  await profile(iss.id);
  await db.run('UPDATE issuer_profiles SET wareguard_waiver_until=$2, waiver_reason=$3 WHERE org_id=$1', iss.id, until, until ? clean(i.reason, 300) : null);
  await audit(actorOf(a), until ? 'issuer.wareguard_waived' : 'issuer.wareguard_waiver_ended', { orgId: iss.id, data: { until, reason: i.reason ?? null } });
}
export async function setTier(a: Actor, issuerCode: string, tier: string) {
  kitovuAdmin(a);
  if (!['A', 'B', 'C', 'D'].includes(tier)) throw new UserError('Choose a tier from A to D.');
  const iss = (await issuerByCode(issuerCode))!;
  await profile(iss.id);
  await db.run('UPDATE issuer_profiles SET tier=$2 WHERE org_id=$1', iss.id, tier);
  await audit(actorOf(a), 'issuer.tier_set', { orgId: iss.id, data: { tier } });
}

export async function certify(a: Actor, issuerCode: string) {
  kitovuAdmin(a);
  const iss = await issuerByCode(issuerCode);
  if (!iss) throw new UserError('Issuer not found.');
  const b = (await blockers(iss.id)).filter((x) => !x.startsWith('Suspended'));   // certifying again lifts a suspension
  if (b.length) throw new UserError(`Not ready to certify: ${b.join(' ')}`);
  const s = await getSettings();
  await tx(async () => {
    await db.run(`UPDATE issuer_profiles SET status='certified', certified_by=$2, certified_at=now(), suspended_by=NULL, suspended_at=NULL, suspend_reason=NULL WHERE org_id=$1`, iss.id, a.user.id);
    await db.run(`UPDATE organisations SET status='active' WHERE id=$1 AND status <> 'active'`, iss.id);
    if (s['fees.certification_kobo'] > 0) await charge(iss.id, 'certification', s['fees.certification_kobo'], `CERT-${iss.code}-${new Date().getFullYear()}`, { year: new Date().getFullYear() }, a.user.id);
    await audit(actorOf(a), 'issuer.certified', { orgId: iss.id, data: { code: iss.code } });
  });
}
export async function suspend(a: Actor, issuerCode: string, reason: string) {
  kitovuAdmin(a);
  const iss = await issuerByCode(issuerCode);
  if (!iss) throw new UserError('Issuer not found.');
  const r = clean(reason, 300);
  if (r.length < 5) throw new UserError('Give the reason: the issuer and its lenders will see it.');
  await profile(iss.id);
  await db.run(`UPDATE issuer_profiles SET status='suspended', suspended_by=$2, suspended_at=now(), suspend_reason=$3 WHERE org_id=$1`, iss.id, a.user.id, r);
  await audit(actorOf(a), 'issuer.suspended', { orgId: iss.id, data: { reason: r } });
  // Every lender holding this issuer's receipts is told. Their receipts stay valid; no new ones can be issued.
  const lenders = await db.all<{ lender_org_id: string }>(`SELECT DISTINCT li.lender_org_id FROM liens li JOIN receipts r ON r.id=li.receipt_id WHERE r.issuer_org_id=$1 AND li.released_at IS NULL`, iss.id);
  for (const l of lenders) await raise(l.lender_org_id, { kind: 'warehouse_condition', level: 'urgent', title: `${iss.name} is suspended as a receipt issuer`, link: `/issuers/${iss.code}`,
    body: `Reason: ${r}. Receipts it already issued, including those pledged to you, stay valid and in the warehouse; it cannot issue new ones. Kitovu will count its stock.`, key: `susp:${iss.code}:${Date.now()}` });
}

// ---------- platform charges ----------
export async function charge(orgId: string, kind: 'issuance' | 'origination' | 'certification' | 'wareguard' | 'other', kobo: number, ref: string, basis: Record<string, unknown>, by: string | null) {
  if (kobo <= 0) return;
  await db.run(`INSERT INTO platform_charges (org_id, kind, amount_kobo, ref, basis, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, ref) DO NOTHING`, orgId, kind, Math.round(kobo), ref, JSON.stringify(basis), by);
}
export async function chargesList(a: Actor, q: { status?: string } = {}) {
  const kit = a.membership?.org_kind === 'kitovu';
  if (!kit && !can(a.membership, 'users.manage')) throw new UserError('Not allowed.');
  return db.all<any>(`SELECT c.*, c.amount_kobo::float AS amount, o.name AS org_name, o.code AS org_code FROM platform_charges c JOIN organisations o ON o.id=c.org_id
    WHERE ($1::uuid IS NULL OR c.org_id=$1) AND ($2 = '' OR c.status=$2) ORDER BY c.created_at DESC LIMIT 300`, kit ? null : a.membership!.org_id, ['due', 'paid', 'waived'].includes(String(q.status)) ? q.status : '');
}
export async function settleCharge(a: Actor, id: string, status: 'paid' | 'waived', note: string) {
  if (a.membership?.org_kind !== 'kitovu' || !can(a.membership, 'finance.approve')) throw new UserError('Only Kitovu finance marks platform fees paid or waived.');
  if (clean(note, 200).length < 3) throw new UserError(status === 'paid' ? 'Give the payment reference.' : 'Say why it is waived.');
  const n = await db.run(`UPDATE platform_charges SET status=$2, note=$3, settled_by=$4, settled_at=now() WHERE id=$1 AND status='due'`, id, status, clean(note, 200), a.user.id);
  if (!n) throw new UserError('Already settled.');
  await audit(actorOf(a), `charge.${status}`, { entity: 'platform_charge', entityId: id, data: { note } });
}

// ---------- scorecard: what lenders see before accepting an issuer ----------
export async function scorecard(orgId: string) {
  const p = await profile(orgId);
  const r = (await db.get<any>(`SELECT count(*)::int AS receipts, COALESCE(sum(net_weight_kg),0)::float AS kg, COALESCE(sum(issue_value_kobo),0)::float AS value_at_storage,
      count(*) FILTER (WHERE status::text = ANY($2))::int AS live, min(issued_at) AS first_issued FROM receipts WHERE issuer_org_id=$1 AND status <> 'cancelled'`, orgId, LIVE))!;
  const loans = (await db.get<any>(`SELECT count(DISTINCT ln.id)::int AS total, count(DISTINCT ln.id) FILTER (WHERE ln.status='repaid')::int AS repaid,
      count(DISTINCT ln.id) FILTER (WHERE ln.status='written_off')::int AS written_off, count(DISTINCT ln.id) FILTER (WHERE ln.status='disbursed' AND ln.due_on < current_date)::int AS overdue
    FROM loans ln JOIN liens li ON li.loan_id=ln.id JOIN receipts rc ON rc.id=li.receipt_id WHERE rc.issuer_org_id=$1`, orgId))!;
  const shortfall = Number(await db.val(`SELECT COALESCE(-sum(a.kg) FILTER (WHERE a.kg < 0), 0) FROM stock_adjustments a JOIN stacks s ON s.id=a.stack_id
    WHERE a.status='approved' AND s.warehouse_id IN (SELECT warehouse_id FROM issuer_warehouses WHERE issuer_org_id=$1)`, orgId).catch(() => 0));
  const ls = (await links(orgId)).filter((l) => l.status === 'active');
  let openChecks = 0;
  for (const l of ls) for (const x of await reconcile(l.warehouse_id)) openChecks += (x as any).flags.length;
  const devices = ls.reduce((n, l) => n + l.devices, 0), reporting = ls.reduce((n, l) => n + l.reporting, 0);
  const live = await liveValue(orgId), need = await guaranteeNeeded(orgId);
  const accepted = Number(await db.val('SELECT count(*) FROM lender_issuer_terms WHERE issuer_org_id=$1 AND accepted', orgId));
  return { status: p.status, tier: p.tier, certified_at: p.certified_at, guarantee: p.guarantee, guarantee_needed: need, guarantee_cover: live ? p.guarantee / live : null, live_value: live,
    receipts: r.receipts, live_receipts: r.live, kg: r.kg, value_at_storage: r.value_at_storage, first_issued: r.first_issued,
    warehouses: ls.length, devices, reporting, waiver_until: p.wareguard_waiver_until, open_checks: openChecks, shortfall_kg: shortfall,
    loans, lenders_accepting: accepted };
}

export async function issuersList(a: Actor) {
  if (!a.membership || !['kitovu', 'lender'].includes(a.membership.org_kind)) throw new UserError('Issuers are listed for Kitovu and lenders.');
  const kit = a.membership.org_kind === 'kitovu';
  const rows = await db.all<any>(`SELECT o.id, o.code, o.name, COALESCE(p.status,'applied') AS status, COALESCE(p.tier,'C') AS tier, t.accepted, t.max_ltv_bp
    FROM organisations o LEFT JOIN issuer_profiles p ON p.org_id=o.id LEFT JOIN lender_issuer_terms t ON t.issuer_org_id=o.id AND t.lender_org_id=$1
    WHERE o.kind='issuer' AND ($2 OR p.status IN ('certified','suspended')) ORDER BY o.name`, kit ? null : a.membership.org_id, kit);
  for (const r of rows) r.card = await scorecard(r.id);
  return rows;
}

// ---------- lender terms ----------
export async function setTerms(a: Actor, issuerCode: string, i: { accepted?: string; max_ltv?: string }) {
  if (a.membership?.org_kind !== 'lender' || !can(a.membership, 'finance.configure')) throw new UserError('Only a lender’s administrators set which issuers it accepts.');
  const iss = await issuerByCode(issuerCode);
  if (!iss || iss.status !== 'certified') throw new UserError('Only certified issuers can be accepted.');
  const accepted = i.accepted === '1';
  const cap = i.max_ltv ? Math.round(Number(i.max_ltv) * 100) : null;
  if (cap !== null && !(cap >= 1000 && cap <= 9000)) throw new UserError('Loan-to-value cap: between 10 and 90 (%), or blank.');
  await db.run(`INSERT INTO lender_issuer_terms (lender_org_id, issuer_org_id, accepted, max_ltv_bp, decided_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (lender_org_id, issuer_org_id) DO UPDATE SET accepted=EXCLUDED.accepted, max_ltv_bp=EXCLUDED.max_ltv_bp, decided_by=EXCLUDED.decided_by, decided_at=now()`,
    a.membership.org_id, iss.id, accepted, cap, a.user.id);
  await audit(actorOf(a), accepted ? 'issuer.accepted_by_lender' : 'issuer.declined_by_lender', { orgId: a.membership.org_id, data: { issuer: iss.code, max_ltv_bp: cap } });
}

/** For a lender and a receipt: may it lend, and at what loan-to-value cap? Kitovu-issued receipts: always, no cap. */
export async function lenderTermsFor(lenderOrgId: string, receiptId: string): Promise<{ ok: boolean; cap_bp: number | null; issuer: string | null }> {
  const r = await db.get<{ issuer_org_id: string | null; name: string | null; status: string | null }>(`SELECT r.issuer_org_id, o.name, p.status FROM receipts r LEFT JOIN organisations o ON o.id=r.issuer_org_id
    LEFT JOIN issuer_profiles p ON p.org_id=r.issuer_org_id WHERE r.id=$1`, receiptId);
  if (!r?.issuer_org_id) return { ok: true, cap_bp: null, issuer: null };
  const t = await db.get<{ accepted: boolean; max_ltv_bp: number | null }>('SELECT accepted, max_ltv_bp FROM lender_issuer_terms WHERE lender_org_id=$1 AND issuer_org_id=$2', lenderOrgId, r.issuer_org_id);
  return { ok: !!t?.accepted && r.status === 'certified', cap_bp: t?.max_ltv_bp ?? null, issuer: r.name };
}
