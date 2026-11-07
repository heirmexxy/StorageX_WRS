// Text messages and voice-call codes through Termii (the provider ComboTrader already uses). Without an API key,
// messages are written to the server log in development and tests, and refused in production so no one waits
// for a code that never comes.
import { config } from './config';

export const sentForTests: { to: string; text: string; channel: 'sms' | 'voice' }[] = [];
type Result = { ok: boolean; error?: string };

async function termii(path: string, body: Record<string, unknown>): Promise<Result> {
  try {
    const r = await fetch('https://api.ng.termii.com' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ api_key: config.termiiKey, ...body }),
    });
    if (!r.ok) return { ok: false, error: `Termii ${r.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'network error' }; }
}

function devOnly(to: string, text: string, channel: 'sms' | 'voice'): Result {
  if (config.production) return { ok: false, error: 'text messages are not set up on this server yet' };
  sentForTests.push({ to, text, channel });
  if (process.env.NODE_ENV !== 'test') console.log(`[${channel}:dev] to ${to}: ${text}`);
  return { ok: true };
}

export async function sendSms(to: string, text: string): Promise<Result> {
  if (!/^\+[1-9]\d{7,14}$/.test(to)) return { ok: false, error: 'bad number' };
  if (!config.termiiKey) return devOnly(to, text, 'sms');
  return termii('/api/sms/send', { to: to.slice(1), from: config.termiiSender, sms: text, type: 'plain', channel: config.termiiChannel });
}

/** An automated call reads the digits out. Works on any phone, including for people who do not read text messages. */
export async function sendVoiceCode(to: string, code: string): Promise<Result> {
  if (!/^\+[1-9]\d{7,14}$/.test(to) || !/^\d{4,8}$/.test(code)) return { ok: false, error: 'bad number or code' };
  if (!config.termiiKey) return devOnly(to, `voice code ${code}`, 'voice');
  return termii(config.termiiVoicePath, { phone_number: to.slice(1), code: Number(code) });
}
