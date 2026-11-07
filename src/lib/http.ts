// Request context: parsing, cookies, CSRF, flash messages and responses (modelled on ComboTrader's).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';
import { hmac, randomToken, safeEqual } from './util';
import type { Session, Actor } from './auth';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const MAX_BODY = 1_000_000;

export class Ctx {
  url: URL;
  method: string;
  params: Record<string, string> = {};
  body: Record<string, string> = {};
  cookies: Record<string, string>;
  session: Session | null = null;
  sessionToken = '';
  ip: string;
  csrf: string;
  flash: { type: 'ok' | 'error' | 'info'; msg: string } | null = null;
  done = false;
  private outCookies: string[] = [];

  constructor(public req: IncomingMessage, public res: ServerResponse) {
    this.url = new URL(req.url || '/', config.baseUrl);
    this.method = (req.method || 'GET').toUpperCase();
    this.cookies = parseCookies(req.headers.cookie || '');
    // Behind the local reverse proxy only: trust X-Forwarded-For from loopback.
    const peer = req.socket.remoteAddress || '';
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    this.ip = (fwd && /^(127\.|::1|::ffff:127\.|172\.17\.)/.test(peer)) ? fwd : peer;
    this.sessionToken = this.cookies.sx_sid || '';
    this.csrf = /^[\w-]{20,}$/.test(this.cookies.sx_csrf || '') ? this.cookies.sx_csrf : '';
    if (!this.csrf) { this.csrf = randomToken(24); this.setCookie('sx_csrf', this.csrf, { maxAge: 60 * 60 * 24 }); }
    const f = this.cookies.sx_flash;
    if (f) {
      const [data, sig] = f.split('.');
      if (sig && safeEqual(hmac(data), sig)) { try { this.flash = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { /* ignore */ } }
      this.setCookie('sx_flash', '', { maxAge: 0 });
    }
  }

  get path() { return this.url.pathname; }
  get query() { return Object.fromEntries(this.url.searchParams); }
  get user() { return this.session?.user ?? null; }
  get membership() { return this.session?.active ?? null; }
  get actor(): Actor { if (!this.session) throw new HttpError(401, 'Sign in first.'); return { user: this.session.user, membership: this.session.active, ip: this.ip }; }

  async readBody() {
    if (this.method !== 'POST') return;
    const type = String(this.req.headers['content-type'] || '');
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of this.req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, 'Request too large.'); chunks.push(c as Buffer); }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (type.startsWith('application/x-www-form-urlencoded')) this.body = Object.fromEntries(new URLSearchParams(raw));
    else if (type.startsWith('application/json') && raw) { try { this.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); } }
  }

  /** Same-origin check plus the double-submit token on every form post. */
  checkCsrf() {
    if (this.method !== 'POST') return;
    const origin = String(this.req.headers.origin || '');
    if (origin && origin !== new URL(config.baseUrl).origin && config.production) throw new HttpError(403, 'Cross-site request blocked.');
    const sent = String(this.body._csrf || this.req.headers['x-csrf-token'] || '');
    if (!sent || !safeEqual(sent, this.csrf)) throw new HttpError(403, 'Your form expired. Go back, reload the page and try again.');
  }

  setCookie(name: string, value: string, o: { maxAge?: number; httpOnly?: boolean } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
    if (o.httpOnly !== false) parts.push('HttpOnly');
    if (config.production) parts.push('Secure');
    if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
    this.outCookies.push(parts.join('; '));
  }
  setSessionCookie(token: string) { this.sessionToken = token; this.setCookie('sx_sid', token); }
  clearSessionCookie() { this.sessionToken = ''; this.setCookie('sx_sid', '', { maxAge: 0 }); }
  setFlash(type: 'ok' | 'error' | 'info', msg: string) {
    const data = Buffer.from(JSON.stringify({ type, msg })).toString('base64url');
    this.setCookie('sx_flash', `${data}.${hmac(data)}`, { maxAge: 60 });
  }

  private head(status: number, headers: Record<string, string>) {
    if (this.done) return false;
    this.done = true;
    if (this.outCookies.length) this.res.setHeader('Set-Cookie', this.outCookies);
    this.res.writeHead(status, headers);
    return true;
  }
  html(body: string, status = 200) { if (this.head(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })) this.res.end(body); }
  json(data: unknown, status = 200) { if (this.head(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })) this.res.end(JSON.stringify(data)); }
  text(body: string, status = 200) { if (this.head(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })) this.res.end(body); }
  redirect(to: string, status = 303) { if (this.head(status, { Location: to })) this.res.end(); }
  back(fallback: string, flash?: ['ok' | 'error' | 'info', string]) {
    if (flash) this.setFlash(...flash);
    const ref = String(this.req.headers.referer || '');
    this.redirect(ref.startsWith(config.baseUrl) ? ref.slice(config.baseUrl.length) || fallback : fallback);
  }
}

function parseCookies(s: string) {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}
