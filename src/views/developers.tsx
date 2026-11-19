import type { Ctx } from '../lib/http';
import { ENDPOINTS, EVENT_HELP, WEBHOOK_EXAMPLE } from '../lib/api-spec';
import { SCOPES, scopesFor } from '../lib/api';
import { config } from '../lib/config';
import { Page, Csrf, fmtDate } from './layout';

const base = () => config.baseUrl.replace(/\/$/, '');
const J = (v: unknown) => JSON.stringify(v, null, 2);
const slug = (e: { method: string; path: string }) => `${e.method}-${e.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

const VERIFY_NODE = `import crypto from 'node:crypto';

// rawBody: the request body exactly as received (a string), before JSON parsing.
export function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}`;
const VERIFY_PY = `import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", 0))
    if not t or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`;

/** The public developer guide. */
export function DevelopersPage({ c }: { c: Ctx }) {
  const groups: [string, string[]][] = [
    ['Loan requests and decisions', ['/api/v1/loan-requests', '/api/v1/loan-requests/{id}/decision']],
    ['Loans and funding', ['/api/v1/loans/{loan_no}/allocations', '/api/v1/loans/{loan_no}/disbursement', '/api/v1/loans', '/api/v1/loans/{loan_no}']],
    ['Receipts', ['/api/v1/receipts/{receipt_no}', '/api/v1/receipts/{receipt_no}/value-history']],
    ['Sales, alerts and issuers', ['/api/v1/sales', '/api/v1/sales/{ref}/approve', '/api/v1/alerts', '/api/v1/issuers']],
    ['WareGuard (Titan only)', ['/api/v1/wareguard/devices', '/api/v1/wareguard/readings']],
    ['Your key', ['/api/v1/me']],
  ];
  return (
    <Page c={c} title="StorageX API" wide>
      <div className="docs">
        <nav className="docs-nav" aria-label="On this page">
          <a href="#start">Getting started</a><a href="#model">How funding works</a><a href="#auth">Keys and permissions</a><a href="#conventions">Conventions</a>
          <a href="#flow">A loan, end to end</a><a href="#webhooks">Webhooks</a>
          {groups.map(([g]) => <a key={g} href={`#${g.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{g}</a>)}
          <a href="/api/v1/openapi.json">OpenAPI file</a>
        </nav>
        <article className="docs-body">
          <h1>StorageX API</h1>
          <p className="lead">Lend against warehouse receipts from your own systems: receive loan requests backed by stock you can track, approve them, record payouts, split loans among your users, and follow repayments, sales and alerts as they happen.</p>

          <h2 id="start">Getting started</h2>
          <ol>
            <li>Apply as a <a href="/apply?group=finance">funding partner or lender</a>. Kitovu sets up your organisation, loan product and lending policy with you.</li>
            <li>Your administrator signs in and creates keys under <b>Finance → API keys</b>. Each key acts as the person who created it, so make keys from the accounts of the people whose work the key does.</li>
            <li>Call <code>GET /api/v1/me</code> to check the key, then fetch <code>GET /api/v1/loan-requests</code>.</li>
            <li>Add a webhook address to a key to be told about new requests, repayments and alerts instead of polling.</li>
          </ol>
          <pre><code>{`curl ${base()}/api/v1/loan-requests \\\n  -H "Authorization: Bearer sxk_…"`}</code></pre>

          <h2 id="model">How funding works</h2>
          <p>Your organisation is the <b>lender of record</b> for every loan it approves. StorageX keeps the receipt registry, pledges the receipts to you, values them every day, and makes sure pledged stock leaves the warehouse only through a sale you approve or after the loan is repaid, with you paid first from any sale.</p>
          <p>If your users fund loans (savings, investment or lending apps), you take their money and you are responsible to them: your licence, your disclosures, your know-your-customer checks. On StorageX you can split each loan among your users with <code>POST /loans/&#123;loan_no&#125;/allocations</code>, using <b>your own opaque reference</b> for each user. StorageX then reports each user’s share of every repayment. Never send a user’s name, phone number, email or account number: references that look like phone or account numbers are refused.</p>
          <p>Receipts may come from Kitovu or from a <a href="#sales-alerts-and-issuers">certified receipt issuer</a>. You choose which issuers you accept, and may cap the loan-to-value for each (in the web app, under Receipt issuers).</p>

          <h2 id="auth">Keys and permissions</h2>
          <p>Send the key on every request: <code>Authorization: Bearer sxk_…</code>. Keys are shown once, when created; StorageX keeps only a hash. A key stops working when it is revoked or when the person who made it loses access.</p>
          <p>A key can do only what its permissions allow <i>and</i> what its creator’s role allows. The same rules as the web app apply: the person who approved a loan cannot record its disbursement, so use two keys, made by two people, one with <code>loans:decide</code> and one with <code>loans:disburse</code>.</p>
          <table><thead><tr><th>Permission</th><th>Allows</th></tr></thead>
            <tbody>{Object.entries(SCOPES).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>)}</tbody></table>

          <h2 id="conventions">Conventions</h2>
          <ul>
            <li>JSON in and out. Money is a whole number of <b>kobo</b> (₦1 = 100 kobo). Dates are <code>YYYY-MM-DD</code> (Lagos time); times are ISO 8601 in UTC. Rates are basis points (250 = 2.5%).</li>
            <li><b>Errors</b>: <code>{'{ "error": "…" }'}</code> with 400 (not possible as asked; the message says why, in words you can show your staff), 401 (key missing or revoked), 403 (permission), 404 (not found or not yours), 422 (idempotency key reused for a different request), 429 (rate limit).</li>
            <li><b>Retries</b>: every POST accepts an <code>Idempotency-Key</code> header (8–100 characters). Repeat a request with the same key and you get the first answer back, marked <code>Idempotent-Replayed: true</code>, and nothing happens twice.</li>
            <li><b>Limits</b>: 600 requests a minute per key.</li>
          </ul>

          <h2 id="flow">A loan, end to end</h2>
          <ol>
            <li>Kitovu or an issuer sends a loan request → you get <code>loan_request.created</code>.</li>
            <li>Your credit service reads it (<code>GET /loan-requests</code>), including the receipts, their value at storage and today, and the reviewer’s checks, then calls <code>POST /loan-requests/&#123;id&#125;/decision</code>. Approval pledges the receipts to you at once.</li>
            <li>If your users fund it, <code>POST /loans/&#123;loan_no&#125;/allocations</code>.</li>
            <li>You pay the farmer from your systems, then your payments service calls <code>POST /loans/&#123;loan_no&#125;/disbursement</code> with the transfer reference.</li>
            <li>Watch it: <code>GET /loans/&#123;loan_no&#125;?history=1</code>, and the <code>alert.created</code> webhook for price warnings and margin calls.</li>
            <li>Repayments arrive as <code>loan.repayment</code>, from the farmer or from a sale you approved (<code>sale.proposed</code> → <code>POST /sales/&#123;ref&#125;/approve</code>). Read each user’s share with <code>GET /loans/&#123;loan_no&#125;/allocations</code>. <code>loan.repaid</code> closes it.</li>
          </ol>

          <h2 id="webhooks">Webhooks</h2>
          <p>Set a webhook address (https) on a key. StorageX posts each event as JSON, signs it, and retries for about a day (after 1, 5, 30, 120, 360, 720 and 1,440 minutes) until your server answers 2xx. Events can arrive more than once and out of order: use <code>id</code> to ignore repeats, and fetch the loan or sale for its current state.</p>
          <pre><code>{`POST https://your-server.example/storagex
X-StorageX-Event: loan.repayment
X-StorageX-Delivery: evt_1042
X-StorageX-Signature: t=1764666900,v1=5f2b…

${J(WEBHOOK_EXAMPLE)}`}</code></pre>
          <p>Check the signature before trusting an event: HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> with the key’s webhook secret (shown once, when the address is set), compared with <code>v1</code>. Reject events older than five minutes.</p>
          <pre><code>{VERIFY_NODE}</code></pre>
          <pre><code>{VERIFY_PY}</code></pre>
          <table><thead><tr><th>Event</th><th>When</th></tr></thead>
            <tbody>{Object.entries(EVENT_HELP).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>)}</tbody></table>

          {groups.map(([g, paths]) => (
            <section key={g}>
              <h2 id={g.toLowerCase().replace(/[^a-z]+/g, '-')}>{g}</h2>
              {ENDPOINTS.filter((e) => paths.includes(e.path)).map((e) => (
                <div className="endpoint" key={slug(e)} id={slug(e)}>
                  <h3><span className={`verb ${e.method.toLowerCase()}`}>{e.method}</span> <code>{e.path}</code></h3>
                  <p>{e.summary}.{e.scope ? <> Needs <code>{e.scope}</code>.</> : null}{e.idempotent ? ' Accepts Idempotency-Key.' : ''}</p>
                  {e.detail && <p>{e.detail}</p>}
                  {e.query && <ul>{e.query.map((q) => <li key={q.name}><code>{q.name}</code>: {q.desc}</li>)}</ul>}
                  {e.body != null && <><h4>Request</h4><pre><code>{J(e.body)}</code></pre></>}
                  <h4>Response</h4><pre><code>{J(e.response)}</code></pre>
                </div>
              ))}
            </section>
          ))}
          <p className="muted small">Questions: email Kitovu at the address on your partner agreement. The machine-readable description is at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
        </article>
      </div>
    </Page>
  );
}

