import type { Ctx } from '../lib/http';
import { Page, Csrf, Field } from './layout';

export function LoginPage({ c, error, email }: { c: Ctx; error?: string; email?: string }) {
  return (
    <Page c={c} title="Sign in" bare>
      <section className="card narrow">
        <h1>Sign in</h1>
        {error && <p className="flash error">{error}</p>}
        <form method="post" action="/login">
          <Csrf c={c} />
          <Field label="Email" name="email" type="email" value={email} required autoComplete="username" />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" />
          <button className="primary">Continue</button>
        </form>
        <p className="muted">No account? Ask your administrator for an invitation. Forgotten password? Ask them for a reset link.</p>
      </section>
    </Page>
  );
}

export function TwoFactorPage({ c, error }: { c: Ctx; error?: string }) {
  return (
    <Page c={c} title="Two-step sign-in" bare>
      <section className="card narrow">
        <h1>Enter your code</h1>
        <p>Open your authenticator app and type the 6-digit code for StorageX. Lost your phone? Use one of your recovery codes.</p>
        {error && <p className="flash error">{error}</p>}
        <form method="post" action="/login/2fa">
          <Csrf c={c} />
          <Field label="Code" name="code" required autoComplete="one-time-code" />
          <button className="primary">Sign in</button>
        </form>
        <form method="post" action="/logout"><Csrf c={c} /><button className="link">Cancel</button></form>
      </section>
    </Page>
  );
}

export function SetupTwoFactorPage({ c, secret, qr, error }: { c: Ctx; secret: string; qr: string; error?: string }) {
  return (
    <Page c={c} title="Set up two-step sign-in" bare>
      <section className="card narrow">
        <h1>Set up two-step sign-in</h1>
        <p>Every StorageX account uses a second step, because lenders and farmers rely on what is recorded here.</p>
        <ol>
          <li>Install an authenticator app (Google Authenticator, Microsoft Authenticator or Authy).</li>
          <li>Scan this code, or type the key below.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <img className="qr" src={qr} alt="QR code for your authenticator app" width={200} height={200} />
        <p className="mono key">{secret.replace(/(.{4})/g, '$1 ').trim()}</p>
        {error && <p className="flash error">{error}</p>}
        <form method="post" action="/setup-2fa">
          <Csrf c={c} />
          <Field label="6-digit code" name="code" required inputMode="numeric" autoComplete="one-time-code" />
          <button className="primary">Turn on</button>
        </form>
      </section>
    </Page>
  );
}

export function RecoveryCodesPage({ c, codes }: { c: Ctx; codes: string[] }) {
  return (
    <Page c={c} title="Recovery codes" bare>
      <section className="card narrow">
        <h1>Save your recovery codes</h1>
        <p>Each code works once if you lose your phone. Store them somewhere safe. They will not be shown again.</p>
        <ul className="codes mono">{codes.map((x) => <li key={x}>{x}</li>)}</ul>
        <a className="button primary" href="/app">I have saved them</a>
      </section>
    </Page>
  );
}

export function InvitePage({ c, invite, error }: { c: Ctx; invite: { email: string; full_name: string; org_name: string; role: string; user_exists: boolean }; error?: string }) {
  return (
    <Page c={c} title="Join StorageX" bare>
      <section className="card narrow">
        <h1>Join {invite.org_name}</h1>
        <p>You have been invited as <strong>{invite.role.replace(/_/g, ' ')}</strong> ({invite.email}).</p>
        {error && <p className="flash error">{error}</p>}
        <form method="post">
          <Csrf c={c} />
          {invite.user_exists
            ? <p>You already have a StorageX account. Accept to add this organisation to it.</p>
            : <Field label="Choose a password" name="password" type="password" required autoComplete="new-password" hint="At least 12 characters. A short sentence works well." />}
          <button className="primary">Accept invitation</button>
        </form>
      </section>
    </Page>
  );
}

export function ResetPage({ c, error }: { c: Ctx; error?: string }) {
  return (
    <Page c={c} title="Choose a new password" bare>
      <section className="card narrow">
        <h1>Choose a new password</h1>
        {error && <p className="flash error">{error}</p>}
        <form method="post">
          <Csrf c={c} />
          <Field label="New password" name="password" type="password" required autoComplete="new-password" hint="At least 12 characters." />
          <button className="primary">Save</button>
        </form>
      </section>
    </Page>
  );
}

export function ErrorPage({ c, status, message }: { c: Ctx; status: number; message: string }) {
  return (
    <Page c={c} title={String(status)} bare>
      <section className="card narrow">
        <h1>{status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : 'Something went wrong'}</h1>
        <p>{message}</p>
        <a href="/app">Go to the start page</a>
      </section>
    </Page>
  );
}
