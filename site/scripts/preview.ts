import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { base, siteRoot } from './content';

if (!process.versions.bun) throw new Error('Production preview requires Bun');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || process.env.SITE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Pass --port <leased-port> or SITE_PORT; preview does not claim a default port');
}
const root = await realpath(process.env.SITE_OUT_DIR || path.join(siteRoot, 'dist'));
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === base.slice(0, -1)) return Response.redirect(new URL(base, url), 308);
    if (!url.pathname.startsWith(base)) return new Response('Not found', { status: 404 });
    let relative: string;
    try { relative = decodeURIComponent(url.pathname.slice(base.length)); }
    catch { return new Response('Bad URL', { status: 400 }); }
    const selected = path.resolve(root, relative || 'index.html');
    if (!selected.startsWith(`${root}${path.sep}`)) return new Response('Not found', { status: 404 });
    const candidates = relative.endsWith('/') ? [path.join(selected, 'index.html')]
      : [selected, `${selected}.html`, path.join(selected, 'index.html')];
    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate);
        if (!canonical.startsWith(`${root}${path.sep}`)) continue;
        const file = Bun.file(canonical);
        if ((await file.stat()).isFile()) return new Response(file);
      } catch { /* Real static 404: never fall back to an SPA shell. */ }
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Production output: Bun ${Bun.version}; http://127.0.0.1:${server.port}${base}`);
