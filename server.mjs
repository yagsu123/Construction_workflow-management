// PWD Infrastructure Workflow — HTTP server.
// Zero dependencies: node:http + node:sqlite + node:crypto only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './src/config.js';
import { handleApi, json } from './src/api.js';
import { WorkflowError } from './src/workflow.js';
import { getDb } from './src/db.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (err instanceof WorkflowError) return json(res, err.status, { error: err.message });
      console.error(`  ! ${req.method} ${url.pathname}`, err);
      return json(res, 500, { error: 'Internal error', detail: err.message });
    }
    return;
  }

  return serveStatic(req, res, url.pathname);
});

getDb(); // fail fast if the database cannot be opened

server.listen(PORT, () => {
  console.log(`\n  PWD Infrastructure Workflow`);
  console.log(`  http://localhost:${PORT}\n`);
});
