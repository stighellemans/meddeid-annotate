import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CATEGORIES,
  LABELS,
  SUBTYPES,
  SUBTYPES_BY_CATEGORY,
  composeLabel,
  splitLabel,
} from './labels.js';

const DEFAULT_DATA_PATH = process.env.MEDDEID_ANNOTATIONS_PATH
  || process.env.DEID_ANNOTATIONS_PATH
  || path.join('data', 'annotations.jsonl');
const DERIVED_ANNOTATION_FIELDS = new Set(['suggestionReview']);
const DOCUMENT_ALIASES = Object.freeze([
  'doc_id',
  'plain_text',
  'annotations',
  'created_dt_tm',
  'birth_dt',
  'name',
  'language',
]);
const SPAN_ALIASES = Object.freeze(['Category', 'Subtype']);

function compareDocIds(a, b) {
  const aMatch = /(\d+)$/.exec(a);
  const bMatch = /(\d+)$/.exec(b);
  if (aMatch && bMatch && Number(aMatch[1]) !== Number(bMatch[1])) {
    return Number(aMatch[1]) - Number(bMatch[1]);
  }
  return a.localeCompare(b);
}

function parseJsonLines(rawText, filePath) {
  return String(rawText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ${filePath} on line ${index + 1}: ${error.message}`);
      }
    });
}

function normalizeAnnotation(rawAnnotation, text) {
  const begin = Number(rawAnnotation?.begin);
  const end = Number(rawAnnotation?.end);
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin) {
    return null;
  }

  const safeBegin = Math.max(0, Math.min(begin, text.length));
  const safeEnd = Math.max(safeBegin, Math.min(end, text.length));
  if (safeBegin >= safeEnd) return null;

  const label = composeLabel(rawAnnotation);
  const { category, subtype } = splitLabel(label);
  return {
    ...(rawAnnotation ?? {}),
    begin: safeBegin,
    end: safeEnd,
    label,
    text: text.slice(safeBegin, safeEnd),
    category: category || null,
    subtype,
  };
}

function annotationValidationIssue(annotation) {
  const label = composeLabel(annotation);
  if (!label) return 'label';

  const { category, subtype } = splitLabel(label);
  if ((SUBTYPES_BY_CATEGORY[category] ?? []).length > 0 && !subtype) return 'subtype';
  if (!LABELS.includes(label)) return 'unsupported';
  return null;
}

function findInvalidAnnotation(annotations) {
  const index = (annotations ?? []).findIndex((annotation) => annotationValidationIssue(annotation));
  if (index === -1) return null;
  return {
    index,
    issue: annotationValidationIssue(annotations[index]),
  };
}

function assertCanonicalDocument(rawRow, filePath, rowIndex) {
  const context = `${filePath} line ${rowIndex + 1}`;
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  const documentAlias = DOCUMENT_ALIASES.find((key) => Object.hasOwn(rawRow, key));
  if (documentAlias) {
    throw new Error(
      `${context}: unsupported field ${JSON.stringify(documentAlias)}; ` +
        'records must use document_id, text, and spans',
    );
  }
  if (typeof rawRow.document_id !== 'string' || !rawRow.document_id.trim()) {
    throw new Error(`${context}: document_id must be a non-empty string`);
  }
  if (typeof rawRow.text !== 'string') {
    throw new Error(`${context}: text must be a string`);
  }
  if (rawRow.spans !== undefined && !Array.isArray(rawRow.spans)) {
    throw new Error(`${context}: spans must be a list`);
  }
  if (rawRow.metadata !== undefined && (
    !rawRow.metadata || typeof rawRow.metadata !== 'object' || Array.isArray(rawRow.metadata)
  )) {
    throw new Error(`${context}: metadata must be an object when present`);
  }
  const retiredMetadataKeys = ['patient_name', 'caregiver_names'].filter(
    (key) => rawRow.metadata && Object.hasOwn(rawRow.metadata, key),
  );
  if (retiredMetadataKeys.length > 0) {
    throw new Error(
      `${context}: retired metadata key(s) ${retiredMetadataKeys.join(', ')}; use patient and caregivers`,
    );
  }
  if (rawRow.annotated !== undefined && typeof rawRow.annotated !== 'boolean') {
    throw new Error(`${context}: annotated must be a boolean when present`);
  }
  for (const [spanIndex, span] of (rawRow.spans ?? []).entries()) {
    if (!span || typeof span !== 'object' || Array.isArray(span)) {
      throw new Error(`${context}: span ${spanIndex} must be an object`);
    }
    const spanAlias = SPAN_ALIASES.find((key) => Object.hasOwn(span, key));
    if (spanAlias) {
      throw new Error(
        `${context}: span ${spanIndex} uses unsupported field ${JSON.stringify(spanAlias)}; ` +
          'spans must use the canonical MedDeID fields',
      );
    }
    if (typeof span.label !== 'string' || !span.label.trim()) {
      throw new Error(`${context}: span ${spanIndex} must contain canonical label`);
    }
  }
}

function normalizeDocument(rawRow) {
  const documentId = String(rawRow?.document_id ?? '').trim();
  if (!documentId) return null;

  const text = String(rawRow?.text ?? '');
  const rawSpans = Array.isArray(rawRow?.spans) ? rawRow.spans : [];
  const spans = rawSpans
    .map((span) => normalizeAnnotation(span, text))
    .filter(Boolean)
    .sort((a, b) => a.begin - b.begin || a.end - b.end || a.label.localeCompare(b.label));

  const {
    document_id: _documentId,
    text: _text,
    metadata: _metadata,
    annotated: _annotated,
    spans: _rawSpans,
    ...rest
  } = rawRow ?? {};
  return {
    ...rest,
    document_id: documentId,
    text,
    metadata: rawRow?.metadata && typeof rawRow.metadata === 'object' ? { ...rawRow.metadata } : {},
    annotated: rawRow?.annotated === true,
    spans,
  };
}

function assertSupportedLabels(documents, filePath) {
  for (const document of documents) {
    for (const [index, annotation] of document.spans.entries()) {
      if (!LABELS.includes(annotation.label)) {
        throw new Error(
          `Unsupported label ${JSON.stringify(annotation.label)} in ${filePath} ` +
            `(document ${document.document_id}, span ${index})`,
        );
      }
    }
  }
  return documents;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function stripDerivedAnnotationFields(annotation) {
  return Object.fromEntries(
    Object.entries(annotation ?? {}).filter(([key]) => !DERIVED_ANNOTATION_FIELDS.has(key)),
  );
}

function annotationIdentity(annotation) {
  return `${annotation.begin}:${annotation.end}:${annotation.label}`;
}

function annotationOverlapLength(left, right) {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.begin, right.begin));
}

function annotationSummary(annotation, annotationIndex = -1) {
  if (!annotation) return null;
  return {
    annotationIndex,
    begin: annotation.begin,
    end: annotation.end,
    label: annotation.label,
    text: annotation.text,
    category: annotation.category,
    subtype: annotation.subtype,
  };
}

function findBestExistingSuggestionMatch(suggestion, annotations) {
  const sameRangeIndex = annotations.findIndex(
    (annotation) => annotation.begin === suggestion.begin && annotation.end === suggestion.end,
  );
  if (sameRangeIndex !== -1) {
    return { index: sameRangeIndex, annotation: annotations[sameRangeIndex], matchKind: 'same_range' };
  }

  let best = null;
  annotations.forEach((annotation, index) => {
    const overlap = annotationOverlapLength(annotation, suggestion);
    if (overlap === 0) return;
    if (!best || overlap > best.overlap) {
      best = { index, annotation, overlap };
    }
  });

  return best ? { ...best, matchKind: 'overlap' } : null;
}

function deriveSuggestionReview(documents, suggestionDocuments) {
  if (!suggestionDocuments) return documents;

  const documentsById = new Map(documents.map((doc) => [doc.document_id, doc]));
  const suggestionsByDoc = new Map(suggestionDocuments.map((doc) => [doc.document_id, doc]));
  const missing = documents
    .filter((doc) => !suggestionsByDoc.has(doc.document_id))
    .map((doc) => doc.document_id);
  const extra = suggestionDocuments
    .filter((doc) => !documentsById.has(doc.document_id))
    .map((doc) => doc.document_id);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Suggestion document IDs do not match the annotation assignment `
      + `(missing: ${missing.slice(0, 5).join(', ') || 'none'}; `
      + `extra: ${extra.slice(0, 5).join(', ') || 'none'})`,
    );
  }
  for (const suggestionDoc of suggestionDocuments) {
    if (suggestionDoc.text !== documentsById.get(suggestionDoc.document_id).text) {
      throw new Error(
        `Suggestion text does not match the annotation assignment for ${suggestionDoc.document_id}`,
      );
    }
  }
  return documents.map((doc) => {
    const suggestionDoc = suggestionsByDoc.get(doc.document_id);
    const isAdjudicationQueue = Array.isArray(doc.adjudication?.disagreements);
    if (!suggestionDoc) {
      if (isAdjudicationQueue) {
        return {
          ...doc,
          suggestions: [],
          suggestionStats: {
            pendingCount: (doc.adjudication.disagreements ?? [])
              .filter((item) => item.status !== 'resolved').length,
            exactMatchCount: 0,
            newSpanCount: 0,
            labelChangeCount: 0,
            boundaryChangeCount: 0,
            missingCount: 0,
          },
        };
      }
      return {
        ...doc,
        spans: doc.spans.map((annotation, annotationIndex) => ({
          ...annotation,
          suggestionReview: {
            type: 'missing_from_suggestions',
            status: 'pending',
            annotationIndex,
          },
        })),
        suggestions: [],
        suggestionStats: {
          pendingCount: doc.spans.length,
          exactMatchCount: 0,
          newSpanCount: 0,
          labelChangeCount: 0,
          boundaryChangeCount: 0,
          missingCount: doc.spans.length,
        },
      };
    }

    const exactSuggestionKeys = new Set(suggestionDoc.spans.map(annotationIdentity));
    const coveredAnnotationIndexes = new Set();
    const disagreementsById = new Map(
      (doc.adjudication?.disagreements ?? []).map((item) => [item.disagreement_id, item]),
    );
    const suggestions = suggestionDoc.spans.map((suggestion, suggestionIndex) => {
      const existing = findBestExistingSuggestionMatch(suggestion, doc.spans);
      const disagreement = disagreementsById.get(suggestion.disagreement_id);
      if (isAdjudicationQueue && disagreement) {
        return {
          ...suggestion,
          suggestionIndex,
          source: suggestion.source ?? 'independent annotation',
          reviewType: 'adjudication_candidate',
          reviewStatus: disagreement.status === 'resolved' ? 'resolved' : 'pending',
          decision: disagreement.decision ?? null,
          existing: annotationSummary(existing?.annotation, existing?.index ?? -1),
        };
      }
      let reviewType = 'new_span';
      if (existing?.matchKind === 'same_range') {
        reviewType = existing.annotation.label === suggestion.label ? 'exact_match' : 'label_change';
      } else if (existing?.matchKind === 'overlap') {
        reviewType = 'boundary_change';
      }
      if (existing) coveredAnnotationIndexes.add(existing.index);
      return {
        ...suggestion,
        suggestionIndex,
        source: suggestion.source ?? 'suggestion',
        reviewType,
        reviewStatus: reviewType === 'exact_match' ? 'matched' : 'pending',
        existing: annotationSummary(existing?.annotation, existing?.index ?? -1),
      };
    });

    const spans = doc.spans.map((annotation, annotationIndex) => {
      if (exactSuggestionKeys.has(annotationIdentity(annotation))) {
        return {
          ...annotation,
          suggestionReview: {
            type: 'exact_match',
            status: 'matched',
            annotationIndex,
          },
        };
      }
      if (coveredAnnotationIndexes.has(annotationIndex)) return annotation;
      // Merge suggestion rows contain disputed candidates only. Accepted
      // consensus spans are deliberately absent and require no review.
      if (isAdjudicationQueue) return annotation;
      return {
        ...annotation,
        suggestionReview: {
          type: 'missing_from_suggestions',
          status: 'pending',
          annotationIndex,
        },
      };
    });

    const countByType = (type) => suggestions.filter((suggestion) => suggestion.reviewType === type).length;
    const missingCount = isAdjudicationQueue
      ? 0
      : spans.filter(
          (annotation) => annotation.suggestionReview?.type === 'missing_from_suggestions',
        ).length;
    return {
      ...doc,
      spans,
      suggestions,
      suggestionStats: {
        pendingCount: isAdjudicationQueue
          ? (doc.adjudication?.disagreements ?? []).filter((item) => item.status !== 'resolved').length
          : countByType('new_span') +
            countByType('label_change') +
            countByType('boundary_change') +
            missingCount,
        exactMatchCount: countByType('exact_match'),
        newSpanCount: countByType('new_span'),
        labelChangeCount: countByType('label_change'),
        boundaryChangeCount: countByType('boundary_change'),
        missingCount,
      },
    };
  });
}

