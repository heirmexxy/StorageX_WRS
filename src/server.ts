import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { config } from './lib/config';
import { db, openPool } from './lib/db';
import { Ctx, HttpError } from './lib/http';
import { match, type Guard } from './lib/router';
import { loadSession, AuthError } from './lib/auth';
import { can, type Permission } from './lib/rbac';
import { render } from './views/layout';
import { ErrorPage } from './views/auth';
import './routes/auth';
import './routes/admin';

const CSP = ["default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join('; ');
const STATIC: Record<string, string> = { '/app.css': 'text/css; charset=utf-8', '/favicon.ico': 'image/x-icon' };
const PUBLIC = path.resolve('public');

function securityHeaders(res: http.ServerResponse) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Returns null when allowed, otherwise what to do instead. */
function checkGuard(c: Ctx, guard: Guard): { redirect: string } | { status: number; msg: string } | null {
  if (guard === 'public') return null;
  const s = c.session;
  const next = encodeURIComponent(c.path + c.url.search);
  if (!s) return { redirect: `/login?next=${next}` };
  if (guard === 'partial') return null;
  if (!s.twofaOk) return { redirect: s.user.totp_enabled ? `/login/2fa?next=${next}` : `/setup-2fa?next=${next}` };
  if (guard === 'auth') return null;
  const perm = guard.slice(5) as Permission;
  return can(s.active, perm) ? null : { status: 403, msg: 'Your role in this organisation does not allow this page.' };
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  securityHeaders(res);
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    try { await db.val('SELECT 1'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
    catch { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"db":"down"}'); }
    return;
  }
  if (STATIC[urlPath] && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = path.join(PUBLIC, urlPath);
    if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': STATIC[urlPath], 'Cache-Control': 'public, max-age=3600' }); return void fs.createReadStream(file).pipe(res); }
  }

  const c = new Ctx(req, res);
  try {
    if (c.sessionToken) {
      c.session = await loadSession(c.sessionToken);
      if (!c.session) c.clearSessionCookie();
    }
    const m = match(c.method, c.path);
    if (m === 'method') throw new HttpError(405, 'Method not allowed.');
    if (!m) throw new HttpError(404, 'There is no page at this address.');
    c.params = m.params;
    const g = checkGuard(c, m.route.guard);
    if (g && 'redirect' in g) return c.redirect(g.redirect);
    if (g) throw new HttpError(g.status, g.msg);
    await c.readBody();
    c.checkCsrf();
    await m.route.handler(c);
    if (!c.done) throw new Error(`No response from ${c.method} ${c.path}`);
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : e instanceof AuthError ? 403 : 500;
    if (status === 500) console.error(`[error] ${c.method} ${c.path}`, e);
    const message = status === 500 ? 'Sorry, something failed on our side. It has been logged.' : e.message;
    if (!c.done) {
      if (String(req.headers.accept || '').includes('application/json')) c.json({ error: message }, status);
      else c.html(render(h(ErrorPage, { c, status, message })), status);
    }
  }
}

export function start() {
  openPool();
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.end(); } catch { /* closed */ } }); });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.listen(config.port, config.bind, () => console.log(`StorageX WRS listening on http://${config.bind}:${config.port}`));
  return server;
}

if (!process.env.NO_AUTOSTART) start();
