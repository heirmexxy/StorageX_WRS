// Tiny router with access guards. Guards run before the handler:
//   public    anyone
//   partial   signed in with password, still needs the second factor
//   auth      fully signed in (password + second factor)
//   perm:X    fully signed in, and the active membership holds permission X
import type { Ctx } from './http';
import type { Permission } from './rbac';

export type Handler = (c: Ctx) => unknown | Promise<unknown>;
export type Guard = 'public' | 'webhook' | 'partial' | 'auth' | `perm:${Permission}`;
export interface Route { method: string; re: RegExp; keys: string[]; guard: Guard; handler: Handler }

const routes: Route[] = [];

function compile(pattern: string) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}
export function route(method: 'GET' | 'POST', pattern: string, guard: Guard, handler: Handler) { routes.push({ method, ...compile(pattern), guard, handler }); }
export const get = (p: string, g: Guard, h: Handler) => route('GET', p, g, h);
export const post = (p: string, g: Guard, h: Handler) => route('POST', p, g, h);

export function match(method: string, path: string) {
  const m = method === 'HEAD' ? 'GET' : method;
  let pathOnly = false;
  for (const r of routes) {
    const res = r.re.exec(path);
    if (!res) continue;
    if (r.method !== m) { pathOnly = true; continue; }
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(res[i + 1]); } catch { params[k] = res[i + 1]; } });
    return { route: r, params };
  }
  return pathOnly ? ('method' as const) : null;
}
