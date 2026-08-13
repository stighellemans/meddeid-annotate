import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAnnotationStore } from '../server/annotation-store.js';

test('store loads, saves, and batch relabels one canonical JSONL file', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob',
        metadata: {
          document_creation_date: '2026-01-02T03:04:05',
          patient: { family_name: 'Alice', birth_date: '1980-05-06' },
        },
        annotated: false,
        adjudication: { status: 'pending', disagreements: [] },
        spans: [
          { begin: 0, end: 5, label: 'Name:Patient' },
          { begin: 10, end: 13, label: 'Name:Caregiver' },
        ],
      })}\n`,
      'utf8',
    );

    const store = createAnnotationStore({ rootDir });
    const bootstrap = await store.getBootstrap();
    assert.equal(bootstrap.documents.length, 1);
    assert.equal(bootstrap.stats.annotatedCount, 0);
    assert.equal(bootstrap.stats.annotatedDocumentCount, 0);
    assert.deepEqual(bootstrap.documents[0].metadata, {
      document_creation_date: '2026-01-02T03:04:05',
      patient: { family_name: 'Alice', birth_date: '1980-05-06' },
    });
    assert.equal(bootstrap.documents[0].spans[1].label, 'Name:Caregiver');
    assert.equal(bootstrap.documents[0].spans[1].text, 'Bob');
    await assert.rejects(
      store.saveDocument('doc1', [{ begin: 6, end: 9, label: '', category: null, subtype: null }]),
      /Cannot save unlabeled annotation/,
    );
    await assert.rejects(
      store.saveDocument('doc1', [{ begin: 6, end: 9, label: 'Name', category: 'Name', subtype: null }]),
      /Cannot save annotation without required subtype/,
    );
    await assert.rejects(
      store.saveDocument('doc1', [{ begin: 6, end: 9, label: 'Organization:Patient' }]),
      /Unsupported label/,
    );

    await store.saveDocument('doc1', bootstrap.documents[0].spans, { annotated: true });
    const saved = await store.getBootstrap();
    assert.equal(saved.documents[0].annotated, true);
    assert.equal(saved.documents[0].adjudication.status, 'pending');
    assert.equal(saved.stats.annotatedDocumentCount, 1);

    await store.batchRelabel({
      label: 'Name:Other',
      matches: [{ document_id: 'doc1', annotationIndex: 1 }],
    });
    const next = await store.getBootstrap();
    assert.equal(next.documents[0].spans[1].label, 'Name:Other');
    assert.equal(next.documents[0].spans[1].category, 'Name');
    assert.equal(next.documents[0].spans[1].subtype, 'Other');

    await store.saveDocument('doc1', next.documents[0].spans);
    const savedAgain = await store.getBootstrap();
    assert.equal(savedAgain.documents[0].annotated, true);
    assert.equal(savedAgain.stats.annotatedCount, 1);

    const reset = await store.resetTracking();
    assert.equal(reset.changed, 1);
    assert.equal(reset.bootstrap.documents[0].annotated, false);
    assert.equal(reset.bootstrap.stats.annotatedCount, 0);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('store rejects unknown labels while importing JSONL', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Main Street',
        spans: [{ begin: 0, end: 11, label: 'Address_Street:Patient' }],
      })}\n`,
      'utf8',
    );
    const store = createAnnotationStore({ rootDir });
    await assert.rejects(store.getBootstrap(), /Unsupported label "Address_Street:Patient"/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('store rejects fields outside the canonical schema', async () => {
  for (const [name, row, expected] of [
    [
      'document alias',
      { doc_id: 'doc1', text: 'Alice', spans: [] },
      /unsupported field "doc_id".*document_id, text, and spans/,
    ],
    [
      'span alias',
      {
        document_id: 'doc1',
        text: 'Alice',
        spans: [{ begin: 0, end: 5, label: 'Name:Patient', Category: 'Name' }],
      },
      /unsupported field "Category".*canonical MedDeID fields/,
    ],
    [
      'retired patient metadata key',
      {
        document_id: 'doc1',
        text: 'Alice',
        metadata: { patient_name: { given_name: 'Alice' } },
        spans: [],
      },
      /retired metadata key.*use patient and caregivers/,
    ],
    [
      'retired caregiver metadata key',
      {
        document_id: 'doc1',
        text: 'Bob',
        metadata: { caregiver_names: [{ given_name: 'Bob' }] },
        spans: [],
      },
      /retired metadata key.*use patient and caregivers/,
    ],
  ]) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
    try {
      const dataDir = path.join(rootDir, 'data');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'annotations.jsonl'), `${JSON.stringify(row)}\n`);
      const store = createAnnotationStore({ rootDir });
      await assert.rejects(store.getBootstrap(), expected, name);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('store can persist edited document text and normalize annotations against it', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob',
        spans: [{ begin: 0, end: 5, label: 'Name:Patient', text: 'Alice' }],
      })}\n`,
      'utf8',
    );

    const store = createAnnotationStore({ rootDir });
    await store.saveDocument(
      'doc1',
      [{ begin: 4, end: 9, label: 'Name:Patient', text: 'stale' }],
      { text: 'Dr. Alice met Bob' },
    );

    const saved = await store.getBootstrap();
    assert.equal(saved.documents[0].text, 'Dr. Alice met Bob');
    assert.equal(saved.documents[0].spans[0].begin, 4);
    assert.equal(saved.documents[0].spans[0].end, 9);
    assert.equal(saved.documents[0].spans[0].text, 'Alice');

    const persisted = JSON.parse((await fs.readFile(path.join(dataDir, 'annotations.jsonl'), 'utf8')).trim());
    assert.equal(persisted.text, 'Dr. Alice met Bob');
    assert.equal(persisted.spans[0].text, 'Alice');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('primary annotation bootstrap exposes only the current annotation state', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob',
        spans: [{ begin: 0, end: 5, label: 'Name:Patient' }],
      })}\n`,
      'utf8',
    );

    const store = createAnnotationStore({ rootDir });
    const bootstrap = await store.getBootstrap();
    assert.equal(Object.hasOwn(bootstrap, 'suggestionsPath'), false);
    assert.equal(Object.hasOwn(bootstrap.documents[0], 'suggestions'), false);
    assert.equal(Object.hasOwn(bootstrap.documents[0].spans[0], 'suggestionReview'), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('separate suggestion files do not create a second annotation type', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob at Clinic',
        spans: [
          { begin: 0, end: 5, label: 'Name:Patient' },
          { begin: 10, end: 13, label: 'Name:Caregiver' },
          { begin: 17, end: 23, label: 'Organization:Healthcare' },
        ],
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dataDir, 'suggestions.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob at Clinic',
        spans: [
          { begin: 0, end: 5, label: 'Name:Patient' },
          { begin: 10, end: 13, label: 'Name:Patient' },
          { begin: 17, end: 22, label: 'Organization:Healthcare' },
          { begin: 6, end: 9, label: 'Profession' },
        ],
      })}\n`,
      'utf8',
    );

    const store = createAnnotationStore({ rootDir });
    const bootstrap = await store.getBootstrap();
    const doc = bootstrap.documents[0];
    assert.equal(Object.hasOwn(doc, 'suggestions'), false);
    assert.equal(Object.hasOwn(doc, 'suggestionStats'), false);
    assert.equal(Object.hasOwn(doc.spans[0], 'suggestionReview'), false);

    await store.saveDocument('doc1', doc.spans, { annotated: true });
    const raw = await fs.readFile(path.join(dataDir, 'annotations.jsonl'), 'utf8');
    const saved = JSON.parse(raw.trim());
    assert.equal(Object.hasOwn(saved.spans[0], 'suggestionReview'), false);
    assert.equal(saved.annotated, true);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('primary annotation does not reinterpret existing spans as review items', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
  try {
    const dataDir = path.join(rootDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'annotations.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        text: 'Alice met Bob',
        spans: [{ begin: 0, end: 5, label: 'Name:Patient', confirmed: true }],
        adjudication: {
          contract_version: 1,
          sources: ['a.jsonl', 'b.jsonl'],
          status: 'agreed',
          disagreements: [],
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(dataDir, 'suggestions.jsonl'),
      `${JSON.stringify({ document_id: 'doc1', text: 'Alice met Bob', spans: [] })}\n`,
    );
    const doc = (await createAnnotationStore({ rootDir }).getBootstrap()).documents[0];
    assert.equal(Object.hasOwn(doc, 'suggestionStats'), false);
    assert.equal(Object.hasOwn(doc.spans[0], 'suggestionReview'), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
