import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORY_VALUES, SUBTYPE_VALUES } from './labels.js';

export const LABEL_SHORTCUTS_SCHEMA_VERSION = 'meddeid.label-shortcuts.v1';
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../config/label-shortcuts.json', import.meta.url),
);

const TOP_LEVEL_FIELDS = new Set(['schema_version', 'category_shortcuts', 'subtype_shortcuts']);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`label shortcut config ${field} must be an object`);
  }
}

function normalizeShortcutMap(rawMap, field, allowedValues, usedShortcuts) {
  assertPlainObject(rawMap, field);
  const allowed = new Set(allowedValues);
  const normalized = {};

  for (const [value, rawShortcut] of Object.entries(rawMap)) {
    if (!allowed.has(value)) {
      throw new ValueError(
        `label shortcut config ${field} contains unknown taxonomy value ${JSON.stringify(value)}`,
      );
    }
    if (typeof rawShortcut !== 'string' || rawShortcut.trim() !== rawShortcut) {
      throw new TypeError(
        `label shortcut config ${field}.${value} must be one non-whitespace character`,
      );
    }

    const shortcut = rawShortcut.toLowerCase();
    if (Array.from(shortcut).length !== 1 || shortcut.trim().length === 0) {
      throw new TypeError(
        `label shortcut config ${field}.${value} must be one non-whitespace character`,
      );
    }
    if (usedShortcuts.has(shortcut)) {
      throw new ValueError(`label shortcut ${JSON.stringify(shortcut)} is assigned more than once`);
    }

    usedShortcuts.add(shortcut);
    normalized[value] = shortcut;
  }

  return Object.freeze(normalized);
}

// JavaScript has no built-in ValueError, but distinguishing malformed values
// from malformed container types keeps startup errors precise for operators.
class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

export function parseLabelShortcuts(rawConfig) {
  assertPlainObject(rawConfig, 'root');

  const unknownFields = Object.keys(rawConfig).filter((field) => !TOP_LEVEL_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ValueError(`label shortcut config has unknown fields: ${unknownFields.sort().join(', ')}`);
  }
  if (rawConfig.schema_version !== LABEL_SHORTCUTS_SCHEMA_VERSION) {
    throw new ValueError(
      `unsupported label shortcut schema ${JSON.stringify(rawConfig.schema_version)}; expected ${LABEL_SHORTCUTS_SCHEMA_VERSION}`,
    );
  }

  const usedShortcuts = new Set();
  const categoryShortcuts = normalizeShortcutMap(
    rawConfig.category_shortcuts,
    'category_shortcuts',
    CATEGORY_VALUES,
    usedShortcuts,
  );
  const subtypeShortcuts = normalizeShortcutMap(
    rawConfig.subtype_shortcuts,
    'subtype_shortcuts',
    SUBTYPE_VALUES,
    usedShortcuts,
  );

  return Object.freeze({
    schemaVersion: LABEL_SHORTCUTS_SCHEMA_VERSION,
    categoryShortcuts,
    subtypeShortcuts,
  });
}

export async function loadLabelShortcuts({ rootDir = process.cwd(), configPath } = {}) {
  const selectedPath = configPath
    ? path.resolve(rootDir, configPath)
    : DEFAULT_CONFIG_PATH;

  let rawConfig;
  try {
    rawConfig = JSON.parse(await fs.readFile(selectedPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValueError(`invalid label shortcut JSON in ${selectedPath}: ${error.message}`);
    }
    throw error;
  }

  return Object.freeze({
    ...parseLabelShortcuts(rawConfig),
    path: selectedPath,
  });
}

export function applyLabelShortcuts(values, shortcuts) {
  return Object.freeze(
    values.map((value) => Object.freeze({ value, key: shortcuts[value] ?? null })),
  );
}
