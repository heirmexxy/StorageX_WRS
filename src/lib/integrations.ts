// What is connected and what is not, for the Settings page. Keys are never shown, only whether they are set.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
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

export function integrations(s: Settings): Integration[] {
  const local = /localhost|127\.0\.0\.1|example|placeholder/.test(config.baseUrl);
  const b = newestBackup(), o = offsiteAt();
  return [
    { name: 'Web address', state: local || !config.baseUrl.startsWith('https://') ? 'warn' : 'ok', status: config.baseUrl,
      affects: 'Receipt QR codes and PDFs, links in farmer texts, invitations, the receipt check page.',
      todo: local ? 'Set BASE_URL to the final https address before printing the first real receipt: printed QR codes keep it forever.' : undefined },
    { name: 'SMS and voice (Termii)', state: config.termiiKey ? (s['notify.sms'] ? 'ok' : 'off') : 'warn', status: config.termiiKey ? (s['notify.sms'] ? 'Connected' : 'Connected; farmer texts switched off below') : 'Not connected',
      affects: 'Phone codes for farmers, delivery and sale agreement codes, every farmer text.',
      todo: config.termiiKey ? undefined : 'Until connected: switch off SMS and voice codes below (vouching in person still works), use paper slips at the gate, and switch off farmer texts.' },
    { name: 'AI checks (Anthropic)', state: config.anthropicKey ? 'ok' : 'off', status: config.anthropicKey ? `Connected (${config.aiModel})` : 'Not connected: people do every check',
      affects: 'First look at ID photos, reading scale and moisture photos, notes on loan requests.' },
    { name: 'USSD (Africa’s Talking)', state: config.ussdKey && s['ussd.enabled'] && s['ussd.code'] ? 'ok' : 'off',
      status: !config.ussdKey ? 'Not connected' : !s['ussd.enabled'] ? 'Connected; switched off below' : s['ussd.code'] ? `Live on ${s['ussd.code']}` : 'Connected; code not entered yet',
      affects: 'Farmers checking produce, loans, sales and prices by USSD.' },
    { name: 'Identity provider', state: config.kycProvider === 'none' ? 'off' : 'ok', status: config.kycProvider === 'none' ? 'None: compliance reviews ID photos by hand' : config.kycProvider,
      affects: 'Only an automatic NIN or BVN match. ID checks work without it.' },
    { name: 'Backups', state: !b ? 'warn' : Date.now() - b > 36 * 3_600_000 ? 'warn' : !o || Date.now() - o > 36 * 3_600_000 ? 'warn' : 'ok',
      status: `${b ? `Last backup ${age(b)}` : 'No backup on this server yet'}; ${o ? `off-site copy ${age(o)}` : 'no off-site copy yet'}`,
      affects: 'Recovering the database and uploaded files if the server is lost.',
      todo: !o ? 'Set up the Google Drive copy (HOSTINGER.md step 13).' : undefined },
  ];
}
