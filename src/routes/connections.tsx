import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import * as PS from '../lib/paystack';
import { bvnCheck } from '../lib/identity';
import { act } from './admin';
import * as TT from '../lib/titan';

// Titan's webhook: made by `node dist/cli.mjs titan-connect`, which subscribes https://<site>/hooks/titan.
post('/hooks/titan', 'webhook', async (c) => {
  if (!(await TT.validSignature(c.raw, String(c.req.headers['x-titan-signature'] ?? '')))) throw new HttpError(401, 'Bad signature.');
  try { await TT.handleEvent(c.body, c.raw); }
  catch (e) { console.error('[titan]', e); throw new HttpError(500, 'Could not record the event; Titan will retry.'); }
  c.text('OK');
});
post('/warehouses/:code/titan', 'perm:warehouses.edit', (c) => act(c, `/warehouses/${c.params.code}`, async () => { await TT.linkSite(c.actor, c.params.code, c.body.site_id); return c.body.site_id ? 'Linked to the Titan site. Readings arrive within 10 minutes.' : 'Unlinked from Titan.'; }));

// Paystack's webhook: set it in the Paystack dashboard (Settings → API keys & webhooks) to
// https://storagex.com.ng/hooks/paystack. Every event is checked against Paystack's signature.
post('/hooks/paystack', 'webhook', async (c) => {
  if (!PS.validSignature(c.raw, String(c.req.headers['x-paystack-signature'] ?? ''))) throw new HttpError(401, 'Bad signature.');
  try { await PS.handleEvent(c.body); }
  catch (e) { console.error('[paystack]', e); throw new HttpError(500, 'Could not record the event; Paystack will retry.'); }
  c.text('OK');
});

// Farmer page: payout account and BVN check (Kitovu finance and compliance).
post('/farmers/:code/payout-account', 'perm:finance.approve', (c) => act(c, `/farmers/${c.params.code}`, async () => {
  const r = await PS.saveRecipient(c.actor, c.params.code, c.body);
  return `Saved: the bank holds the account as “${r.account_name}”${r.match === 'match' ? '' : r.match === 'partial' ? ' (a partial match with the farmer’s name)' : ' (name differs; your note is recorded)'}. Only the last four digits are kept.`;
}));
post('/farmers/:code/bvn-check', 'perm:kyc.review', (c) => act(c, `/farmers/${c.params.code}`, async () => {
  const r = await bvnCheck(c.actor, c.params.code, c.body.bvn);
  return { match: 'BVN matches the farmer’s name.', partial: 'BVN found; only part of the name matches. Review before relying on it.', no_match: 'BVN found, but the name does not match.', not_found: 'The provider has no record of this BVN.', error: 'The provider could not be reached; try again later.' }[r];
}));
get('/banks.json', 'perm:finance.approve', async (c) => c.json(PS.connected() ? await PS.banks() : []));
