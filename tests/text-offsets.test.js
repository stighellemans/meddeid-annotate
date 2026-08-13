import assert from 'node:assert/strict';
import test from 'node:test';

import { adjustAnnotationsForTextChange } from '../src/text-offsets.js';

function span(begin, end, extra = {}) {
  return {
    begin,
    end,
    label: 'Name:Patient',
    text: '',
    category: 'Name',
    subtype: 'Patient',
    confirmed: true,
    ...extra,
  };
}

test('text edits shift a span after an insertion before it', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice Bob',
    newText: 'Hey Hello Alice Bob',
    annotations: [span(6, 11, { text: 'Alice' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].begin, 10);
  assert.equal(annotations[0].end, 15);
  assert.equal(annotations[0].text, 'Alice');
  assert.equal(annotations[0]._changeStatus, undefined);
  assert.equal(annotations[0].confirmed, true);
});

test('text edits resize a span when inserting inside it', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice',
    newText: 'Hello AliXce',
    annotations: [span(6, 11, { text: 'Alice' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].begin, 6);
  assert.equal(annotations[0].end, 12);
  assert.equal(annotations[0].text, 'AliXce');
  assert.equal(annotations[0]._changeStatus, 'changed');
  assert.equal(annotations[0].confirmed, false);
});

test('text edits keep an exact span replacement over the replacement text', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice',
    newText: 'Hello Bob',
    annotations: [span(6, 11, { text: 'Alice' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].begin, 6);
  assert.equal(annotations[0].end, 9);
  assert.equal(annotations[0].text, 'Bob');
  assert.equal(annotations[0]._changeStatus, 'changed');
});

test('text edits resize a span when deleting inside it', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice',
    newText: 'Hello Alce',
    annotations: [span(6, 11, { text: 'Alice' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].begin, 6);
  assert.equal(annotations[0].end, 10);
  assert.equal(annotations[0].text, 'Alce');
  assert.equal(annotations[0]._changeStatus, 'changed');
});

test('text edits mark a saved span deleted when the edit removes it completely', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice Bob',
    newText: 'Hello  Bob',
    annotations: [span(6, 11, { text: 'Alice' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0]._changeStatus, 'deleted');
  assert.equal(annotations[0].confirmed, false);
});

test('text edits remove an unsaved added span when the edit removes it completely', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Hello Alice Bob',
    newText: 'Hello  Bob',
    annotations: [span(6, 11, { text: 'Alice', _changeStatus: 'added' })],
  });

  assert.deepEqual(annotations, []);
});

test('text edits keep surviving span text when the edit crosses a span boundary', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'ABCDE',
    newText: 'XYDE',
    annotations: [span(1, 4, { text: 'BCD' })],
  });

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].begin, 2);
  assert.equal(annotations[0].end, 3);
  assert.equal(annotations[0].text, 'D');
  assert.equal(annotations[0]._changeStatus, 'changed');
});

test('text edits after one span shift only later spans', () => {
  const annotations = adjustAnnotationsForTextChange({
    oldText: 'Alice met Bob',
    newText: 'Alice met quietly Bob',
    annotations: [span(0, 5, { text: 'Alice' }), span(10, 13, { text: 'Bob' })],
  });

  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].begin, 0);
  assert.equal(annotations[0].end, 5);
  assert.equal(annotations[0].text, 'Alice');
  assert.equal(annotations[1].begin, 18);
  assert.equal(annotations[1].end, 21);
  assert.equal(annotations[1].text, 'Bob');
});
