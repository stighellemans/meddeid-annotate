import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceRouter } from './workspace-router.js';
import { createAnnotationRouter } from './annotation-router.js';
import { createAnnotationStore } from './annotation-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const browserUrl = process.env.MEDDEID_BROWSER_URL || `http://${browserHost}:${port}`;

const app = express();
app.use(express.json({ limit: '32mb' }));
const legacy = !process.env.MEDDEID_WORKSPACE_DIR &&
  (process.env.MEDDEID_ANNOTATIONS_PATH || process.env.DEID_ANNOTATIONS_PATH || fs.existsSync(path.join(rootDir, 'data/annotations.jsonl')));
if (legacy) {
  const store = createAnnotationStore({ rootDir });
  await store.load();
  app.get('/api/workspace', (_req, res) => res.json({ mode: 'legacy' }));
  app.use('/api', createAnnotationRouter({ store }));
} else {
  app.use('/api', await createWorkspaceRouter({ rootDir, kind: 'annotate' }));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API action.' }));
const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = app.listen(port, host, () => {
  console.log(`MedDeID Annotate listening internally on ${host}:${port}`);
  console.log(`Open in your browser: ${browserUrl}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`API port ${port} is already in use.`);
    console.error(`Stop the process using it, or run with another port: PORT=${port + 1} npm run dev:server`);
  } else {
    console.error('API server failed to start:', error);
  }

  process.exit(1);
});
