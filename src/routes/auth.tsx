import { get, post } from '../lib/router';
import type { Ctx } from '../lib/http';
import { HttpError } from '../lib/http';
import * as A from '../lib/auth';
import { otpauthUrl } from '../lib/totp';
import { qrDataUri } from '../lib/qr';
import { render } from '../views/layout';
import { LoginPage, TwoFactorPage, SetupTwoFactorPage, SetupSmsPage, RecoveryCodesPage, InvitePage, ResetPage } from '../views/auth';
import { smsAllowed } from '../lib/rbac';

const auditActor = (c: Ctx) => ({ userId: c.user?.id ?? null, label: `user:${c.user?.email ?? 'anonymous'}`, ip: c.ip });
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(n) ? n : '/app');

get('/', 'public', (c) => c.redirect(c.session?.twofaOk ? '/app' : '/login'));

get('/login', 'public', (c) => {
  if (c.session?.twofaOk) return c.redirect('/app');
  c.html(render(<LoginPage c={c} />));
});

post('/login', 'public', async (c) => {
  try {
    const user = await A.login(c.body.email, c.body.password, c.ip);
    if (c.session) await A.revokeSession(c.session.id);
    c.setSessionCookie(await A.createSession(user.id, c.ip, String(c.req.headers['user-agent'] || '')));
    const next = encodeURIComponent(safeNext(c.query.next));
    c.redirect(user.factor ? `/login/2fa?next=${next}` : `/setup-2fa?next=${next}`);
  } catch (e) {
    if (e instanceof A.AuthError) return c.html(render(<LoginPage c={c} error={e.message} email={c.body.email} />), 401);
    throw e;
  }
});

get('/login/2fa', 'partial', (c) => {
  if (c.session!.twofaOk) return c.redirect('/app');
  if (!c.user!.factor) return c.redirect('/setup-2fa');
  c.html(render(<TwoFactorPage c={c} />));
});

post('/login/2fa/sms', 'partial', async (c) => {
  if (c.session!.twofaOk) return c.redirect('/app');
  if (c.user!.factor !== 'sms') return c.redirect('/login/2fa');
  try { await A.sendLoginSms(c.user!.id); c.html(render(<TwoFactorPage c={c} sent />)); }
  catch (e) { if (e instanceof A.AuthError) return c.html(render(<TwoFactorPage c={c} error={e.message} />), 429); throw e; }
});

post('/login/2fa', 'partial', async (c) => {
  const s = c.session!;
  if (s.twofaOk) return c.redirect('/app');
  try {
    if (!(await A.verifySecondFactor(s.user.id, c.body.code, auditActor(c)))) return c.html(render(<TwoFactorPage c={c} error="That code did not work. Try the newest code from your app." />), 401);
  } catch (e) {
    if (e instanceof A.AuthError) return c.html(render(<TwoFactorPage c={c} error={e.message} />), 429);
    throw e;
  }
  c.setSessionCookie(await A.completeSecondFactor(c.sessionToken, auditActor(c)));
  c.redirect(safeNext(c.query.next));
});

get('/setup-2fa', 'partial', async (c) => {
  if (c.user!.factor) return c.redirect('/login/2fa');
  const secret = (await A.pendingTotpSecret(c.user!.id)) || (await A.beginTotpSetup(c.user!.id));
  c.html(render(<SetupTwoFactorPage c={c} secret={secret} qr={qrDataUri(otpauthUrl(secret, c.user!.email))} smsOption={smsAllowed(c.session!.memberships)} />));
});

// SMS codes: only for low-risk roles (see rbac.smsAllowed), chosen while setting up the second step.
const smsGate = (c: Ctx) => { if (c.user!.factor) { c.redirect('/login/2fa'); return false; } if (!smsAllowed(c.session!.memberships)) throw new HttpError(403, 'Your role needs an authenticator app.'); return true; };
get('/setup-2fa/sms', 'partial', (c) => { if (smsGate(c)) c.html(render(<SetupSmsPage c={c} phone={c.user!.phone_e164 ?? ''} />)); });
post('/setup-2fa/sms/send', 'partial', async (c) => {
  if (!smsGate(c)) return;
  try { const phone = await A.sendLoginSms(c.user!.id, c.body.phone); c.html(render(<SetupSmsPage c={c} phone={phone} sent />)); }
  catch (e) { if (e instanceof A.AuthError) return c.html(render(<SetupSmsPage c={c} phone={c.body.phone} error={e.message} />), 400); throw e; }
});
post('/setup-2fa/sms', 'partial', async (c) => {
  if (!smsGate(c)) return;
  try {
    const codes = await A.confirmSmsEnrolment(c.user!.id, c.body.code, auditActor(c));
    c.setSessionCookie(await A.completeSecondFactor(c.sessionToken, auditActor(c)));
    c.html(render(<RecoveryCodesPage c={c} codes={codes} />));
  } catch (e) { if (e instanceof A.AuthError) return c.html(render(<SetupSmsPage c={c} sent error={e.message} />), 400); throw e; }
});

post('/setup-2fa', 'partial', async (c) => {
  if (c.user!.factor) return c.redirect('/login/2fa');
  try {
    const codes = await A.confirmTotp(c.user!.id, c.body.code, auditActor(c));
    c.setSessionCookie(await A.completeSecondFactor(c.sessionToken, auditActor(c)));
    c.html(render(<RecoveryCodesPage c={c} codes={codes} />));
  } catch (e) {
    if (!(e instanceof A.AuthError)) throw e;
    const secret = (await A.pendingTotpSecret(c.user!.id))!;
    c.html(render(<SetupTwoFactorPage c={c} secret={secret} qr={qrDataUri(otpauthUrl(secret, c.user!.email))} error={e.message} />), 400);
  }
});

post('/logout', 'partial', async (c) => {
  await A.revokeSession(c.session!.id);
  c.clearSessionCookie();
  c.redirect('/login');
});

get('/invite/:token', 'public', async (c) => {
  const invite = await A.findInvite(c.params.token);
  if (!invite) throw new HttpError(404, 'This invitation link is not valid any more. Ask for a new one.');
  c.html(render(<InvitePage c={c} invite={invite} />));
});

post('/invite/:token', 'public', async (c) => {
  try {
    await A.acceptInvite(c.params.token, c.body.password ?? null, c.ip);
    if (c.session) { await A.revokeSession(c.session.id); c.clearSessionCookie(); }
    c.setFlash('ok', 'Invitation accepted. Sign in to continue.');
    c.redirect('/login');
  } catch (e) {
    if (!(e instanceof A.AuthError)) throw e;
    const invite = await A.findInvite(c.params.token);
    if (!invite) throw new HttpError(404, e.message);
    c.html(render(<InvitePage c={c} invite={invite} error={e.message} />), 400);
  }
});

get('/reset/:token', 'public', (c) => c.html(render(<ResetPage c={c} />)));
post('/reset/:token', 'public', async (c) => {
  try {
    await A.resetPassword(c.params.token, c.body.password, c.ip);
    c.setFlash('ok', 'Password changed. Sign in with the new one.');
    c.redirect('/login');
  } catch (e) {
    if (e instanceof A.AuthError) return c.html(render(<ResetPage c={c} error={e.message} />), 400);
    throw e;
  }
});