function buildStats(documents) {
  const labelCounts = Object.fromEntries(LABELS.map((label) => [label, 0]));
  let spanCount = 0;
  let annotatedDocumentCount = 0;
  for (const doc of documents) {
    if (doc.annotated === true) annotatedDocumentCount += 1;
    for (const annotation of doc.spans) {
      spanCount += 1;
      labelCounts[annotation.label] = (labelCounts[annotation.label] ?? 0) + 1;
    }
  }
  return {
    documentCount: documents.length,
    annotatedDocumentCount,
    spanCount,
    annotatedCount: documents.filter((doc) => doc.annotated).length,
    labelCounts,
  };
}

export function createAnnotationStore({
  rootDir,
  dataPath = DEFAULT_DATA_PATH,
} = {}) {
  const resolvedRoot = rootDir ?? process.cwd();
  const jsonlPath = path.resolve(resolvedRoot, dataPath);

  let cache = null;
  let writeQueue = Promise.resolve();
  let tmpCounter = 0;

  // Serialize all read-modify-write operations against the JSONL file. Without
  // this, concurrent requests (or a fire-and-forget Cmd+S overlapping a save)
  // each read the same cache snapshot, mutate it, and write back — clobbering
  // each other's changes (lost updates) and racing on the temp file during
  // rename (ENOENT). runExclusive guarantees one critical section at a time;
  // the queue survives a rejected operation so one failure can't wedge the rest.
  function runExclusive(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load() {
    try {
      const rawText = await fs.readFile(jsonlPath, 'utf8');
      const documents = assertSupportedLabels(
        parseJsonLines(rawText, jsonlPath)
          .map((row, rowIndex) => {
            assertCanonicalDocument(row, jsonlPath, rowIndex);
            return normalizeDocument(row);
          })
          .filter(Boolean)
          .sort((a, b) => compareDocIds(a.document_id, b.document_id)),
        jsonlPath,
      );
      cache = documents;
      return cache;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
        await fs.writeFile(jsonlPath, '', 'utf8');
        cache = [];
        return cache;
      }
      throw error;
    }
  }

  async function getDocuments() {
    if (!cache) return load();
    return cache;
  }

  // Standalone write used by callers that aren't already holding the lock
  // (e.g. metadata hydration during load). Mutating API methods instead run
  // their full read-modify-write inside runExclusive and call writeDocumentsNow
  // directly to avoid re-acquiring the same lock (which would deadlock).
  function writeDocuments(documents) {
    return runExclusive(() => writeDocumentsNow(documents));
  }

  async function writeDocumentsNow(documents) {
    const normalized = documents
      .map(normalizeDocument)
      .filter(Boolean)
      .sort((a, b) => compareDocIds(a.document_id, b.document_id));
    await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
    const payload = normalized
      .map((doc) => JSON.stringify(doc))
      .join('\n')
      .concat(normalized.length > 0 ? '\n' : '');
    // Use a unique temp filename per write as a second layer of defense against
    // temp-path collisions, and clean it up if the rename never happens.
    tmpCounter += 1;
    const tmpPath = `${jsonlPath}.${process.pid}.${tmpCounter}.tmp`;
    try {
      await fs.writeFile(tmpPath, payload, 'utf8');
      await fs.rename(tmpPath, jsonlPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    cache = normalized;
    return normalized;
  }

  async function getBootstrap() {
    const documents = await getDocuments();
    return {
      labels: LABELS,
      categories: CATEGORIES,
      subtypes: SUBTYPES,
      subtypesByCategory: SUBTYPES_BY_CATEGORY,
      documents,
      stats: buildStats(documents),
      dataPath: jsonlPath,
    };
  }

  async function saveDocument(documentId, annotations, patch = {}) {
    // Run the whole read-modify-write under the lock so the cache read reflects
    // any preceding concurrent save, preventing lost updates.
    return runExclusive(async () => {
      const documents = await getDocuments();
      const docIndex = documents.findIndex((doc) => doc.document_id === documentId);
      if (docIndex === -1) {
        const error = new Error(`Unknown document_id: ${documentId}`);
        error.statusCode = 404;
        throw error;
      }

      const invalidAnnotation = findInvalidAnnotation(annotations);
      if (invalidAnnotation) {
        const invalidLabel = composeLabel(annotations[invalidAnnotation.index]);
        const error = new Error(
          invalidAnnotation.issue === 'unsupported'
            ? `Unsupported label ${JSON.stringify(invalidLabel)} at index ${invalidAnnotation.index}`
            : invalidAnnotation.issue === 'subtype'
            ? `Cannot save annotation without required subtype at index ${invalidAnnotation.index}`
            : `Cannot save unlabeled annotation at index ${invalidAnnotation.index}`,
        );
        error.statusCode = 400;
        throw error;
      }

      const doc = documents[docIndex];
      const nextFields = { annotated: true };
      if (Object.prototype.hasOwnProperty.call(patch, 'annotated')) {
        nextFields.annotated = patch.annotated === true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
        nextFields.text = String(patch.text ?? '');
      }
      const nextDoc = normalizeDocument({
        ...doc,
        ...nextFields,
        spans: Array.isArray(annotations) ? annotations.map(stripDerivedAnnotationFields) : [],
      });
      const nextDocuments = [...documents];
      nextDocuments[docIndex] = nextDoc;
      await writeDocumentsNow(nextDocuments);
      return nextDoc;
    });
  }

  async function resolveDisagreement(documentId, disagreementId, { decision, candidateId } = {}) {
    if (!['accept_candidate', 'reject_all'].includes(decision)) {
      const error = new Error('decision must be accept_candidate or reject_all');
      error.statusCode = 400;
      throw error;
    }
    await runExclusive(async () => {
      const documents = await getDocuments();
      const docIndex = documents.findIndex((doc) => doc.document_id === documentId);
      if (docIndex === -1) {
        const error = new Error(`Unknown document_id: ${documentId}`);
        error.statusCode = 404;
        throw error;
      }
      const doc = documents[docIndex];
      const disagreements = doc.adjudication?.disagreements;
      if (!Array.isArray(disagreements)) {
        const error = new Error(`${documentId} is not an adjudication project`);
        error.statusCode = 400;
        throw error;
      }
      const disagreementIndex = disagreements.findIndex(
        (item) => item.disagreement_id === disagreementId,
      );
      if (disagreementIndex === -1) {
        const error = new Error(`Unknown disagreement_id: ${disagreementId}`);
        error.statusCode = 404;
        throw error;
      }
      const disagreement = disagreements[disagreementIndex];
      if (disagreement.status === 'resolved') {
        const error = new Error(`Disagreement ${disagreementId} is already resolved`);
        error.statusCode = 409;
        throw error;
      }

      let spans = [...doc.spans];
      let acceptedCandidate = null;
      if (decision === 'accept_candidate') {
        acceptedCandidate = (disagreement.candidates ?? []).find(
          (candidate) => candidate.candidate_id === candidateId,
        );
        if (!acceptedCandidate) {
          const error = new Error(`Unknown candidate_id: ${candidateId}`);
          error.statusCode = 400;
          throw error;
        }
        const acceptedSpan = normalizeAnnotation(
          { ...acceptedCandidate.span, confirmed: true },
          doc.text,
        );
        if (!spans.some((span) => annotationIdentity(span) === annotationIdentity(acceptedSpan))) {
          spans.push(acceptedSpan);
        }
      }

      const resolvedAt = new Date().toISOString();
      const nextDisagreements = disagreements.map((item, index) =>
        index === disagreementIndex
          ? {
              ...item,
              status: 'resolved',
              decision: {
                type: decision,
                candidate_id: acceptedCandidate?.candidate_id ?? null,
                accepted_candidate_span: acceptedCandidate ? { ...acceptedCandidate.span } : null,
                resolved_at: resolvedAt,
              },
            }
          : item,
      );
      const nextDoc = normalizeDocument({
        ...doc,
        annotated: true,
        spans,
        adjudication: {
          ...doc.adjudication,
          disagreements: nextDisagreements,
          status: nextDisagreements.every((item) => item.status === 'resolved')
            ? 'adjudicated'
            : 'pending',
        },
      });
      const nextDocuments = [...documents];
      nextDocuments[docIndex] = nextDoc;
      await writeDocumentsNow(nextDocuments);
    });
    return getBootstrap();
  }

  async function batchRelabel({ matches, label }) {
    const nextLabel = String(label ?? '').trim();
    if (!LABELS.includes(nextLabel)) {
      const error = new Error(`Unsupported label: ${nextLabel}`);
      error.statusCode = 400;
      throw error;
    }

    const grouped = new Map();
    for (const match of matches ?? []) {
      const docId = String(match?.document_id ?? '').trim();
      const index = Number(match?.annotationIndex);
      if (!docId || !Number.isInteger(index)) continue;
      if (!grouped.has(docId)) grouped.set(docId, new Set());
      grouped.get(docId).add(index);
    }

    const changed = await runExclusive(async () => {
      const documents = await getDocuments();
      let count = 0;
      const nextDocuments = documents.map((doc) => {
        const indexes = grouped.get(doc.document_id);
        if (!indexes) return doc;
        const spans = doc.spans.map((annotation, index) => {
          if (!indexes.has(index)) return annotation;
          count += 1;
          const { category, subtype } = splitLabel(nextLabel);
          return normalizeAnnotation(
            { ...annotation, label: nextLabel, category, subtype },
            doc.text,
          );
        });
        return normalizeDocument({ ...doc, spans });
      });

      await writeDocumentsNow(nextDocuments);
      return count;
    });

    return {
      changed,
      bootstrap: await getBootstrap(),
    };
  }

  async function resetTracking() {
    const changed = await runExclusive(async () => {
      const documents = await getDocuments();
      const previouslyAnnotated = documents.filter((doc) => doc.annotated).length;
      const nextDocuments = documents.map((doc) => normalizeDocument({ ...doc, annotated: false }));
      await writeDocumentsNow(nextDocuments);
      return previouslyAnnotated;
    });
    return {
      changed,
      bootstrap: await getBootstrap(),
    };
  }

  return {
    jsonlPath,
    load,
    getBootstrap,
    saveDocument,
    batchRelabel,
    resetTracking,
  };
}
