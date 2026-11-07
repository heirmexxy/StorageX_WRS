import { get, post } from '../lib/router';
import { HttpError, type Ctx } from '../lib/http';
import { db } from '../lib/db';
import { UserError } from '../lib/errors';
import * as R from '../lib/registry';
import * as K from '../lib/kyc';
import * as P from '../lib/applications';
import { fileRow, readFile } from '../lib/files';
import { audit } from '../lib/audit';
import { actorOf } from '../lib/auth';
import { render } from '../views/layout';
import { FarmersPage, FarmerNewPage, FarmerPage, KycReviewPage, ReviewQueuePage, FieldPartnersPage, WarehousesPage, WarehousePage, type FarmerView } from '../views/registry';
import { ApplyPage, ApplyThanksPage, ApplicationsPage } from '../views/apply';
import { act } from './admin';
import { deliveriesOf } from '../lib/intake';
import { can } from '../lib/rbac';
import { screenSubmission } from '../lib/agents/kyc-screen';
import * as S from '../lib/settings';
import { config } from '../lib/config';
import { SettingsPage } from '../views/settings';

const farmerBody = (c: Ctx) => ({ ...c.body, commodities: c.multi.commodities ?? [] });

// ---------- farmers ----------
get('/farmers', 'perm:farmers.view', async (c) => {
  const q = c.query;
  const rows = await R.searchFarmers(c.actor, { text: q.q, state: q.state, level: q.level, review: q.review });
  c.html(render(<FarmersPage c={c} rows={rows} q={q} states={await R.states()} />));
});

get('/farmers/new', 'perm:farmers.edit', async (c) => c.html(render(<FarmerNewPage c={c} states={await R.states()} crops={await R.commodities()} />)));
post('/farmers/new', 'perm:farmers.edit', async (c) => {
  try { c.setFlash('ok', 'Farmer registered. Next: confirm their phone.'); c.redirect(`/farmers/${await R.createFarmer(c.actor, farmerBody(c))}`); }
  catch (e) {
    if (!(e instanceof UserError)) throw e;
    const values = { ...c.body, phone_e164: c.body.phone, commodities: c.multi.commodities ?? [] };
    c.html(render(<FarmerNewPage c={c} states={await R.states()} crops={await R.commodities()} error={e.message} values={values} duplicate={e instanceof R.DuplicateWarning} />), 400);
  }
});

async function farmerView(c: Ctx, extra: Partial<FarmerView> = {}) {
  const f = await R.farmerByCode(c.actor, c.params.code);
  if (!f) throw new HttpError(404, 'No farmer with that code, or you cannot see them.');
  const kit = c.membership?.org_kind === 'kitovu';
  const v: FarmerView = {
    f, states: await R.states(), crops: await R.commodities(), lenders: await K.lenders(), pm: await K.phoneMethods(),
    subs: kit || c.membership?.org_kind !== 'lender' ? await K.submissionsFor(f.id) : [],
    consents: c.membership?.org_kind === 'lender' ? [] : await K.consentsFor(f.id),
    verifs: await K.verificationsFor(c.actor, f.id),
    deliveries: c.membership?.org_kind === 'lender' ? [] : await deliveriesOf(f.id),
    issues: kit && can(c.membership, 'farmers.edit') ? await R.openIssues(c.actor, { entity: 'farmer', entityId: f.id, includeInfo: true, includeResolved: true }) : [],
    ...extra,
  };
  if (c.membership?.org_kind === 'lender') await audit(actorOf(c.actor), 'farmer.viewed_by_lender', { orgId: c.membership.org_id, entity: 'farmer', entityId: f.id });
  return v;
}
get('/farmers/:code', 'perm:farmers.view', async (c) => c.html(render(<FarmerPage c={c} v={await farmerView(c)} />)));

/** For steps that render the farmer page again (code entry), rather than redirecting. */
async function onFarmer(c: Ctx, fn: () => Promise<Partial<FarmerView> | void>, okMsg?: string) {
  try {
    const extra = await fn();
    if (extra) { if (okMsg) c.flash = { type: 'ok', msg: okMsg }; return c.html(render(<FarmerPage c={c} v={await farmerView(c, extra)} />)); }
    c.setFlash('ok', okMsg || 'Saved.');
    c.redirect(`/farmers/${c.params.code.toUpperCase()}`);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    c.flash = { type: 'error', msg: e.message };
    c.html(render(<FarmerPage c={c} v={await farmerView(c)} />), 400);
  }
}