export function KeysPage({ c, keys, created }: { c: Ctx; keys: any[]; created?: { key: string; webhook_secret: string | null } | null }) {
  const allowed = scopesFor(String(c.membership?.org_kind));
  return (
    <Page c={c} title="API keys">
      <div className="head"><h1>API keys</h1><a href="/developers">API documentation</a></div>
      {created && (
        <section className="card created-key">
          <h2>Copy this key now</h2>
          <p>It is shown only once. Store it in your server’s secret store; anyone with it can act as you within its permissions.</p>
          <pre><code>{created.key}</code></pre>
          {created.webhook_secret && <><p>Webhook signing secret:</p><pre><code>{created.webhook_secret}</code></pre></>}
        </section>
      )}
      <section className="card">
        <h2>Your keys</h2>
        {keys.length ? (
          <table><thead><tr><th>Name</th><th>Key</th><th>Acts as</th><th>Permissions</th><th>Webhook</th><th>Last used</th><th></th></tr></thead>
            <tbody>{keys.map((k) => (
              <tr key={k.id} className={k.status === 'revoked' ? 'muted' : ''}>
                <td>{k.name}</td><td className="mono">{`sxk_${k.key_prefix}_…`}</td><td>{k.owner}</td><td className="small">{k.scopes.join(', ')}</td>
                <td className="small">{k.webhook_url ? <>{k.webhook_url}{k.failing ? <><br /><span className="bad">{`${k.failing} event(s) failing`}</span></> : null}</> : '—'}</td>
                <td>{k.status === 'revoked' ? `Revoked ${fmtDate(k.revoked_at)}` : k.last_used_at ? fmtDate(k.last_used_at) : 'Never'}</td>
                <td>{k.status === 'active' && <>
                  <form method="post" action={`/developers/keys/${k.id}/webhook`} className="inline"><Csrf c={c} /><input name="webhook_url" type="url" placeholder="https://…" defaultValue={k.webhook_url ?? ''} /> <button>Save address</button></form>
                  {k.webhook_url && <form method="post" action={`/developers/keys/${k.id}/test`} className="inline"><Csrf c={c} /><button className="link">Send a test event</button></form>}
                  <form method="post" action={`/developers/keys/${k.id}/revoke`} className="inline"><Csrf c={c} /><button className="link danger">Revoke</button></form>
                </>}</td>
              </tr>
            ))}</tbody></table>
        ) : <p className="muted">No keys yet.</p>}
      </section>
      <section className="card">
        <h2>Create a key</h2>
        <p className="muted">The key acts as you: it can do only what your role allows. Give it only the permissions the system using it needs. A key that approves loans and a key that records payouts must be made by two different people.</p>
        <form method="post" action="/developers/keys"><Csrf c={c} />
          <label className="field"><span>Name (what uses it)</span><input name="name" required placeholder="Loan approvals service" /></label>
          <fieldset><legend>Permissions</legend>{allowed.map((s) => <label className="check" key={s}><input type="checkbox" name="scopes" value={s} /> <code>{s}</code> {SCOPES[s]}</label>)}</fieldset>
          <label className="field"><span>Webhook address (optional, https)</span><input name="webhook_url" type="url" placeholder="https://api.yourcompany.com/storagex/events" /></label>
          <button className="primary">Create key</button>
        </form>
      </section>
    </Page>
  );
}
