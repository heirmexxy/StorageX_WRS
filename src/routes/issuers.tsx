import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import { db } from '../lib/db';
import * as I from '../lib/issuers';
import { render } from '../views/layout';
import { IssuersPage, IssuerPage, ChargesPage } from '../views/issuers';
import { act } from './admin';

get('/issuers', 'auth', async (c) => c.html(render(<IssuersPage c={c} rows={await I.issuersList(c.actor)} />)));
get('/issuers/charges', 'auth', async (c) => c.html(render(<ChargesPage c={c} rows={await I.chargesList(c.actor, c.query)} />)));
post('/issuers/charges/:id', 'perm:finance.approve', (c) => act(c, '/issuers/charges', async () => { await I.settleCharge(c.actor, c.params.id, c.body.status === 'waived' ? 'waived' : 'paid', c.body.note); return 'Saved.'; }));
// An issuer's own staff land on their page.
get('/issuer', 'auth', async (c) => {
  if (c.membership?.org_kind !== 'issuer') throw new HttpError(404, 'There is no page at this address.');
  c.redirect(`/issuers/${await db.val<string>('SELECT code FROM organisations WHERE id=$1', c.membership.org_id)}`);
});
get('/issuers/:code', 'auth', async (c) => {
  const iss = await I.issuerByCode(c.params.code);
  const m = c.membership;
  const kit = m?.org_kind === 'kitovu', self = m?.org_id === iss?.id;
  if (!iss || !(kit || self || (m?.org_kind === 'lender' && ['certified', 'suspended'].includes(iss.status)))) throw new HttpError(404, 'Issuer not found.');
  c.html(render(<IssuerPage c={c} iss={iss} card={await I.scorecard(iss.id)} links={await I.links(iss.id)}
    blockers={kit || self ? await I.blockers(iss.id) : []}
    terms={m?.org_kind === 'lender' ? await db.get('SELECT * FROM lender_issuer_terms WHERE lender_org_id=$1 AND issuer_org_id=$2', m.org_id, iss.id) : undefined}
    whs={kit ? await db.all(`SELECT code, name FROM warehouses WHERE status <> 'closed' ORDER BY name`) : undefined} />));
});
const back = (c: any) => `/issuers/${c.params.code}`;
post('/issuers/:code/link', 'auth', (c) => act(c, back(c), async () => { await I.linkWarehouse(c.actor, c.params.code, c.body); return 'Warehouse linked.'; }));
post('/issuers/:code/unlink', 'auth', (c) => act(c, back(c), async () => { await I.endLink(c.actor, c.params.code, c.body.warehouse); return 'Link ended: no new receipts can be issued there.'; }));
post('/issuers/:code/guarantee', 'auth', (c) => act(c, back(c), async () => { await I.setGuarantee(c.actor, c.params.code, c.body); return 'Guarantee recorded.'; }));
post('/issuers/:code/waiver', 'auth', (c) => act(c, back(c), async () => { await I.setWaiver(c.actor, c.params.code, c.body); return 'Saved.'; }));
post('/issuers/:code/tier', 'auth', (c) => act(c, back(c), async () => { await I.setTier(c.actor, c.params.code, c.body.tier); return 'Tier set.'; }));
post('/issuers/:code/certify', 'auth', (c) => act(c, back(c), async () => { await I.certify(c.actor, c.params.code); return 'Certified: the issuer can now issue receipts at its linked warehouses.'; }));
post('/issuers/:code/suspend', 'auth', (c) => act(c, back(c), async () => { await I.suspend(c.actor, c.params.code, c.body.reason); return 'Suspended. Lenders holding its receipts have been told.'; }));
post('/issuers/:code/terms', 'perm:finance.configure', (c) => act(c, back(c), async () => { await I.setTerms(c.actor, c.params.code, c.body); return 'Your terms are saved.'; }));
