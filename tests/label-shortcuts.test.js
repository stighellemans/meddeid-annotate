import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LABEL_SHORTCUTS_SCHEMA_VERSION,
  loadLabelShortcuts,
  parseLabelShortcuts,
} from '../server/label-shortcuts.js';
import { createAnnotationStore } from '../server/annotation-store.js';

test('shipped label shortcuts preserve the existing Dutch-oriented bindings', async () => {
  const shortcuts = await loadLabelShortcuts();

  assert.equal(shortcuts.schemaVersion, LABEL_SHORTCUTS_SCHEMA_VERSION);
  assert.equal(shortcuts.categoryShortcuts.Age_Birthdate, 'l');
  assert.equal(shortcuts.categoryShortcuts.Profession, 'b');
  assert.equal(shortcuts.subtypeShortcuts.Caregiver, 'z');
  assert.equal(shortcuts.subtypeShortcuts.Other, 'f');
});

test('annotation bootstrap uses a custom, partial label shortcut config', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-shortcuts-'));
  try {
    await fs.mkdir(path.join(rootDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'data', 'annotations.jsonl'), '');
    await fs.writeFile(
      path.join(rootDir, 'shortcuts.json'),
      JSON.stringify({
        schema_version: LABEL_SHORTCUTS_SCHEMA_VERSION,
        category_shortcuts: { Name: 'J', Age_Birthdate: 'g' },
        subtype_shortcuts: { Patient: 'p', Caregiver: 'c' },
      }),
    );

    const store = createAnnotationStore({
      rootDir,
      labelShortcutsConfigPath: 'shortcuts.json',
    });
    await store.load();
    const bootstrap = await store.getBootstrap();

    assert.equal(bootstrap.categories.find(({ value }) => value === 'Name').key, 'j');
    assert.equal(bootstrap.categories.find(({ value }) => value === 'Age_Birthdate').key, 'g');
    assert.equal(bootstrap.categories.find(({ value }) => value === 'Profession').key, null);
    assert.equal(bootstrap.subtypes.find(({ value }) => value === 'Caregiver').key, 'c');
    assert.equal(bootstrap.subtypes.find(({ value }) => value === 'Other').key, null);
    assert.equal(bootstrap.labelShortcutsConfig.path, path.join(rootDir, 'shortcuts.json'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('label shortcut config rejects unknown taxonomy values and duplicate keys', () => {
  assert.throws(
    () => parseLabelShortcuts({
      schema_version: LABEL_SHORTCUTS_SCHEMA_VERSION,
      category_shortcuts: { Unknown: 'u' },
      subtype_shortcuts: {},
    }),
    /unknown taxonomy value "Unknown"/,
  );

  assert.throws(
    () => parseLabelShortcuts({
      schema_version: LABEL_SHORTCUTS_SCHEMA_VERSION,
      category_shortcuts: { Name: 'n' },
      subtype_shortcuts: { Patient: 'N' },
    }),
    /shortcut "n" is assigned more than once/,
  );
});

test('label shortcut config rejects invalid schema and multi-character keys', () => {
  assert.throws(
    () => parseLabelShortcuts({
      schema_version: 'meddeid.label-shortcuts.v2',
      category_shortcuts: {},
      subtype_shortcuts: {},
    }),
    /unsupported label shortcut schema/,
  );

  assert.throws(
    () => parseLabelShortcuts({
      schema_version: LABEL_SHORTCUTS_SCHEMA_VERSION,
      category_shortcuts: { Name: 'nn' },
      subtype_shortcuts: {},
    }),
    /must be one non-whitespace character/,
  );
});
