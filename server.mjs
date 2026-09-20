// PWD Infrastructure Workflow — HTTP server.
// Zero dependencies: node:http + node:sqlite + node:crypto only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './src/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'Not found', path: urlPath });
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      service: 'pwd-infra-workflow',
      phase: 0,
      node: process.version,
      time: new Date().toISOString(),
    });
  }

  if (url.pathname.startsWith('/api/')) {
    return json(res, 501, { error: 'Not implemented yet', endpoint: url.pathname });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  PWD Infrastructure Workflow`);
  console.log(`  http://localhost:${PORT}\n`);
});
