import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

/**
 * Minimal static file handler for the built client (no framework needed).
 * Unknown extension-less paths fall back to index.html (SPA routing).
 */
export function staticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    // normalize + strip leading ../ so requests can never escape the root
    let path = normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    if (!extname(path)) path = '/index.html';

    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      if (!existsSync(join(root, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Client not built yet — run `npm run build` first.');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    });
    createReadStream(file).pipe(res);
  };
}
