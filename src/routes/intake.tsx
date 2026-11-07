import { get, post } from '../lib/router';
import { HttpError, type Ctx } from '../lib/http';
import { UserError } from '../lib/errors';
import * as I from '../lib/intake';
import { screenIntake } from '../lib/agents/intake-screen';
import { render } from '../views/layout';
import { IntakesPage, IntakePage } from '../views/intake';
import { act } from './admin';
import { can } from '../lib/rbac';
import { db } from '../lib/db';
import { issuable, blockers } from '../lib/receipts';

/** JSON endpoints for the gate app: user mistakes come back as {error}, never as an HTML page. */
async function api(c: Ctx, fn: () => Promise<unknown>) {
  try { c.json(await fn()); }
  catch (e) {
    if (e instanceof I.Conflict) return c.json({ error: e.message }, 409);
    if (e instanceof UserError) return c.json({ error: e.message }, 400);
    throw e;
  }
}

get('/api/intake/bootstrap', 'perm:stock.manage', (c) => api(c, async () => ({ ...(await I.bootstrap(c.actor)), csrf: c.csrf })));

post('/api/intake', 'perm:stock.manage', (c) => api(c, async () => {
  const r = await I.ingest(c.actor, String(c.body.record ?? ''), c.files, { deviceClock: c.body.device_clock, userAgent: String(c.req.headers['user-agent'] || '') });
  if (r.result === 'stored') {
    // After the response: tell the farmer, and let the AI read the scale and moisture photos.
    const id = JSON.parse(String(c.body.record)).id;
    setImmediate(() => { void I.notifyFarmer(r as any); void screenIntake(id).catch((e) => console.error('[intake-screen]', e)); });
  }
  return { result: r.result, ref: r.ref, status: r.status, flags: r.flags };
}));

post('/api/intake/farmer-code', 'perm:stock.manage', (c) => api(c, async () => {
  await I.sendConfirmCode(c.actor, String(c.body.farmer_code ?? ''), c.body.channel === 'voice' ? 'voice' : 'sms');
  return { ok: true };
}));
post('/api/intake/farmer-code/verify', 'perm:stock.manage', (c) => api(c, async () =>
  ({ token: await I.verifyConfirmCode(c.actor, String(c.body.farmer_code ?? ''), String(c.body.intake_id ?? ''), String(c.body.otp ?? '')) })));

// ---------- review on the main site ----------
get('/intakes', 'perm:stock.manage', async (c) => {
  const q = c.query;
  c.html(render(<IntakesPage c={c} rows={await I.listIntakes(c.actor, { status: q.status, warehouse: q.warehouse })} q={q} />));
});
get('/intakes/:ref', 'perm:stock.manage', async (c) => {
  const i = await I.intakeByRef(c.actor, c.params.ref);
  if (!i) throw new HttpError(404, 'No delivery with that reference.');
  const issue = c.membership?.org_kind === 'kitovu' && can(c.membership, 'receipts.issue') || i.status === 'accepted'
    ? { blockers: can(c.membership, 'receipts.issue') && c.membership?.org_kind === 'kitovu' ? blockers((await issuable(i.id))!, c.actor) : ['Receipts are issued by Kitovu.'],
        receipts: await db.all(`SELECT receipt_no, net_weight_kg, status::text FROM receipts WHERE intake_id=$1 ORDER BY lot_no`, i.id) }
    : undefined;
  c.html(render(<IntakePage c={c} i={i} issue={issue} />));
});
post('/intakes/:ref/review', 'perm:stock.manage', (c) => act(c, `/intakes/${c.params.ref}`, async () => {
  const d = c.body.decision === 'accept' ? 'accept' : c.body.decision === 'reject' ? 'reject' : 'hold';
  await I.reviewIntake(c.actor, c.params.ref, d, c.body.note);
  return { accept: 'Accepted.', hold: 'Put on hold.', reject: 'Rejected. The clerk should record it again if it was a mistake.' }[d];
}));
post('/intakes/:ref/ai-recheck', 'perm:stock.manage', (c) => act(c, `/intakes/${c.params.ref}`, async () => {
  const i = await I.intakeByRef(c.actor, c.params.ref);
  if (!i || c.membership?.org_kind !== 'kitovu') throw new UserError('Not allowed.');
  const r = await screenIntake(i.id);
  return r ? `AI reading: ${r}.` : 'The AI reading did not run (see the note).';
}));
