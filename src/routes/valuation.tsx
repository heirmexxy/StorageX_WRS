import { get, post } from '../lib/router';
import * as V from '../lib/valuation';
import { states, commodities } from '../lib/registry';
import { render } from '../views/layout';
import { PricesPage, PolicyPage } from '../views/valuation';
import { act } from './admin';
import { can } from '../lib/rbac';
import { UserError } from '../lib/errors';

get('/prices', 'perm:finance.view', async (c) => c.html(render(<PricesPage c={c} overview={await V.pricesOverview()} recent={await V.recentObservations()} sources={await V.sources()} states={await states()}
  crops={await commodities()} />)));
post('/prices', 'auth', (c) => act(c, '/prices', async () => {
  const r = await V.addObservation(c.actor, c.body, c.files.evidence);
  return `Submitted: ₦${(r.perKg / 100).toLocaleString('en-NG')}/kg${r.outlier !== null ? ` (${r.outlier > 0 ? '+' : ''}${r.outlier}% vs reference)` : ''}. Waiting for approval.`;
}));
post('/prices/sources', 'perm:finance.configure', (c) => act(c, '/prices', async () => { await V.addSource(c.actor, c.body.name, c.body.kind, c.body.note); return 'Source added.'; }));
post('/prices/revalue', 'perm:finance.configure', (c) => act(c, '/prices', async () => {
  if (c.membership?.org_kind !== 'kitovu') throw new UserError('Only Kitovu runs the revaluation.');
  const r = await V.revalueAll();
  return `Revalued ${r.valued} receipt(s)${r.unpriced ? `; ${r.unpriced} without a usable price` : ''}${r.drops.length ? `; ${r.drops.length} fell by more than the alert level` : ''}. (Receipts already valued today are kept as they were.)`;
}));
post('/prices/:id', 'perm:finance.configure', (c) => act(c, '/prices', async () => { await V.decideObservation(c.actor, c.params.id, c.body.decision === 'approve', c.body.note); return c.body.decision === 'approve' ? 'Approved.' : 'Rejected.'; }));
get('/valuation/policy', 'perm:finance.view', async (c) => c.html(render(<PolicyPage c={c} rows={await V.policies(c.actor)} />)));
post('/valuation/policy', 'perm:finance.configure', (c) => act(c, '/valuation/policy', async () => {
  if (!can(c.membership, 'finance.configure')) throw new UserError('Not allowed.');
  await V.setPolicy(c.actor, c.body.commodity, c.body.haircut, c.body.ltv); return 'Policy saved.';
}));
