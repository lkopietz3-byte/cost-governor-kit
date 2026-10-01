import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8' };
export async function createServer(port = 4320) {
  const base = await realpath(ROOT);
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  };
  return http.createServer(async (request, response) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) { response.writeHead(403, headers); response.end('Use the loopback preview address.'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); response.end(); return; }
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const name = decodeURIComponent(url.pathname);
      if (name.includes('\0') || name.includes('\\')) throw new Error('Invalid path');
      const target = path.resolve(base, '.' + (name === '/' ? '/index.html' : name));
      const resolved = await realpath(target);
      if (!resolved.startsWith(base + path.sep) || !(await stat(resolved)).isFile()) throw new Error('Outside preview root');
      const data = request.method === 'HEAD' ? null : await readFile(resolved);
      response.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream' }); response.end(data);
    } catch { response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Preview file unavailable.'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Usage: node tools/serve.mjs [--port 4320]');
  const port = Number(args[1] || 4320);
  if (port < 1 || port > 65535) throw new Error('Choose a valid port.');
  const server = await createServer(port);
  server.on('error', error => { process.stderr.write(`Preview could not start: ${error.message}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Threshold local preview: http://127.0.0.1:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
