import { get, post } from '../lib/router';
import { HttpError, type Ctx } from '../lib/http';
import { UserError } from '../lib/errors';
import * as St from '../lib/stock';
import { commodities } from '../lib/registry';
import { render } from '../views/layout';
import { StockOverviewPage, WarehouseStockPage, ReleasePage } from '../views/stock';
import { act } from './admin';

async function wh(c: Ctx) {
  const w = await St.warehouseByCode(c.actor, c.params.code).catch(() => undefined);
  if (!w) throw new HttpError(404, 'Warehouse not found.');
  return w;
}

get('/stock', 'perm:stock.manage', async (c) => c.html(render(<StockOverviewPage c={c} rows={await St.overview(c.actor)} />)));
get('/stock/:code', 'perm:stock.manage', async (c) => {
  const w = await wh(c);
  c.html(render(<WarehouseStockPage c={c} w={w} rec={await St.reconcile(w.id)} stacks={await St.stacksOf(w.id)} adj={await St.pendingAdjustments(w.id)}
    rels={await St.releasesAt(w.id)} moves={await St.movesOf(w.id)} commodities={await commodities()} />));
});
post('/stock/:code/stack', 'perm:stock.manage', (c) => act(c, `/stock/${c.params.code}`, async () => { const w = await wh(c); await St.createStack(c.actor, w.id, c.body.code, c.body.commodity); return 'Stack added.'; }));
post('/stock/:code/transfer', 'perm:stock.manage', (c) => act(c, `/stock/${c.params.code}`, async () => { const w = await wh(c); await St.transfer(c.actor, w.id, c.body); return 'Moved.'; }));
post('/stock/:code/count', 'perm:stock.manage', (c) => act(c, `/stock/${c.params.code}`, async () => {
  const w = await wh(c);
  const r = await St.recordCount(c.actor, w.id, c.body, c.files.photo);
  return `Count saved: about ${r.est.toLocaleString('en-NG')} kg against ${r.book.toLocaleString('en-NG')} kg in the ledger (${r.diff >= 0 ? '+' : ''}${r.diff.toLocaleString('en-NG')} kg).`;
}));
post('/stock/:code/adjust', 'perm:stock.manage', (c) => act(c, `/stock/${c.params.code}`, async () => { const w = await wh(c); await St.proposeAdjustment(c.actor, w.id, c.body, c.files.photo); return 'Proposed. A Kitovu colleague must approve it.'; }));
post('/stock/adjustments/:id', 'perm:stock.manage', (c) => act(c, '/stock', async () => { await St.decideAdjustment(c.actor, c.params.id, c.body.decision === 'approve', c.body.note); return c.body.decision === 'approve' ? 'Approved and posted.' : 'Rejected.'; }));
post('/stock/:code/review', 'perm:receipts.issue', (c) => act(c, `/stock/${c.params.code}`, async () => {
  const w = await wh(c);
  const n = await St.setUnderReview(c.actor, w.id, String(c.body.commodity), c.body.on === '1', c.body.note);
  return c.body.on === '1' ? `${n} receipt(s) now show “Under review”.` : `${n} receipt(s) restored.`;
}));

post('/receipts/:no/release', 'perm:receipts.issue', (c) => act(c, `/receipts/${c.params.no}`, async () => { const r = await St.orderRelease(c.actor, c.params.no, c.body); return `Release ${r.ref} ordered. The warehouse loads it.`; }));
get('/releases/:ref', 'perm:stock.manage', async (c) => {
  const x = await St.releaseByRef(c.actor, c.params.ref);
  if (!x) throw new HttpError(404, 'Release not found.');
  c.html(render(<ReleasePage c={c} x={x} stacks={await St.stacksOf(x.warehouse_id)} />));
});
post('/releases/:ref/load', 'perm:stock.manage', (c) => act(c, `/releases/${c.params.ref}`, async () => {
  const r = await St.confirmLoading(c.actor, c.params.ref, c.body, { scale: c.files.scale, slip: c.files.slip });
  setImmediate(() => void St.notifyRelease(r));
  return r.closed ? 'Loaded. The receipt is now closed.' : `Loaded. ${r.remaining.toLocaleString('en-NG')} kg still held on the receipt.`;
}));
post('/releases/:ref/cancel', 'perm:receipts.issue', (c) => act(c, `/releases/${c.params.ref}`, async () => { await St.cancelRelease(c.actor, c.params.ref, c.body.note); return 'Release cancelled.'; }));
