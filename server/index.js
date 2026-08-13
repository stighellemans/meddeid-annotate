import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnnotationStore } from './annotation-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const store = createAnnotationStore({ rootDir });
const app = express();

try {
  await store.load();
} catch (error) {
  console.error('Failed to load annotation data:', error);
  process.exit(1);
}

app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/bootstrap', async (_req, res) => {
  try {
    res.json(await store.getBootstrap());
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load annotations',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.put('/api/documents/:documentId', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.spans)) {
      return res.status(400).json({
        error: 'Failed to save document',
        detail: 'Request body must contain canonical spans; annotations is not accepted',
      });
    }
    const document = await store.saveDocument(
      req.params.documentId,
      req.body.spans,
      req.body ?? {},
    );
    res.json({ document });
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({
      error: 'Failed to save document',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/batch/relabel', async (req, res) => {
  try {
    res.json(await store.batchRelabel(req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({
      error: 'Failed to batch relabel',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/tracking/reset', async (_req, res) => {
  try {
    res.json(await store.resetTracking());
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({
      error: 'Failed to reset tracking',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = app.listen(port, host, () => {
  console.log(`MedDeID Annotate listening on http://${host}:${port}`);
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
