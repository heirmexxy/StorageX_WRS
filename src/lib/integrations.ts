// What is connected and what is not, for the Settings page. Keys are never shown, only whether they are set.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { smsConnected } from './sms';
const dojahOn = () => !!(config.dojahAppId && config.dojahSecret);
import type { Settings } from './settings';

export interface Integration { name: string; state: 'ok' | 'off' | 'warn'; status: string; affects: string; todo?: string }

const age = (t: number) => { const h = (Date.now() - t) / 3_600_000; return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`; };

function newestBackup() {
  try {
    const files = fs.readdirSync(config.backupDir).filter((f) => f.endsWith('.dump')).map((f) => fs.statSync(path.join(config.backupDir, f)).mtimeMs);
    return files.length ? Math.max(...files) : null;
  } catch { return null; }
}
function offsiteAt() { try { return fs.statSync(path.join(config.backupDir, '.offsite-ok')).mtimeMs; } catch { return null; } }

export interface Live { wareguard: { devices: number; reporting: number; last_at: Date | null; titan_key: boolean }; feed?: { at: Date; data: any } | null }

export function integrations(s: Settings, live?: Live): Integration[] {
  const local = /localhost|127\.0\.0\.1|example|placeholder/.test(config.baseUrl);
  const b = newestBackup(), o = offsiteAt();
  return [
    { name: 'Web address', state: local || !config.baseUrl.startsWith('https://') ? 'warn' : 'ok', status: config.baseUrl,
      affects: 'Receipt QR codes and PDFs, links in farmer texts, invitations, the receipt check page.',
      todo: local ? 'Set BASE_URL to the final https address before printing the first real receipt: printed QR codes keep it forever.' : undefined },
    { name: config.smsProvider === 'africastalking' ? 'SMS (Africa’s Talking) and voice (Termii)' : 'SMS and voice (Termii)', state: smsConnected() ? (s['notify.sms'] ? 'ok' : 'off') : 'warn', status: smsConnected() ? (s['notify.sms'] ? 'Connected' : 'Connected; farmer texts switched off below') : 'Not connected',
      affects: 'Phone codes for farmers, delivery and sale agreement codes, every farmer text.',
      todo: config.termiiKey ? undefined : 'Until connected: switch off SMS and voice codes below (vouching in person still works), use paper slips at the gate, and switch off farmer texts.' },
    { name: 'AI checks (Anthropic)', state: config.anthropicKey ? 'ok' : 'off', status: config.anthropicKey ? `Connected (${config.aiModel})` : 'Not connected: people do every check',
      affects: 'First look at ID photos, reading scale and moisture photos, notes on loan requests.' },
    { name: 'USSD (Africa’s Talking)', state: config.ussdKey && s['ussd.enabled'] && s['ussd.code'] ? 'ok' : 'off',
      status: !config.ussdKey ? 'Not connected' : !s['ussd.enabled'] ? 'Connected; switched off below' : s['ussd.code'] ? `Live on ${s['ussd.code']}` : 'Connected; code not entered yet',
      affects: 'Farmers checking produce, loans, sales and prices by USSD.' },
    (() => { const w = live?.wareguard; const fresh = !!w?.last_at && Date.now() - new Date(w.last_at).getTime() < 3 * 3_600_000; return {
      name: 'WareGuard readings (Titan)', state: fresh ? (w!.reporting < w!.devices ? 'warn' : 'ok') : w?.titan_key ? 'warn' : 'off',
      status: !w?.titan_key ? 'Not connected: no Titan key yet' : !w.devices ? 'Titan key made; no devices sent yet' : `${w.reporting} of ${w.devices} devices reporting; last reading ${w.last_at ? age(new Date(w.last_at).getTime()) : 'never'}`,
      affects: 'Warehouse conditions on Stock watch and the dashboard, WareGuard alerts, and the WareGuard rule for receipt issuers.',
      todo: !w?.titan_key ? 'Create an API key with the wareguard:write permission (API keys, signed in as a Kitovu administrator) and give it to the Titan team with docs/titan.md.' : undefined } as Integration; })(),
    { name: 'Incoming texts', state: config.smsInboundKey ? 'ok' : 'off', status: config.smsInboundKey ? 'Ready at /sms/inbound' : 'Not connected',
      affects: 'Farmers texting BAL, KUDI, OWO or EGO for their balance. The same answer already works on USSD (option 6).',
      todo: config.smsInboundKey ? undefined : 'Set SMS_INBOUND_KEY and point the SMS provider’s incoming-message address to https://<your site>/sms/inbound?key=<that key>.' },
    { name: 'Identity provider (Dojah)', state: dojahOn() ? (config.kycProvider === 'dojah' ? 'ok' : 'warn') : 'off',
      status: !dojahOn() ? 'None: compliance reviews ID photos by hand' : config.kycProvider === 'dojah' ? 'Connected: NIN at identity review, BVN check on the farmer page' : 'Keys set; set KYC_PROVIDER=dojah to use it at identity review',
      affects: 'Automatic NIN and BVN matches. ID checks work without it; numbers are never stored, only the result and last four digits.' },
    { name: 'Payments (Paystack)', state: config.paystackSecret ? 'ok' : 'off', status: config.paystackSecret ? 'Connected: farmer payouts and buyer payment links' : 'Not connected: payouts are made by bank transfer and recorded by hand',
      affects: 'Paying farmers their share of a sale (two people: one asks, another approves), and buyers paying a sale by link.',
      todo: config.paystackSecret ? 'In Paystack: set the webhook to https://<your site>/hooks/paystack, and turn off OTP for transfers.' : undefined },
    { name: 'Live price feed', state: !config.priceFeedUrl ? 'off' : live?.feed?.data?.added != null ? 'ok' : 'warn',
      status: !config.priceFeedUrl ? 'Not connected: prices are entered by the field team' : live?.feed ? `Last read ${age(new Date(live.feed.at).getTime())}: ${live.feed.data?.added ?? 0} new, ${live.feed.data?.skipped ?? 0} skipped${live.feed.data?.http ? ` (failed, HTTP ${live.feed.data.http})` : ''}` : 'Set; not read yet',
      affects: 'Prices waiting for approval each morning. A person still approves every price before it values a loan.' },
    { name: 'Backups', state: !b ? 'warn' : Date.now() - b > 36 * 3_600_000 ? 'warn' : !o || Date.now() - o > 36 * 3_600_000 ? 'warn' : 'ok',
      status: `${b ? `Last backup ${age(b)}` : 'No backup on this server yet'}; ${o ? `off-site copy ${age(o)}` : 'no off-site copy yet'}`,
      affects: 'Recovering the database and uploaded files if the server is lost.',
      todo: !o ? 'Set up the Google Drive copy (HOSTINGER.md step 13).' : undefined },
  ];
}
