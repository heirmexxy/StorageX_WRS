// Text messages through Termii (the provider ComboTrader already uses). Without an API key, messages are written
// to the server log in development and tests, and refused in production so no one waits for a code that never comes.
import { config } from './config';

export const sentForTests: { to: string; text: string }[] = [];

export async function sendSms(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^\+[1-9]\d{7,14}$/.test(to)) return { ok: false, error: 'bad number' };
  if (!config.termiiKey) {
    if (config.production) return { ok: false, error: 'SMS is not set up on this server yet.' };
    sentForTests.push({ to, text });
    if (process.env.NODE_ENV !== 'test') console.log(`[sms:dev] to ${to}: ${text}`);
    return { ok: true };
  }
  try {
    const r = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ api_key: config.termiiKey, to: to.slice(1), from: config.termiiSender, sms: text, type: 'plain', channel: 'generic' }),
    });
    if (!r.ok) return { ok: false, error: `Termii ${r.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'network error' }; }
}
