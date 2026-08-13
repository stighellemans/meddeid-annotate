import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { LABELS, SUBTYPES_BY_CATEGORY } from '../server/labels.js';

const contract = JSON.parse(
  fs.readFileSync(new URL('../contracts/taxonomy.json', import.meta.url), 'utf8'),
);

test('server taxonomy is the generated meddeid-core contract', () => {
  assert.deepEqual(LABELS, contract.entity_labels);
  assert.deepEqual(SUBTYPES_BY_CATEGORY, contract.subtypes_by_category);
  assert.deepEqual(SUBTYPES_BY_CATEGORY.Organization, ['Healthcare', 'Other']);
  assert.equal(LABELS.includes('Organization:Patient'), false);
});