post('/farmers/:code', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await R.updateFarmer(c.actor, c.params.code, farmerBody(c)); }, 'Saved.'));
post('/farmers/:code/phone/send', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.sendPhoneCode(c.actor, c.params.code, c.body.channel === 'voice' ? 'voice' : 'sms'); return { codeSent: 'phone' }; }, c.body.channel === 'voice' ? 'Calling the farmer now. Ask them to tell you the code they hear.' : 'Code sent. Ask the farmer to read it out.'));
post('/farmers/:code/attest', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.attestPresence(c.actor, c.params.code, c.body); }, 'Attestation recorded. Kitovu may call the witness to confirm.'));
post('/farmers/:code/phone/confirm', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.confirmPhone(c.actor, c.params.code, c.body.otp); }, 'Phone confirmed.'));
post('/farmers/:code/kyc', 'perm:farmers.edit', (c) => onFarmer(c, async () => {
  const id = await K.submitLevel1(c.actor, c.params.code, c.body, { id_doc: c.files.id_doc, selfie: c.files.selfie });
  // The AI pre-check runs after the response; the reviewer sees its findings when they open the queue.
  void screenSubmission(id).catch((e) => console.error('[kyc-screen]', e));
}, 'Sent for review. A Kitovu compliance officer will check it.'));
post('/farmers/:code/consent/send', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.sendConsentCode(c.actor, c.params.code, c.body.org_id, c.body.channel === 'voice' ? 'voice' : 'sms'); return { consentLender: c.body.org_id }; }, 'Consent code sent. Read the statement to the farmer, then enter the code they received.'));
post('/farmers/:code/consent', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.recordConsent(c.actor, c.params.code, c.body, c.files.evidence); }, 'Consent recorded. The lender can now see this farmer.'));
post('/farmers/:code/consent/:id/withdraw', 'perm:farmers.edit', (c) => onFarmer(c, async () => { await K.withdrawConsent(c.actor, c.params.id, c.body.reason); }, 'Consent withdrawn. The lender no longer sees this farmer.'));
post('/farmers/:code/lender-verify', 'perm:farmers.verify_account', (c) => onFarmer(c, async () => { await K.lenderVerify(c.actor, c.params.code, c.body.customer_ref); }, 'Confirmed. The farmer is now level 2.'));
post('/farmers/:code/lender-revoke', 'perm:farmers.verify_account', (c) => onFarmer(c, async () => { await K.lenderRevoke(c.actor, c.params.code); }, 'Confirmation withdrawn.'));

// ---------- identity review ----------
get('/kyc/review', 'perm:kyc.review', async (c) => c.html(render(<KycReviewPage c={c} rows={await K.reviewQueue(c.actor)} />)));
post('/kyc/:id/approve', 'perm:kyc.review', (c) => act(c, '/kyc/review', async () => { await K.review(c.actor, c.params.id, 'approve', { note: c.body.note, checks: c.multi.checks ?? [] }); return 'Approved. The farmer is now level 1.'; }));
post('/kyc/:id/ai-recheck', 'perm:kyc.review', (c) => act(c, '/kyc/review', async () => { const f = await screenSubmission(c.params.id); return f ? `AI pre-check: ${f}.` : 'AI pre-check did not run (see the note on the item).'; }));
post('/kyc/:id/reject', 'perm:kyc.review', (c) => act(c, '/kyc/review', async () => { await K.review(c.actor, c.params.id, 'reject', { reason: c.body.reason, note: c.body.note }); return 'Rejected. The field partner can submit again.'; }));

// Decrypted files are served only to Kitovu roles that need them, and every opening is logged.
get('/files/:id', 'auth', async (c) => {
  const f = await fileRow(c.params.id);
  if (!f || !(await K.canOpenFile(c.actor, f))) throw new HttpError(404, 'File not found.');
  const data = readFile(f);
  await audit(actorOf(c.actor), 'file.viewed', { entity: f.entity, entityId: f.entity_id, data: { file: f.id, kind: f.kind } });
  c.bytes(data, f.mime, `${f.kind}${f.mime === 'application/pdf' ? '.pdf' : ''}`);
});

// ---------- review queue ----------
get('/review', 'perm:farmers.edit', async (c) => {
  const q = c.query;
  c.html(render(<ReviewQueuePage c={c} q={q} rows={await R.openIssues(c.actor, { entity: q.entity, includeInfo: q.info === '1', includeResolved: q.resolved === '1' })} />));
});
post('/review/:id/resolve', 'auth', (c) => act(c, '/review', async () => { await R.resolveIssue(c.actor, c.params.id, c.body.note); return 'Resolved.'; }));

