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

async function readDocuments(dataPath) {
  return (await fs.readFile(dataPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-annotate-settings-'));
const dataPath = path.join(tempDir, 'annotations.jsonl');
const apiPort = await freePort();
const clientPort = await freePort();
const documents = [
  {
    document_id: 'settings-001',
    text: 'Patient John Smith.',
    annotated: false,
    spans: [{ begin: 8, end: 18, text: 'John Smith', label: 'Name:Patient', confirmed: true }],
    metadata: { lang: 'en-US' },
  },
  {
    document_id: 'settings-002',
    text: 'Patient Mary Stone.',
    annotated: false,
    spans: [{ begin: 8, end: 18, text: 'Mary Stone', label: 'Name:Patient', confirmed: true }],
    metadata: { lang: 'en-GB' },
  },
  {
    document_id: 'settings-003',
    text: 'Patient Alex Green.',
    annotated: false,
    spans: [{ begin: 8, end: 18, text: 'Alex Green', label: 'Name:Patient', confirmed: true }],
    metadata: { lang: 'en-GB' },
  },
];
await fs.writeFile(dataPath, `${documents.map((doc) => JSON.stringify(doc)).join('\n')}\n`);

const api = startNode(['server/index.js'], {
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  MEDDEID_ANNOTATIONS_PATH: dataPath,
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
  await page.getByRole('heading', { name: 'settings-001', exact: true }).waitFor();

  const settingsButton = page.getByLabel('Settings', { exact: true });
  const settingsMenu = page.locator('details.settings-menu');
  const closeSettings = async () => {
    await page.getByRole('heading', { name: 'Document review' }).click();
    await settingsMenu.locator('.settings-popover').waitFor({ state: 'hidden' });
  };

  // Saving a clean but unreviewed document must move to the next unreviewed
  // document. This is the current-gold review workflow that originally failed.
  await settingsButton.click();
  const continueToggle = page.getByRole('checkbox', {
    name: 'Continue to next pending document after saving',
  });
  if (!(await continueToggle.isChecked())) throw new Error('Continue setting should default to enabled');
  await closeSettings();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByText('Saved settings-001; moved to settings-002', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'settings-002', exact: true }).waitFor();

  // Disable automatic continuation while exercising the remaining settings.
  await settingsButton.click();
  await continueToggle.uncheck({ force: true });
  await closeSettings();

  // Undo and redo must open the document whose annotation they change. A
  // global history action should never silently alter a document in the
  // background while the reviewer is looking at another one.
  await page.locator('#selected-category').selectOption('Profession');
  await page.getByRole('button').filter({ hasText: 'settings-003' }).click();
  await page.getByRole('heading', { name: 'settings-003', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('heading', { name: 'settings-002', exact: true }).waitFor();
  if ((await page.locator('#selected-category').inputValue()) !== 'Name') {
    throw new Error('Undo did not restore the previous document annotation');
  }
  await page.getByRole('button').filter({ hasText: 'settings-003' }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('heading', { name: 'settings-002', exact: true }).waitFor();
  if ((await page.locator('#selected-category').inputValue()) !== 'Profession') {
    throw new Error('Redo did not restore the changed document annotation');
  }

  // Discard this deliberately unsaved history exercise so its dirty snapshots
  // do not affect the independent autosave assertions below.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button').filter({ hasText: 'settings-002' }).click();
  await page.locator('#selected-category').selectOption('Profession');

  // State-tag visibility changes both the control state and rendered CSS.
  const changedSpan = page.locator('.inline-span.change-changed');
  await changedSpan.waitFor();
  const stateTagsToggle = page.getByRole('checkbox', { name: 'Show annotation state tags' });
  await settingsButton.click();
  await stateTagsToggle.uncheck({ force: true });
  if ((await changedSpan.evaluate((element) => getComputedStyle(element, '::after').display)) !== 'none') {
    throw new Error('Disabling annotation state tags did not hide the rendered tag');
  }
  await stateTagsToggle.check({ force: true });
  if ((await changedSpan.evaluate((element) => getComputedStyle(element, '::after').display)) === 'none') {
    throw new Error('Enabling annotation state tags did not show the rendered tag');
  }

  // Every reader-width choice must apply immediately. Keep Max selected so its
  // localStorage persistence can be checked after a reload.
  await settingsMenu.getByRole('button', { name: 'Wide', exact: true }).click();
  await page.locator('.app-shell.layout-wide').waitFor();
  await settingsMenu.getByRole('button', { name: 'Balanced', exact: true }).click();
  await page.locator('.app-shell.layout-balanced').waitFor();
  await settingsMenu.getByRole('button', { name: 'Max', exact: true }).click();
  await page.locator('.app-shell.layout-max').waitFor();

  // Text editing must expose the editor, update text and span offsets, and
  // persist both on an explicit save.
  const editTextToggle = page.getByRole('checkbox', { name: 'Edit document text' });
  await editTextToggle.check({ force: true });
  await closeSettings();
  const textEditor = page.getByRole('textbox', { name: 'Edit text for settings-002' });
  await textEditor.fill('Prefix Patient Mary Stone.');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByText('Saved settings-002', { exact: true }).waitFor();
  const afterTextEdit = await readDocuments(dataPath);
  const editedDocument = afterTextEdit.find((doc) => doc.document_id === 'settings-002');
  if (
    editedDocument?.text !== 'Prefix Patient Mary Stone.' ||
    editedDocument?.spans[0]?.begin !== 15 ||
    editedDocument?.spans[0]?.end !== 25 ||
    editedDocument?.spans[0]?.text !== 'Mary Stone'
  ) {
    throw new Error('Text editing did not persist corrected text and shifted span offsets');
  }

  // Autosave must persist edits while preserving the document's unreviewed
  // tracking state.
  await settingsButton.click();
  await editTextToggle.uncheck({ force: true });
  const autoSaveToggle = page.getByRole('checkbox', {
    name: 'Auto-save every 2 min (keep tracking state)',
  });
  await autoSaveToggle.check({ force: true });
  await closeSettings();
  await page.getByRole('button').filter({ hasText: 'settings-003' }).click();
  await page.getByRole('heading', { name: 'settings-003', exact: true }).waitFor();
  await page.locator('#selected-category').selectOption('Profession');
  await page.getByText('Auto-saved 1 document', { exact: true }).waitFor();
  const afterAutoSave = await readDocuments(dataPath);
  const autoSavedDocument = afterAutoSave.find((doc) => doc.document_id === 'settings-003');
  if (autoSavedDocument?.annotated !== false || autoSavedDocument?.spans[0]?.label !== 'Profession') {
    throw new Error('Autosave did not persist edits while preserving tracking state');
  }

  // Set a distinctive combination, reload, and verify every persistent setting.
  await settingsButton.click();
  await autoSaveToggle.uncheck({ force: true });
  await continueToggle.check({ force: true });
  await stateTagsToggle.uncheck({ force: true });
  await editTextToggle.check({ force: true });
  await closeSettings();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.app-shell.layout-max').waitFor();
  await page.getByRole('textbox', { name: 'Edit text for settings-003' }).waitFor();
  await settingsButton.click();
  if (!(await continueToggle.isChecked())) throw new Error('Continue setting did not persist');
  if (await autoSaveToggle.isChecked()) throw new Error('Autosave setting did not persist');
  if (await stateTagsToggle.isChecked()) throw new Error('State-tag setting did not persist');
  if (!(await editTextToggle.isChecked())) throw new Error('Text-edit setting did not persist');

  // Reset tracking must preserve annotations and only clear reviewed state.
  await page.getByRole('button', { name: 'Reset tracking' }).click();
  await page.getByText('Reset tracking for 2 annotated documents', { exact: true }).waitFor();
  await page.getByText('0/3 texts annotated', { exact: false }).waitFor();
  const afterReset = await readDocuments(dataPath);
  if (afterReset.some((doc) => doc.annotated !== false) || afterReset.some((doc) => doc.spans.length !== 1)) {
    throw new Error('Reset tracking changed annotations or failed to clear reviewed state');
  }

  console.log('Primary annotation settings browser test passed.');
} finally {
  await browser?.close();
  api.kill('SIGTERM');
  client.kill('SIGTERM');
  await fs.rm(tempDir, { recursive: true, force: true });
}
