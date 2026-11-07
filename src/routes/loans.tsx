import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import * as F from '../lib/finance';
import { reviewLine } from '../lib/agents/batch-review';
import { render } from '../views/layout';
import { LoansPage, BatchPage, LoanPage } from '../views/loans';
import { act } from './admin';
import { can } from '../lib/rbac';
import { db } from '../lib/db';

get('/loans', 'perm:finance.view', async (c) => {
  const kit = c.membership?.org_kind === 'kitovu';
  c.html(render(<LoansPage c={c} loans={await F.loansFor(c.actor, { status: c.query.status })} batches={await F.batchesFor(c.actor)}
    products={['lender', 'kitovu'].includes(c.membership!.org_kind) ? await F.productsOf(c.membership!.org_id) : []}
    alerts={can(c.membership, 'finance.view') ? await F.marginAlerts(kit ? null : c.membership!.org_id) : []} allProducts={kit ? await F.activeProducts() : []}
    salesToApprove={kit ? [] : await db.all(`SELECT DISTINCT s.ref, s.buyer_name FROM sale_items x JOIN sales s ON s.id=x.sale_id WHERE x.lender_org_id=$1 AND x.lender_approved_at IS NULL AND s.status='proposed'`, c.membership!.org_id)} />));
});
get('/loans/ncr.csv', 'perm:finance.view', async (c) => {
  const csv = await F.ncrCsv(c.actor);
  c.download(csv, 'text/csv; charset=utf-8', `storagex-ncr-${new Date().toISOString().slice(0, 10)}.csv`);
});
post('/loans/products', 'perm:finance.configure', (c) => act(c, '/loans', async () => { await F.createProduct(c.actor, c.body); return 'Product added.'; }));
post('/loans/batches', 'perm:receipts.issue', async (c) => {
  try { const b = await F.createBatch(c.actor, c.body.product); c.redirect(`/loans/batches/${b.ref}`); }
  catch (e: any) { c.back('/loans', ['error', e.message]); }
});
get('/loans/batches/:ref', 'perm:finance.view', async (c) => {
  const b = await F.batchView(c.actor, c.params.ref);
  if (!b) throw new HttpError(404, 'No such loan request.');
  c.html(render(<BatchPage c={c} b={b} />));
});
post('/loans/batches/:ref/lines', 'perm:receipts.issue', (c) => act(c, `/loans/batches/${c.params.ref}`, async () => {
  const b = await F.batchView(c.actor, c.params.ref);
  const r = await F.addLine(c.actor, b?.id, c.body);
  return `Added: ${(r.amount / 100).toLocaleString('en-NG')} naira (limit ${(r.max / 100).toLocaleString('en-NG')}).`;
}));
post('/loans/batches/:ref/submit', 'perm:receipts.issue', (c) => act(c, `/loans/batches/${c.params.ref}`, async () => {
  const b = await F.batchView(c.actor, c.params.ref);
  await F.submitBatch(c.actor, b?.id, (id) => reviewLine(id));
  return `Submitted to ${b?.lender}. The batch reviewer has added its checks.`;
}));
post('/loans/lines/:id/remove', 'perm:receipts.issue', (c) => act(c, '/loans', async () => { await F.removeLine(c.actor, c.params.id); return 'Removed.'; }));
post('/loans/lines/:id/decide', 'perm:finance.approve', (c) => act(c, '/loans', async () => {
  await F.decideLine(c.actor, c.params.id, c.body.decision === 'approve', c.body);
  return c.body.decision === 'approve' ? 'Approved. The receipts are now pledged to you; record the disbursement on the loan.' : 'Rejected.';
}));
get('/loans/:no', 'perm:finance.view', async (c) => {
  const ln = await F.loanView(c.actor, c.params.no);
  if (!ln) throw new HttpError(404, 'No such loan.');
  c.html(render(<LoanPage c={c} ln={ln} />));
});
post('/loans/:no/disburse', 'perm:finance.approve', (c) => act(c, `/loans/${c.params.no}`, async () => { await F.disburse(c.actor, c.params.no, c.body); return 'Disbursement recorded. The farmer has been told.'; }));
post('/loans/:no/cancel', 'perm:finance.approve', (c) => act(c, `/loans/${c.params.no}`, async () => { await F.cancelLoan(c.actor, c.params.no, c.body.reason); return 'Loan cancelled; receipts released.'; }));
post('/loans/:no/repay', 'perm:finance.view', (c) => act(c, `/loans/${c.params.no}`, async () => {
  const r = await F.repay(c.actor, c.params.no, c.body);
  return r.closed ? 'Paid in full. The loan is closed and the receipts are released.' : `Recorded. Still owed: ${(r.outstanding / 100).toLocaleString('en-NG')} naira.`;
}));
