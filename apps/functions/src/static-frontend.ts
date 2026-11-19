import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Handler } from './http-server.js';

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
export function staticFrontend(directory: string, webOrigin: string, apiOrigin: string, api: Handler): Handler {
  const web = new URL(webOrigin);
  const hosts = new Set([`localhost:${web.port}`, `127.0.0.1:${web.port}`]);
  const root = resolve(directory);
  const canonicalRoot = realpath(root).catch(() => undefined);
  return async request => {
    const url = new URL(request.url);
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    const error = (status: number) => Response.json({ error: status === 403 ? 'Only the configured local origin is allowed.' : 'File or route unavailable.' }, { status, headers });
    if (!hosts.has(url.host) || (request.headers.has('origin') && request.headers.get('origin') !== webOrigin)) return error(403);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = new URL(`${url.pathname}${url.search}`, apiOrigin);
      return api(new Request(target, request));
    }
    if (!['GET', 'HEAD'].includes(request.method)) { headers.set('Allow', 'GET, HEAD'); return error(405); }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return error(400); }
    if (/[\\\u0000]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) return error(404);
    const extension = extname(pathname);
    if (extension && !types[extension]) return error(404);
    const file = extension ? resolve(root, `.${pathname}`) : resolve(root, 'index.html');
    if (!file.startsWith(`${root}${sep}`)) return error(404);
    try {
      const actual = await realpath(file);
      const canonical = await canonicalRoot;
      if (!canonical || !actual.startsWith(`${canonical}${sep}`)) return error(404);
      const body = await readFile(actual);
      headers.set('Content-Type', types[extname(file)]!);
      if (pathname.startsWith('/assets/') && /-[\w-]{8,}\.[a-z0-9]+$/.test(pathname)) headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(request.method === 'HEAD' ? null : body, { headers });
    } catch { return error(404); }
  };
}
