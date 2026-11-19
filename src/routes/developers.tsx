import { get, post } from '../lib/router';
import * as A from '../lib/api';
import { render } from '../views/layout';
import { DevelopersPage, KeysPage } from '../views/developers';
import { act } from './admin';
import { UserError } from '../lib/errors';

get('/developers', 'public', async (c) => c.html(render(<DevelopersPage c={c} />)));
get('/developers/keys', 'auth', async (c) => c.html(render(<KeysPage c={c} keys={await A.keysOf(c.actor)} />)));
// The new key is shown once, in the answer to this post: never in a redirect, a cookie or a log.
post('/developers/keys', 'auth', async (c) => {
  try {
    const k = await A.createKey(c.actor, { name: c.body.name, scopes: c.multi.scopes ?? c.body.scopes, webhook_url: c.body.webhook_url });
    c.res.setHeader('Cache-Control', 'no-store');
    c.html(render(<KeysPage c={c} keys={await A.keysOf(c.actor)} created={k} />));
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    c.setFlash('error', e.message); c.redirect('/developers/keys');
  }
});
post('/developers/keys/:id/webhook', 'auth', async (c) => {
  try {
    const secret = await A.setWebhook(c.actor, c.params.id, c.body.webhook_url);
    c.res.setHeader('Cache-Control', 'no-store');
    if (secret) return c.html(render(<KeysPage c={c} keys={await A.keysOf(c.actor)} created={{ key: '(unchanged: your existing key keeps working)', webhook_secret: secret }} />));
    c.setFlash('ok', 'Webhook address removed.'); c.redirect('/developers/keys');
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    c.setFlash('error', e.message); c.redirect('/developers/keys');
  }
});
post('/developers/keys/:id/test', 'auth', (c) => act(c, '/developers/keys', async () => { await A.testWebhook(c.actor, c.params.id); return 'Test event queued: it is sent within a minute.'; }));
post('/developers/keys/:id/revoke', 'auth', (c) => act(c, '/developers/keys', async () => { await A.revokeKey(c.actor, c.params.id); return 'Key revoked: it stops working at once.'; }));
