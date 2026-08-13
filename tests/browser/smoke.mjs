import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startNode(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitFor(url, process, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Process exited before ${url} was ready:\n${process.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${process.output()}`);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-annotate-smoke-'));
const dataPath = path.join(tempDir, 'annotations.jsonl');
const suggestionsPath = path.join(tempDir, 'no-suggestions.jsonl');
const apiPort = await freePort();
const clientPort = await freePort();
await fs.writeFile(
  dataPath,
  `${JSON.stringify({
    document_id: 'smoke-001',
    text: 'Patiënt Jan Peeters.',
    spans: [{ begin: 8, end: 19, text: 'Jan Peeters', label: 'Name:Patient', confirmed: true }],
    metadata: { lang: 'nl' },
    adjudication: { contract_version: 1, sources: ['a.jsonl', 'b.jsonl'], disagreements: [], status: 'agreed' },
  })}\n`,
);

const api = startNode(['server/index.js'], {
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  MEDDEID_ANNOTATIONS_PATH: dataPath,
  MEDDEID_SUGGESTIONS_PATH: suggestionsPath,
});
const client = startNode(
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(clientPort)],
  {
    API_PORT: String(apiPort),
    VITE_PORT: String(clientPort),
    VITE_AUTOSAVE_INTERVAL_MS: '250',
  },
);

let browser;
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`, api),
    waitFor(`http://127.0.0.1:${clientPort}`, client),
  ]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('annotationSettings.autoSaveEnabled', 'false');
  });
  await page.goto(`http://127.0.0.1:${clientPort}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Annotation Search Console' }).waitFor();
  await page.getByText('smoke-001', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: /^Save/ }).first().waitFor();

  const settingsMenu = page.locator('details.settings-menu');
  await page.getByLabel('Settings', { exact: true }).click();
  await settingsMenu.locator('.settings-popover').waitFor();
  const autoSaveToggle = page.getByRole('checkbox', {
    name: 'Auto-save every 2 min (keep tracking state)',
  });
  await autoSaveToggle.uncheck({ force: true });
  await page.getByRole('heading', { name: 'Annotation Search Console' }).click();
  await settingsMenu.locator('.settings-popover').waitFor({ state: 'hidden' });

  const queryInfo = page.locator('details.query-info');
  const saveMenu = page.locator('details.save-menu');
  await page.getByLabel('Show query language rules').click();
  await queryInfo.locator('.query-info-popover').waitFor();
  await queryInfo.getByText('How to search', { exact: true }).waitFor();
  await queryInfo.getByText('doc:', { exact: true }).waitFor();
  await queryInfo.getByText('Document ID', { exact: true }).waitFor();
  await queryInfo.getByText('doc:note-42', { exact: true }).waitFor();
  await page.getByLabel('Save options').click();
  await saveMenu.locator('.save-popover').waitFor();
  await queryInfo.locator('.query-info-popover').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await saveMenu.locator('.save-popover').waitFor({ state: 'hidden' });

  // Confirmation has its own save path. Exercise it first and wait until the
  // response has cleared the dirty state before starting another edit.
  await page.locator('#selected-category').selectOption('Profession');
  await page.getByRole('button', { name: 'Confirm span' }).click();
  await page.getByText('Confirmed smoke-001 span 1', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const reload = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Reload doc'));
    return reload?.disabled === true;
  });

  // Continue editing after the canonical confirmation response and exercise
  // the ordinary single-document save button.
  await page.locator('#selected-category').selectOption('Name');
  await page.locator('#selected-subtype').selectOption('Patient');
  await page.waitForFunction(() => (
    document.querySelector('#selected-category')?.value === 'Name'
      && document.querySelector('#selected-subtype')?.value === 'Patient'
  ));
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByText('Saved smoke-001', { exact: true }).waitFor();
  await page.getByText('1/1 texts annotated', { exact: false }).waitFor();
  await page.getByText('Name:Patient', { exact: true }).first().waitFor();
  await page.waitForFunction(() => {
    const reload = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Reload doc'));
    return reload?.disabled === true;
  });

  // Exercise save-all with an unsaved relabel.
  await page.locator('#selected-category').selectOption('Profession');
  await page.waitForFunction(() => {
    const reload = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Reload doc'));
    return reload && !reload.disabled;
  });
  await page.getByLabel('Save options').click();
  await saveMenu.locator('button').filter({ hasText: 'All unsaved documents' }).click();
  await page.getByText('Saved 1 document', { exact: true }).waitFor();

  // Exercise background autosave, then make another unsaved change and discard
  // it through the document reload path.
  await page.getByLabel('Settings', { exact: true }).click();
  await autoSaveToggle.check({ force: true });
  await page.getByRole('heading', { name: 'Annotation Search Console' }).click();
  await page.locator('#selected-category').selectOption('Name');
  await page.locator('#selected-subtype').selectOption('Patient');
  await page.getByText('Auto-saved 1 document', { exact: true }).waitFor();
  await page.getByLabel('Settings', { exact: true }).click();
  await autoSaveToggle.uncheck({ force: true });
  await page.getByRole('heading', { name: 'Annotation Search Console' }).click();
  await page.locator('#selected-category').selectOption('Date');
  await page.getByRole('button', { name: 'Reload doc' }).click();
  await page.getByText('Reloaded smoke-001; discarded unsaved changes for this document only', { exact: true }).waitFor();
  await page.getByText('Name:Patient', { exact: true }).first().waitFor();

  // Reload the browser and verify persistence from JSONL, not only in-memory
  // state. Reset tracking must preserve the span while clearing completion.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Name:Patient', { exact: true }).first().waitFor();
  const persistedBeforeReset = JSON.parse((await fs.readFile(dataPath, 'utf8')).trim());
  if (persistedBeforeReset.spans[0]?.label !== 'Name:Patient') {
    throw new Error('Saved span did not persist after browser reload');
  }
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Reset tracking' }).click();
  await page.getByText('Reset tracking for 1 annotated documents', { exact: true }).waitFor();
  await page.getByText('0/1 texts annotated', { exact: false }).waitFor();
  const persistedAfterReset = JSON.parse((await fs.readFile(dataPath, 'utf8')).trim());
  if (persistedAfterReset.annotated !== false || persistedAfterReset.spans[0]?.label !== 'Name:Patient') {
    throw new Error('Reset tracking changed persisted spans or failed to clear annotation state');
  }
  if (await page.getByRole('button', { name: 'Freeze gold' }).count()) {
    throw new Error('Primary annotation UI exposed a curation freeze action');
  }
  console.log('Primary annotation browser smoke test passed.');
} finally {
  await browser?.close();
  api.kill('SIGTERM');
  client.kill('SIGTERM');
  await fs.rm(tempDir, { recursive: true, force: true });
}
