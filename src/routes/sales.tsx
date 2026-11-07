import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import { db } from '../lib/db';
import * as S from '../lib/settlement';
import { farmerByCode } from '../lib/registry';
import { render } from '../views/layout';
import { SalesPage, SalePage, CollectionsPage, StatementPage } from '../views/sales';
import { act } from './admin';
import { UserError } from '../lib/errors';

const kitovuOnly = (c: any) => { if (c.membership?.org_kind !== 'kitovu') throw new HttpError(403, 'Sales are arranged by Kitovu.'); };
get('/sales', 'perm:receipts.view', async (c) => { kitovuOnly(c); c.html(render(<SalesPage c={c} rows={await S.salesList()} buyers={await db.all(`SELECT id, name FROM organisations WHERE kind='buyer' ORDER BY name`)} />)); });
post('/sales', 'perm:receipts.issue', async (c) => {
  try { const r = await S.proposeSale(c.actor, c.body); c.setFlash('ok', `Sale ${r.ref} proposed. Record each farmer’s agreement.`); c.redirect(`/sales/${r.ref}`); }
  catch (e: any) { if (!(e instanceof UserError)) throw e; c.back('/sales', ['error', e.message]); }
});
get('/sales/:ref', 'perm:receipts.view', async (c) => {
  const s = await S.saleView(c.actor, c.params.ref);
  if (!s) throw new HttpError(404, 'No such sale.');
  c.html(render(<SalePage c={c} s={s} />));
});
const saleId = async (ref: string) => { const id = await db.val<string>('SELECT id FROM sales WHERE ref=upper($1)', ref); if (!id) throw new UserError('No such sale.'); return id; };
const backToSale = async (itemId: string) => `/sales/${(await db.val<string>('SELECT s.ref FROM sale_items x JOIN sales s ON s.id=x.sale_id WHERE x.id=$1', itemId)) ?? ''}`;
post('/sales/items/:id/code', 'perm:receipts.issue', async (c) => act(c, await backToSale(c.params.id), async () => { await S.sendAgreementCode(c.actor, c.params.id, c.body.channel === 'voice' ? 'voice' : 'sms'); return 'Code sent to the farmer.'; }));
post('/sales/items/:id/agree', 'perm:receipts.issue', async (c) => act(c, await backToSale(c.params.id), async () => { await S.recordAgreement(c.actor, c.params.id, c.body, c.files.slip); return 'Agreement recorded.'; }));
post('/sales/items/:id/lender-approve', 'perm:finance.approve', async (c) => act(c, await backToSale(c.params.id), async () => { await S.lenderApprove(c.actor, c.params.id); return 'Sale approved.'; }));
post('/sales/:ref/deliver', 'perm:receipts.issue', (c) => act(c, `/sales/${c.params.ref}`, async () => `Delivery ordered: ${(await S.orderDelivery(c.actor, await saleId(c.params.ref), c.body.collector, c.body.phone)).join(', ')}.`));
post('/sales/:ref/settle', 'perm:finance.approve', (c) => act(c, `/sales/${c.params.ref}`, async () => { const t = await S.settle(c.actor, await saleId(c.params.ref)); return `Settled: ₦${(t.farmer / 100).toLocaleString('en-NG')} to farmers, ₦${(t.lender / 100).toLocaleString('en-NG')} to lenders, ₦${(t.kitovu / 100).toLocaleString('en-NG')} Kitovu fees. Now record the payouts.`; }));
post('/sales/:ref/cancel', 'perm:receipts.issue', (c) => act(c, `/sales/${c.params.ref}`, async () => { await S.cancelSale(c.actor, await saleId(c.params.ref), c.body.reason); return 'Sale cancelled; receipts restored.'; }));
post('/settlements/lines/:id/paid', 'perm:finance.approve', async (c) => {
  const ref = await db.val<string>('SELECT s.ref FROM settlement_lines sl JOIN settlements st ON st.id=sl.settlement_id JOIN sales s ON s.id=st.sale_id WHERE sl.id=$1', c.params.id);
  return act(c, `/sales/${ref ?? ''}`, async () => { await S.markPaid(c.actor, c.params.id, c.body.reference); return 'Payout recorded.'; });
});

get('/collections', 'perm:finance.approve', async (c) => { kitovuOnly(c); c.html(render(<CollectionsPage c={c} rows={await S.unmatchedCollections()} open={await db.all(`SELECT ref, buyer_name FROM sales WHERE status='approved' ORDER BY ref`)} />)); });
post('/collections', 'perm:finance.approve', (c) => act(c, '/collections', async () => { const r = await S.recordCollection(c.actor, c.body); return r.matched ? 'Recorded and matched to the sale.' : 'Recorded. Match it to a sale below.'; }));
post('/collections/:id/match', 'perm:finance.approve', (c) => act(c, '/collections', async () => { await S.matchCollection(c.actor, c.params.id, c.body.sale); return 'Matched.'; }));

get('/farmers/:code/statement', 'perm:farmers.view', async (c) => {
  if (c.membership?.org_kind === 'lender') throw new HttpError(403, 'Statements are for Kitovu and the farmer’s own network.');
  const f = await farmerByCode(c.actor, c.params.code);
  if (!f) throw new HttpError(404, 'Farmer not found.');
  c.html(render(<StatementPage c={c} f={f} st={await S.farmerStatement(f.id)} />));
});
