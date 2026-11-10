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
          <label className="field"><span>{LABELS['loans.ai_note']}</span>
            <select name="loans.ai_note" defaultValue={s['loans.ai_note']}><option value="assist">On: add a note to each loan request</option><option value="off">Off (checks still run)</option></select>
          </label>
          {serverAiOff && <p className="flash info">Switched off in the server settings file (KYC_AI_MODE=off), which overrides this.</p>}
          {!hasKey && <p className="flash info">No ANTHROPIC_API_KEY on this server yet, so the pre-check is skipped.</p>}
          <p className="small">{screened ? `Reviewers agreed with the AI flag on ${stats.agreed} and disagreed on ${stats.disagreed} of ${screened} decided checks (amber flags are not counted).` : 'No decided checks with an AI flag yet.'}</p>
        </section>
        <section className="card">
          <h2>Stock control</h2>
          <label className="field"><span>{LABELS['stock.tolerance_pct']}</span><input name="stock.tolerance_pct" type="number" step="0.1" min="0" max="5" defaultValue={String(s['stock.tolerance_pct'])} /><small>Stored grain loses a little weight; a shortfall above this is flagged as serious.</small></label>
          <label className="field"><span>{LABELS['stock.count_every_days']}</span><input name="stock.count_every_days" type="number" min="1" max="180" defaultValue={String(s['stock.count_every_days'])} /></label>
        </section>
        <section className="card">
          <h2>Prices and valuation</h2>
          {(['price.window_days', 'price.min_observations', 'price.outlier_pct', 'price.drop_alert_pct'] as const).map((k) => (
            <label className="field" key={k}><span>{LABELS[k]}</span><input name={k} type="number" step="1" defaultValue={String(s[k])} /></label>
          ))}
        </section>
        <section className="card">
          <h2>Kitovu fees on sales</h2>
          <p className="muted">Taken from sale proceeds first, then the lender’s loan, then the farmer’s balance.</p>
          {(['fees.storage_kobo_per_kg_month', 'fees.handling_kobo_per_kg', 'fees.sale_commission_bp'] as const).map((k) => (
            <label className="field" key={k}><span>{LABELS[k]}</span><input name={k} type="number" step="1" defaultValue={String(s[k])} /></label>
          ))}
        </section>
        <section className="card">
          <h2>Farmer messages and USSD</h2>
          <p className="muted">Texts about deliveries, receipts, loans, releases and payments always go: they are how a farmer spots a mistake or fraud. Reminders can be switched off here or for one farmer. Wording and translations are under <a href="/admin/messages">Farmer messages</a>.</p>
          {box('notify.reminders')}
          <label className="field"><span>{LABELS['notify.due_days']}</span><input name="notify.due_days" type="number" min="1" max="30" defaultValue={String(s['notify.due_days'])} /></label>
          {box('ussd.enabled')}
          <label className="field"><span>{LABELS['ussd.code']}</span><input name="ussd.code" defaultValue={s['ussd.code']} placeholder="*347*123#" /></label>
        </section>
        <button className="primary">Save settings</button>
      </form>
    </Page>
  );
}
