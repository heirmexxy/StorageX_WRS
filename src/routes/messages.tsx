import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import { db } from '../lib/db';
import { config } from '../lib/config';
import { smsKeyword } from '../lib/agents/farmer-helper';
import { sendSms } from '../lib/sms';
import { rateLimit } from '../lib/auth';
import { normPhone } from '../lib/util';
import { safeEqual } from '../lib/util';
import { getSettings } from '../lib/settings';
import * as N from '../lib/notify';
import * as U from '../lib/ussd';
import { render } from '../views/layout';
import { MessagesPage } from '../views/messages';
import { act } from './admin';

// Africa's Talking (or any gateway using its format) posts here. The key in the address is the only proof the
// request came from the gateway, so it is required in production and compared in constant time.
post('/ussd/at', 'webhook', async (c) => {
  const key = c.url.searchParams.get('key') ?? '';
  if (config.production && !config.ussdKey) throw new HttpError(503, 'USSD is not set up on this server.');
  if (config.ussdKey && !safeEqual(key, config.ussdKey)) throw new HttpError(403, 'Forbidden.');
  try { c.text(await U.ussd(c.body)); }
  catch (e) { console.error('[ussd]', e); c.text('END Sorry, StorageX could not answer. Please try again later.'); }
});

// Incoming texts (Africa's Talking: from/text; Termii: sender/message). Farmers text BAL, KUDI, OWO or EGO and get
// what their produce is worth and what they owe, in their approved language. Anything else is ignored.
post('/sms/inbound', 'webhook', async (c) => {
  const key = c.url.searchParams.get('key') ?? '';
  if (!config.smsInboundKey) throw new HttpError(503, 'Incoming texts are not set up on this server.');
  if (!safeEqual(key, config.smsInboundKey)) throw new HttpError(403, 'Forbidden.');
  const b = c.body as any;
  const from = String(b.from ?? b.sender ?? b.msisdn ?? ''), text = String(b.text ?? b.message ?? b.sms ?? '');
  try {
    if (await rateLimit(`smsin:${from}`, 5, 3600)) {
      const reply = await smsKeyword(from, text);
      if (reply) await sendSms(normPhone(from)!, reply);
    }
  } catch (e) { console.error('[sms inbound]', e); }
  c.text('OK');
});

const kitovuOnly = (c: any) => { if (c.membership?.org_kind !== 'kitovu') throw new HttpError(403, 'Kitovu staff only.'); };

get('/admin/messages', 'perm:farmers.edit', async (c) => {
  kitovuOnly(c);
  const s = await getSettings();
  c.html(render(<MessagesPage c={c} rows={await N.templateTable()} callbacks={await U.openCallbacks()}
    failed={await db.all(`SELECT m.created_at, m.status, m.error, f.code, f.full_name FROM farmer_messages m JOIN farmers f ON f.id=m.farmer_id
      WHERE m.status='failed' AND m.created_at > now() - interval '7 days' ORDER BY m.created_at DESC LIMIT 50`)}
    usage={await db.all(`SELECT screen, count(*)::int AS n FROM ussd_log WHERE created_at > now() - interval '30 days' AND screen IN ('menu','produce','loans','sales','prices','callback') GROUP BY 1 ORDER BY 2 DESC`)}
    ussdCode={s['ussd.code']} ussdOn={s['ussd.enabled']} />));
});
post('/admin/messages', 'perm:farmers.edit', (c) => act(c, '/admin/messages', async () => { await N.proposeTemplate(c.actor, c.body.event, c.body.language, c.body.body); return 'Proposed. Someone else in Kitovu must approve it before it is used.'; }));
post('/admin/messages/:id/decide', 'perm:farmers.edit', (c) => act(c, '/admin/messages', async () => { const ok = c.body.decision === 'approve'; await N.decideTemplate(c.actor, c.params.id, ok); return ok ? 'Approved: farmers get this wording from now on.' : 'Rejected.'; }));
post('/admin/callbacks/:id', 'perm:farmers.edit', (c) => act(c, '/admin/messages', async () => { await U.handleCallback(c.actor, c.params.id, c.body.note); return 'Marked as called.'; }));
