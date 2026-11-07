import type { Ctx } from '../lib/http';
import { LABELS, type Settings } from '../lib/settings';
import { Page, Csrf } from './layout';

export function SettingsPage({ c, s, serverAiOff, hasKey, stats }: { c: Ctx; s: Settings; serverAiOff: boolean; hasKey: boolean; stats: any }) {
  const box = (k: keyof Settings) => (
    <label className="check" key={k}><input type="hidden" name={k} value="0" /><input type="checkbox" name={k} value="1" defaultChecked={!!s[k]} /> {LABELS[k]}</label>
  );
  const screened = Number(stats?.screened || 0);
  return (
    <Page c={c} title="Settings">
      <h1>Platform settings</h1>
      <p className="muted">Changes apply at once and are recorded in the audit log.</p>
      <form method="post" action="/admin/settings">
        <Csrf c={c} />
        <section className="card">
          <h2>Farmer phone check</h2>
          <p className="muted">The phone is where farmers get receipt, sale and payment messages and consent codes. Checking it stops records being registered on an agent’s own number. Farmers without a working phone can be confirmed by a witnessed attestation instead.</p>
          {box('phone_check.required')}
          {box('phone_check.sms')}
          {box('phone_check.voice')}
          {box('phone_check.attested')}
        </section>
        <section className="card">
          <h2>AI checks</h2>
          <p className="muted">Reads each ID photo and face photo before a person reviews it, and flags problems (unreadable, wrong name, copy of a copy, expired). It never approves or rejects and does not compare faces. Photos are sent to Anthropic’s API for this; switch it off to keep them on the server only.</p>
          <label className="field"><span>{LABELS['kyc.ai_mode']}</span>
            <select name="kyc.ai_mode" defaultValue={s['kyc.ai_mode']}><option value="assist">On: show findings to the reviewer</option><option value="off">Off</option></select>
          </label>
          <label className="field"><span>{LABELS['intake.ai_check']}</span>
            <select name="intake.ai_check" defaultValue={s['intake.ai_check']}><option value="assist">On: flag deliveries whose photos disagree with the typed numbers</option><option value="off">Off</option></select>
          </label>
          {serverAiOff && <p className="flash info">Switched off in the server settings file (KYC_AI_MODE=off), which overrides this.</p>}
          {!hasKey && <p className="flash info">No ANTHROPIC_API_KEY on this server yet, so the pre-check is skipped.</p>}
          <p className="small">{screened ? `Reviewers agreed with the AI flag on ${stats.agreed} and disagreed on ${stats.disagreed} of ${screened} decided checks (amber flags are not counted).` : 'No decided checks with an AI flag yet.'}</p>
        </section>
        <button className="primary">Save settings</button>
      </form>
    </Page>
  );
}