// ---------- field partners ----------
get('/field-partners', 'perm:field_partners.manage', async (c) => {
  const networks = await db.all(`SELECT id, name FROM organisations WHERE kind IN ('field_partner_network','cooperative') AND status IN ('active','onboarding') ORDER BY name`);
  c.html(render(<FieldPartnersPage c={c} rows={await R.listFieldPartners(c.actor)} states={await R.states()} networks={networks} />));
});
post('/field-partners', 'perm:field_partners.manage', (c) => act(c, '/field-partners', async () => `Added as ${await R.createFieldPartner(c.actor, c.body)}.`));
post('/field-partners/:id/verify', 'perm:field_partners.manage', (c) => act(c, '/field-partners', async () => { await R.setFieldPartnerStatus(c.actor, c.params.id, 'active'); return 'Verified. They can now register farmers.'; }));
post('/field-partners/:id/suspend', 'perm:field_partners.manage', (c) => act(c, '/field-partners', async () => { await R.setFieldPartnerStatus(c.actor, c.params.id, 'suspended'); return 'Suspended.'; }));

// ---------- warehouses ----------
get('/warehouses', 'perm:warehouses.view', async (c) => c.html(render(<WarehousesPage c={c} rows={await R.listWarehouses(c.actor)} />)));
get('/warehouses/:code', 'perm:warehouses.view', async (c) => {
  const w = await R.warehouseByCode(c.actor, c.params.code);
  if (!w) throw new HttpError(404, 'No warehouse with that code.');
  const kit = c.membership?.org_kind === 'kitovu' && can(c.membership, 'warehouses.edit');
  const issues = kit ? await R.openIssues(c.actor, { entity: 'warehouse', entityId: w.id, includeInfo: true, includeResolved: true }) : [];
  c.html(render(<WarehousePage c={c} w={w} policies={await R.policiesFor(w.id)} issues={issues} />));
});
post('/warehouses/:code', 'perm:warehouses.edit', (c) => act(c, `/warehouses/${c.params.code}`, async () => { await R.updateWarehouse(c.actor, c.params.code, c.body); return 'Saved.'; }));
post('/warehouses/:code/insurance', 'perm:warehouses.edit', (c) => act(c, `/warehouses/${c.params.code}`, async () => { await R.addPolicy(c.actor, c.params.code, c.body); return 'Policy added. A colleague must verify it.'; }));
post('/warehouses/:code/insurance/:id/verify', 'perm:warehouses.edit', (c) => act(c, `/warehouses/${c.params.code}`, async () => { await R.verifyPolicy(c.actor, c.params.id); return 'Policy verified.'; }));

// ---------- partner applications ----------
get('/apply', 'public', async (c) => c.html(render(<ApplyPage c={c} states={await R.states()} />)));
post('/apply', 'public', async (c) => {
  try { await P.submitApplication(c.body, c.ip); c.redirect('/apply/thanks'); }
  catch (e) { if (!(e instanceof UserError)) throw e; c.html(render(<ApplyPage c={c} states={await R.states()} error={e.message} v={c.body} />), 400); }
});
get('/apply/thanks', 'public', (c) => c.html(render(<ApplyThanksPage c={c} />)));

get('/admin/applications', 'perm:orgs.manage', async (c) => {
  const status = String(c.query.status || 'new');
  c.html(render(<ApplicationsPage c={c} rows={await P.listApplications(c.actor, status)} status={status} />));
});
post('/admin/applications/:id/approve', 'perm:orgs.manage', async (c) => {
  try { const r = await P.approveApplication(c.actor, c.params.id, c.body); c.html(render(<ApplicationsPage c={c} rows={await P.listApplications(c.actor, 'new')} status="new" link={r} />)); }
  catch (e) { if (!(e instanceof UserError)) throw e; c.back('/admin/applications', ['error', e.message]); }
});
post('/admin/applications/:id/reject', 'perm:orgs.manage', (c) => act(c, '/admin/applications', async () => { await P.rejectApplication(c.actor, c.params.id, c.body); return 'Application closed.'; }));

// ---------- platform settings ----------
get('/admin/settings', 'perm:settings.manage', async (c) => {
  const stats = await db.get(`SELECT count(*) FILTER (WHERE reviewer_agreed_with_ai) AS agreed, count(*) FILTER (WHERE reviewer_agreed_with_ai = false) AS disagreed,
    count(*) FILTER (WHERE ai_flag IS NOT NULL AND status IN ('approved','rejected')) AS screened FROM kyc_submissions`);
  c.html(render(<SettingsPage c={c} s={await S.getSettings()} serverAiOff={config.kycAiMode === 'off'} hasKey={!!config.anthropicKey} stats={stats} />));
});
post('/admin/settings', 'perm:settings.manage', (c) => act(c, '/admin/settings', async () => {
  const input: Record<string, unknown> = {};
  for (const k of Object.keys(S.DEFAULTS)) input[k] = c.body[k] ?? (typeof (S.DEFAULTS as any)[k] === 'boolean' ? '0' : undefined);
  const n = await S.saveSettings(c.actor, input);
  return n ? `${n} setting(s) changed.` : 'Nothing changed.';
}));
