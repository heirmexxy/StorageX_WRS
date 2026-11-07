import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import { UserError } from '../lib/errors';
import * as Rc from '../lib/receipts';
import { intakeByRef } from '../lib/intake';
import { publicJwk } from '../lib/sign';
import { render } from '../views/layout';
import { ReceiptsPage, ReceiptPage, PassportPage } from '../views/receipts';
import { act } from './admin';
import { receiptBalance, releasesOf } from '../lib/stock';

get('/receipts', 'perm:receipts.view', async (c) => c.html(render(<ReceiptsPage c={c} rows={await Rc.listReceipts(c.actor, { status: c.query.status, text: c.query.q })} q={c.query} />)));
get('/receipts/:no', 'perm:receipts.view', async (c) => {
  const r = await Rc.receiptByNo(c.actor, c.params.no);
  if (!r) throw new HttpError(404, 'No receipt with that number, or you cannot see it.');
  c.html(render(<ReceiptPage c={c} r={r} events={await Rc.eventsOf(r.id)} chainOk={await Rc.chainOk(r.id)} url={Rc.verifyUrl(r)} bal={await receiptBalance(r.id)} rels={await releasesOf(r.id)} />));
});
get('/receipts/:no/pdf', 'perm:receipts.view', async (c) => {
  try { const { pdf, name } = await Rc.receiptPdf(c.actor, c.params.no); c.bytes(pdf, 'application/pdf', name); }
  catch (e) { if (e instanceof UserError) throw new HttpError(404, e.message); throw e; }
});
post('/receipts/:no/cancel', 'perm:receipts.issue', (c) => act(c, `/receipts/${c.params.no}`, async () => { await Rc.cancelReceipt(c.actor, c.params.no, c.body.reason); return 'Receipt cancelled.'; }));

post('/intakes/:ref/issue', 'perm:receipts.issue', (c) => act(c, `/intakes/${c.params.ref}`, async () => {
  const i = await intakeByRef(c.actor, c.params.ref);
  if (!i) throw new UserError('Delivery not found.');
  const r = await Rc.issueFromIntake(c.actor, i.id, c.body.split);
  setImmediate(() => void Rc.notifyIssued(r));
  return `Issued ${r.receipts.map((x) => x.no).join(', ')}.`;
}));

// Public: anyone holding the QR or link can check a receipt. No sign-in, minimal personal data.
get('/r/:token', 'public', async (c) => {
  const p = await Rc.passport(String(c.params.token).toLowerCase(), c.query.s ? String(c.query.s) : undefined, c.ip).catch((e) => { if (e instanceof UserError) throw new HttpError(429, e.message); throw e; });
  if (!p) throw new HttpError(404, 'No StorageX receipt matches this code. If you were given this as a receipt, it is not genuine.');
  c.res.setHeader('X-Robots-Tag', 'noindex');
  c.html(render(<PassportPage c={c} p={p} />));
});
get('/.well-known/storagex-receipt-key.json', 'public', (c) => c.json({ keys: [publicJwk()], signed: 'SXR1|receipt_no|verify_token|commodity_code|net_kg (2 dp)|warehouse_code|issued_at (ISO UTC)' }));
