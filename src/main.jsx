import React from 'react';
import Workspace from './Workspace.jsx';
import { createRoot } from 'react-dom/client';
import {
  Check,
  ChevronDown,
  CircleDot,
  Filter,
  Info,
  Keyboard,
  Plus,
  Redo2,
  RefreshCw,
  Replace,
  Save,
  Search,
  Settings,
  Trash2,
  Undo2,
} from 'lucide-react';
import { adjustAnnotationsForTextChange } from './text-offsets.js';
import defaultLabelShortcuts from '../config/label-shortcuts.json';
import taxonomyContract from '../contracts/taxonomy.json';
import './styles.css';



const READER_WIDTH_MODES = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'wide', label: 'Wide' },
  { value: 'max', label: 'Max' },
];

// Options offered by the split Save button. The last-used value is remembered
// and becomes the action the main Save button performs on click.
const SAVE_ACTIONS = [
  { value: 'current', label: 'Current document' },
  { value: 'all', label: 'All unsaved documents' },
  { value: 'all-keep', label: 'All unsaved (keep tracking state)' },
];

// How often the background auto-save runs while enabled. Browser integration
// tests override this through Vite so the real autosave path can be exercised
// without waiting two minutes.
const configuredAutosaveInterval = Number(import.meta.env.VITE_AUTOSAVE_INTERVAL_MS);
const AUTOSAVE_INTERVAL_MS = Number.isFinite(configuredAutosaveInterval) && configuredAutosaveInterval > 0
  ? configuredAutosaveInterval
  : 2 * 60 * 1000;

const CATEGORY_DEFINITIONS = taxonomyContract.categories.map((value) => ({
  value,
  key: defaultLabelShortcuts.category_shortcuts[value] ?? null,
}));

const SUBTYPE_DEFINITIONS = taxonomyContract.subtypes.map((value) => ({
  value,
  key: defaultLabelShortcuts.subtype_shortcuts[value] ?? null,
}));

const SUBTYPES_BY_CATEGORY = taxonomyContract.subtypes_by_category;
const FALLBACK_LABELS = taxonomyContract.entity_labels;

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function labelColor(label) {
  const hue = (hashString(label) * 47) % 360;
  return `hsl(${hue} 74% 88%)`;
}

function splitLabel(label) {
  const normalized = String(label ?? '').trim();
  if (!normalized) return { category: '', subtype: '' };
  const [category, ...subtypeParts] = normalized.split(':');
  return {
    category,
    subtype: subtypeParts.length > 0 ? subtypeParts.join(':') : '',
  };
}

function spanCategory(span) {
  const category = String(span?.category ?? '').trim();
  if (category) return category;
  return splitLabel(span?.label ?? '').category;
}

function spanSubtype(span) {
  const rawSubtype = span?.subtype;
  const subtype = rawSubtype === null || rawSubtype === undefined ? '' : String(rawSubtype).trim();
  if (subtype) return subtype;
  return splitLabel(span?.label ?? '').subtype;
}

function composeLabel(category, subtype) {
  const nextCategory = String(category ?? '').trim();
  const nextSubtype = String(subtype ?? '').trim();
  return nextCategory && nextSubtype ? `${nextCategory}:${nextSubtype}` : nextCategory;
}

function spanLabel(span) {
  return composeLabel(spanCategory(span), spanSubtype(span));
}

function spanHasLabel(span) {
  return Boolean(spanLabel(span));
}

function suggestionReviewType(annotation) {
  return String(annotation?.suggestionReview?.type ?? '').trim();
}

function suggestionReviewStatus(annotation) {
  return String(annotation?.suggestionReview?.status ?? '').trim();
}

function allowedSubtypesFor(category, subtypesByCategory) {
  return subtypesByCategory?.[category] ?? [];
}

function requiresSubtype(category, subtypesByCategory) {
  return allowedSubtypesFor(category, subtypesByCategory).length > 0;
}

function spanValidationIssue(span, subtypesByCategory) {
  if (span?._changeStatus === 'deleted') return null;
  const category = spanCategory(span);
  if (!category) return 'label';
  if (requiresSubtype(category, subtypesByCategory) && !spanSubtype(span)) return 'subtype';
  return null;
}

function spanIsValid(span, subtypesByCategory) {
  return spanValidationIssue(span, subtypesByCategory) === null;
}

function updateSpanCategorySubtype(span, { category, subtype }, docText, subtypesByCategory) {
  const nextCategory = category ?? spanCategory(span);
  const allowedSubtypes = allowedSubtypesFor(nextCategory, subtypesByCategory);
  const currentSubtype = subtype ?? spanSubtype(span);
  const nextSubtype = allowedSubtypes.includes(currentSubtype) ? currentSubtype : '';
  const label = composeLabel(nextCategory, nextSubtype);
  return {
    ...span,
    label,
    category: nextCategory || null,
    subtype: nextSubtype || null,
    confirmed: false,
    _changeStatus: span._changeStatus === 'added' ? 'added' : 'changed',
    text: docText.slice(span.begin, span.end),
  };
}

function markSpanConfirmed(span, docText) {
  const label = spanLabel(span);
  return {
    ...span,
    label,
    text: docText.slice(span.begin, span.end),
    confirmed: true,
  };
}

function makeAnnotation({ begin, end, docText, category = '', subtype = '' }) {
  return {
    begin,
    end,
    label: composeLabel(category, subtype),
    text: docText.slice(begin, end),
    category: category || null,
    subtype: subtype || null,
    confirmed: false,
    _changeStatus: 'added',
  };
}

function makeAnnotationFromSuggestion(suggestion, docText) {
  const category = spanCategory(suggestion);
  const subtype = spanSubtype(suggestion);
  const existingIndex = Number(suggestion.existing?.annotationIndex);
  return {
    begin: suggestion.begin,
    end: suggestion.end,
    label: spanLabel(suggestion),
    text: docText.slice(suggestion.begin, suggestion.end),
    category: category || null,
    subtype: subtype || null,
    confirmed: false,
    _changeStatus: Number.isInteger(existingIndex) && existingIndex >= 0 ? 'changed' : 'added',
  };
}

function cloneDocuments(documents) {
  return documents.map((doc) => ({
    ...doc,
    annotations: doc.annotations.map((annotation) => ({ ...annotation })),
    suggestions: doc.suggestions?.map((suggestion) => ({
      ...suggestion,
      existing: suggestion.existing ? { ...suggestion.existing } : suggestion.existing,
    })),
  }));
}

// Boundary adapter: the API/persisted schema uses the canonical `spans` key;
// this UI keeps documents in `annotations` internally. Map on the way in.
function fromApiDocuments(documents) {
  return (documents ?? []).map((doc) => {
    const { spans, ...rest } = doc;
    return { ...rest, annotations: spans ?? [] };
  });
}

function isDocumentAnnotated(doc) {
  return doc?.annotated === true;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  if (value > 0 && value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

function rangesOverlap(left, right) {
  return Math.max(left.begin, right.begin) < Math.min(left.end, right.end);
}

// Drop every annotation overlapping the range so a newly created span can take
// over the region (overwrite). Removing a previously-saved span here means it
// simply won't be persisted on the next save.
function removeOverlappingAnnotations(annotations, range) {
  return annotations.filter((annotation) => !rangesOverlap(range, annotation));
}

// Find an existing span that strictly contains the range (the range would be a
// subspan of it). Such spans are preserved rather than overwritten, since a new
// span nested inside a larger one can't coexist with it. Equal ranges don't
// count as containment, so re-labeling the exact same range still overwrites.
function strictlyContainingAnnotation(range, annotations) {
  return annotations.find(
    (annotation) =>
      annotation._changeStatus !== 'deleted' &&
      annotation.begin <= range.begin &&
      range.end <= annotation.end &&
      (annotation.begin < range.begin || range.end < annotation.end),
  );
}

function isAlphanumeric(char) {
  return /^[\p{L}\p{N}]$/u.test(char);
}

function normalizeRangeToWordBoundaries(range, text) {
  const value = String(text ?? '');
  const nextRange = {
    begin: Math.max(0, Math.min(range.begin, value.length)),
    end: Math.max(0, Math.min(range.end, value.length)),
  };

  const startsInsideWord = nextRange.begin < nextRange.end && isAlphanumeric(value[nextRange.begin]);
  const endsInsideWord = nextRange.end > nextRange.begin && isAlphanumeric(value[nextRange.end - 1]);

  while (startsInsideWord && nextRange.begin > 0 && isAlphanumeric(value[nextRange.begin - 1])) {
    nextRange.begin -= 1;
  }
  while (endsInsideWord && nextRange.end < value.length && isAlphanumeric(value[nextRange.end])) {
    nextRange.end += 1;
  }

  return nextRange;
}

function sortAnnotations(annotations) {
  return [...annotations].sort((a, b) => a.begin - b.begin || a.end - b.end || spanLabel(a).localeCompare(spanLabel(b)));
}

function persistableAnnotations(annotations) {
  return annotations
    .filter((annotation) => annotation._changeStatus !== 'deleted')
    .map(({ _changeStatus, ...annotation }) => annotation);
}

function visibleSpanCount(doc) {
  return doc.annotations.filter((annotation) => annotation._changeStatus !== 'deleted').length;
}

function invalidSpanCount(doc, subtypesByCategory) {
  return doc.annotations.filter((annotation) => spanValidationIssue(annotation, subtypesByCategory)).length;
}

function firstInvalidSpanIndex(doc, subtypesByCategory) {
  return doc.annotations.findIndex((annotation) => spanValidationIssue(annotation, subtypesByCategory));
}

function tokenizeQuery(value) {
  const input = String(value ?? '');
  const tokens = [];
  let current = '';
  let quoted = false;
  let tokenQuoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      quoted = !quoted;
      tokenQuoted = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push({ value: current, quoted: tokenQuoted });
      current = '';
      tokenQuoted = false;
      continue;
    }
    current += char;
  }

  if (current) tokens.push({ value: current, quoted: tokenQuoted });
  return tokens;
}

function valueMatches(candidate, matcher) {
  const value = String(matcher?.value ?? '');
  if (!value) return false;
  const text = String(candidate ?? '');
  return matcher.quoted ? text === value : text.toLowerCase().includes(value.toLowerCase());
}

function isEscaped(value, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function parseRegexMatcher(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { matcher: null };

  let source = raw;
  let flags = '';
  if (raw.startsWith('/')) {
    let closingSlashIndex = -1;
    for (let index = raw.length - 1; index > 0; index -= 1) {
      if (raw[index] === '/' && !isEscaped(raw, index)) {
        closingSlashIndex = index;
        break;
      }
    }
    if (closingSlashIndex > 0) {
      source = raw.slice(1, closingSlashIndex);
      flags = raw.slice(closingSlashIndex + 1);
    } else {
      return { matcher: null };
    }
  }

  const matcherFlags = Array.from(new Set(flags))
    .filter((flag) => flag !== 'g' && flag !== 'd' && flag !== 'y')
    .join('');

  try {
    new RegExp(source, matcherFlags);
  } catch {
    return { matcher: null };
  }

  return {
    matcher: {
      kind: 'regex',
      value: raw,
      source,
      flags: matcherFlags,
    },
  };
}

function regexRanges(value, matcher) {
  const text = String(value ?? '');
  if (!matcher?.source) return [];

  const regex = new RegExp(matcher.source, `${matcher.flags}g`);
  const ranges = [];
  let match = regex.exec(text);

  while (match) {
    if (match[0].length > 0) {
      ranges.push({ begin: match.index, end: match.index + match[0].length });
    } else {
      regex.lastIndex += 1;
    }
    match = regex.exec(text);
  }

  return ranges;
}

function regexMatches(value, matcher) {
  if (!matcher?.source) return false;
  return new RegExp(matcher.source, matcher.flags).test(String(value ?? ''));
}

function findMatchingNames(matcher, options) {
  return options.filter((option) => valueMatches(option, matcher));
}

function findMatchingFilterValues(matcher, options, { allowNone = false } = {}) {
  const normalized = String(matcher?.value ?? '').trim().toLowerCase();
  if (allowNone && normalized === 'none') return [''];
  return findMatchingNames(matcher, options);
}

function parseFacetListFilter(matcher, options) {
  const terms = String(matcher?.value ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  const parsed = {
    includes: [],
    excludes: [],
    includeAny: false,
    excludeAny: false,
    valid: terms.length > 0,
  };

  for (const rawTerm of terms) {
    const excludes = rawTerm.startsWith('-');
    const value = excludes ? rawTerm.slice(1).trim() : rawTerm;
    const normalized = value.toLowerCase();

    if (!value) {
      parsed.valid = false;
      continue;
    }

    if (normalized === 'any') {
      if (excludes) parsed.excludeAny = true;
      else parsed.includeAny = true;
      continue;
    }

    const matches = normalized === 'none' ? [''] : findMatchingNames({ value, quoted: matcher.quoted }, options);
    if (matches.length === 0) {
      parsed.valid = false;
      continue;
    }

    if (excludes) parsed.excludes.push(...matches);
    else parsed.includes.push(...matches);
  }

  return parsed;
}

function applyFacetListFilter(parsedFilter, filters, { includeKey, excludeKey, includeAnyKey, excludeAnyKey }) {
  filters[includeKey].push(...parsedFilter.includes);
  filters[excludeKey].push(...parsedFilter.excludes);
  filters[includeAnyKey] = filters[includeAnyKey] || parsedFilter.includeAny;
  filters[excludeAnyKey] = filters[excludeAnyKey] || parsedFilter.excludeAny;
}

function parseSavedFilter(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return 'saved';
  if (normalized === 'false') return 'unsaved';
  return null;
}

function parseAnnotatedFilter(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'annotated'].includes(normalized)) return 'annotated';
  if (['false', 'no', 'n', '0', 'not', 'unannotated'].includes(normalized)) return 'unannotated';
  return null;
}

function documentAnnotatedStatus(doc) {
  return doc?.annotated ? 'annotated' : 'unannotated';
}

function metadataEntries(doc) {
  const metadata = doc?.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const patient =
    metadata.patient && typeof metadata.patient === 'object' ? metadata.patient : {};
  const fullName = [patient.given_name, patient.family_name].filter(Boolean).join(' ').trim();
  return [
    ['created', 'Created', metadata.document_creation_date],
    ['name', 'Name', fullName],
    ['birth_date', 'Birth date', patient.birth_date],
    ['lang', 'Language', metadata.lang],
  ].flatMap(([key, label, value]) =>
    value === undefined || value === null || String(value).trim() === ''
      ? []
      : [{ key, label, value: String(value) }],
  );
}

function spanFacetValues(annotation) {
  return {
    hasAnnotation: Boolean(annotation),
    label: annotation ? spanLabel(annotation) : '',
    category: annotation ? spanCategory(annotation) : '',
    subtype: annotation ? spanSubtype(annotation) : '',
  };
}

function facetValuesMatchFilters(values, filters) {
  const includedCategories = filters.categories.filter((category) => category !== '');
  const categoryNoneIncluded = filters.categories.includes('');
  const categoryIncluded =
    includedCategories.length === 0 && !categoryNoneIncluded && !filters.includeAnyCategory
      ? true
      : includedCategories.includes(values.category) ||
        (filters.includeAnyCategory && Boolean(values.category)) ||
        (categoryNoneIncluded && !values.hasAnnotation);
  const subtypeIncluded =
    filters.subtypes.length === 0 && !filters.includeAnySubtype
      ? true
      : filters.subtypes.includes(values.subtype) || (filters.includeAnySubtype && Boolean(values.subtype));

  if (filters.labels.length > 0 && !filters.labels.includes(values.label)) return false;
  if (!categoryIncluded) return false;
  if (!subtypeIncluded) return false;
  if (filters.excludedLabels.includes(values.label)) return false;
  if (filters.excludeAnyCategory && values.category) return false;
  if (filters.excludedCategories.includes('') && !values.hasAnnotation) return false;
  if (filters.excludedCategories.includes(values.category)) return false;
  if (filters.excludeAnySubtype && values.subtype) return false;
  if (filters.excludedSubtypes.includes(values.subtype)) return false;
  return true;
}

function annotationMatchesFacetFilters(annotation, filters) {
  return facetValuesMatchFilters(spanFacetValues(annotation), filters);
}

function overlappingAnnotations(range, annotations) {
  return annotations.filter((annotation) => annotation._changeStatus !== 'deleted' && rangesOverlap(range, annotation));
}

function rangeMatchesFacetFilters(range, annotations, filters) {
  const annotationsAtRange = overlappingAnnotations(range, annotations);
  if (annotationsAtRange.length === 0) return facetValuesMatchFilters(spanFacetValues(null), filters);
  return annotationsAtRange.some((annotation) => annotationMatchesFacetFilters(annotation, filters));
}

function hasPositiveFacetFilters(filters) {
  return (
    filters.categories.length > 0 ||
    filters.subtypes.length > 0 ||
    filters.labels.length > 0 ||
    filters.includeAnyCategory ||
    filters.includeAnySubtype
  );
}

function parseQuery(value, { labels, categories, subtypes }) {
  const tokens = tokenizeQuery(value);
  const keywordParts = [];
  const invalidFilters = [];
  let regexMatcher = null;
  const filters = {
    categories: [],
    subtypes: [],
    labels: [],
    documents: [],
    saveStatuses: [],
    annotatedStatuses: [],
    excludedCategories: [],
    excludedSubtypes: [],
    excludedLabels: [],
    includeAnyCategory: false,
    includeAnySubtype: false,
    excludeAnyCategory: false,
    excludeAnySubtype: false,
  };

  for (const token of tokens) {
    const separatorIndex = token.value.indexOf(':');
    const key = separatorIndex > 0 ? token.value.slice(0, separatorIndex).toLowerCase() : '';
    const rawFilterValue = separatorIndex > 0 ? token.value.slice(separatorIndex + 1) : '';
    const matcher = { value: rawFilterValue, quoted: token.quoted };

    if (key === 'regex' || key === 're') {
      const parsedRegex = parseRegexMatcher(rawFilterValue);
      if (parsedRegex.matcher && !regexMatcher) regexMatcher = parsedRegex.matcher;
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'category' || key === 'cat') {
      const parsedFilter = parseFacetListFilter(matcher, categories);
      if (parsedFilter.valid) {
        applyFacetListFilter(parsedFilter, filters, {
          includeKey: 'categories',
          excludeKey: 'excludedCategories',
          includeAnyKey: 'includeAnyCategory',
          excludeAnyKey: 'excludeAnyCategory',
        });
      } else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'subtype' || key === 'sub') {
      const parsedFilter = parseFacetListFilter(matcher, subtypes);
      if (parsedFilter.valid) {
        applyFacetListFilter(parsedFilter, filters, {
          includeKey: 'subtypes',
          excludeKey: 'excludedSubtypes',
          includeAnyKey: 'includeAnySubtype',
          excludeAnyKey: 'excludeAnySubtype',
        });
      } else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'label') {
      const matchedLabels = findMatchingNames(matcher, labels);
      if (matchedLabels.length > 0) filters.labels.push(...matchedLabels);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'doc' || key === 'document' || key === 'id' || key === 'document_id') {
      if (rawFilterValue) filters.documents.push(matcher);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'saved') {
      const saveStatus = parseSavedFilter(rawFilterValue);
      if (saveStatus) filters.saveStatuses.push(saveStatus);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'annotated' || key === 'tracking') {
      const annotatedStatus = parseAnnotatedFilter(rawFilterValue);
      if (annotatedStatus) filters.annotatedStatuses.push(annotatedStatus);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'not_category') {
      const matchedCategories = findMatchingFilterValues(matcher, categories, { allowNone: true });
      if (matchedCategories.length > 0) filters.excludedCategories.push(...matchedCategories);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'not_subtype') {
      const matchedSubtypes = findMatchingFilterValues(matcher, subtypes, { allowNone: true });
      if (matchedSubtypes.length > 0) filters.excludedSubtypes.push(...matchedSubtypes);
      else invalidFilters.push(token.value);
      continue;
    }

    if (key === 'not_label') {
      const matchedLabels = findMatchingFilterValues(matcher, labels, { allowNone: true });
      if (matchedLabels.length > 0) filters.excludedLabels.push(...matchedLabels);
      else invalidFilters.push(token.value);
      continue;
    }

    keywordParts.push({ value: token.value, quoted: token.quoted });
  }

  const keyword = keywordParts.map((part) => part.value).join(' ');
  const keywordQuoted = keywordParts.some((part) => part.quoted);
  if (regexMatcher && keyword) invalidFilters.push('free text with regex');
  const textSearch = regexMatcher ?? (keyword ? { kind: 'literal', value: keyword, exact: keywordQuoted } : null);
  return {
    raw: String(value ?? '').trim(),
    keyword,
    keywordQuoted,
    textSearch,
    invalidFilters,
    filters: {
      categories: Array.from(new Set(filters.categories)),
      subtypes: Array.from(new Set(filters.subtypes)),
      labels: Array.from(new Set(filters.labels)),
      documents: filters.documents,
      saveStatuses: Array.from(new Set(filters.saveStatuses)),
      annotatedStatuses: Array.from(new Set(filters.annotatedStatuses)),
      excludedCategories: Array.from(new Set(filters.excludedCategories)),
      excludedSubtypes: Array.from(new Set(filters.excludedSubtypes)),
      excludedLabels: Array.from(new Set(filters.excludedLabels)),
      includeAnyCategory: filters.includeAnyCategory,
      includeAnySubtype: filters.includeAnySubtype,
      excludeAnyCategory: filters.excludeAnyCategory,
      excludeAnySubtype: filters.excludeAnySubtype,
    },
  };
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a regex source that matches the keyword while treating any run of
// whitespace in the query as a run of whitespace in the text. This lets a
// space-separated query match text where the words are split across lines,
// e.g. "FORFAITAIRE BETALING INSCHRIJVING" matches "FORFAITAIRE BETALING\nINSCHRIJVING".
function whitespaceFlexiblePattern(keyword) {
  const tokens = String(keyword ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp);
  return tokens.join('\\s+');
}

function textIncludesQuery(value, keyword, caseSensitive = false) {
  const needle = String(keyword ?? '');
  if (!needle) return true;
  const haystack = String(value ?? '');
  // Quoted (exact) searches stay literal; unquoted searches match across
  // whitespace boundaries, including newlines.
  if (caseSensitive) return haystack.includes(needle);
  const pattern = whitespaceFlexiblePattern(needle);
  if (!pattern) return true;
  return new RegExp(pattern, 'i').test(haystack);
}

function textSearchMatches(value, textSearch) {
  if (!textSearch) return true;
  if (textSearch.kind === 'regex') return regexMatches(value, textSearch);
  return textIncludesQuery(value, textSearch.value, textSearch.exact);
}

function annotationSearchText(annotation, docText) {
  const text = String(annotation.text ?? docText.slice(annotation.begin, annotation.end));
  const label = spanLabel(annotation);
  const category = spanCategory(annotation);
  const subtype = spanSubtype(annotation);
  const reviewType = suggestionReviewType(annotation);
  const reviewStatus = suggestionReviewStatus(annotation);
  return [
    text,
    label,
    category,
    subtype,
    `${annotation.begin}-${annotation.end}`,
    reviewType,
    reviewStatus,
    reviewType && `review:${reviewType}`,
    reviewStatus && `review:${reviewStatus}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function spanMatchesQuery(annotation, docText, parsedQuery) {
  if (annotation._changeStatus === 'deleted' || parsedQuery.invalidFilters.length > 0) return false;

  const { filters } = parsedQuery;

  if (!annotationMatchesFacetFilters(annotation, filters)) return false;

  return textSearchMatches(annotationSearchText(annotation, docText), parsedQuery.textSearch);
}

function suggestionSearchText(suggestion, docText) {
  const text = String(suggestion.text ?? docText.slice(suggestion.begin, suggestion.end));
  const label = spanLabel(suggestion);
  const category = spanCategory(suggestion);
  const subtype = spanSubtype(suggestion);
  const existing = suggestion.existing ?? {};
  const reviewType = String(suggestion.reviewType ?? '').trim();
  const reviewStatus = String(suggestion.reviewStatus ?? '').trim();
  return [
    'suggestion',
    'model',
    text,
    label,
    category,
    subtype,
    `${suggestion.begin}-${suggestion.end}`,
    reviewType,
    reviewStatus,
    reviewType && `review:${reviewType}`,
    reviewStatus && `review:${reviewStatus}`,
    existing.label,
    existing.text,
  ]
    .filter(Boolean)
    .join(' ');
}

function suggestionMatchesQuery(suggestion, docText, parsedQuery) {
  if (parsedQuery.invalidFilters.length > 0) return false;
  if (!annotationMatchesFacetFilters(suggestion, parsedQuery.filters)) return false;
  return textSearchMatches(suggestionSearchText(suggestion, docText), parsedQuery.textSearch);
}

function queryKeywordRanges(doc, parsedQuery) {
  const textSearch = parsedQuery.textSearch;
  if (!textSearch || parsedQuery.invalidFilters.length > 0) return [];
  const ranges =
    textSearch.kind === 'regex'
      ? regexRanges(doc.text, textSearch)
      : batchAnnotationRanges(doc.text, textSearch.value, textSearch.exact);
  return ranges.filter((range) =>
    rangeMatchesFacetFilters(range, doc.annotations, parsedQuery.filters),
  );
}

function queryHighlightRanges(doc, parsedQuery) {
  const textSearch = parsedQuery.textSearch;
  if (!textSearch || parsedQuery.invalidFilters.length > 0) return [];
  const ranges =
    textSearch.kind === 'regex'
      ? regexRanges(doc.text, textSearch)
      : keywordRanges(doc.text, textSearch.value, textSearch.exact);
  return ranges.filter((range) =>
    rangeMatchesFacetFilters(range, doc.annotations, parsedQuery.filters),
  );
}

function buildMatches(documents, parsedQuery, subtypesByCategory, dirtyDocIds = new Set()) {
  if (!parsedQuery.raw) return [];

  const matches = [];

  for (const doc of documents) {
    const documentIdMatches =
      parsedQuery.filters.documents.length === 0 ||
      parsedQuery.filters.documents.some((filter) => valueMatches(doc.document_id, filter));
    if (!documentIdMatches) continue;

    const documentSaveStatus = dirtyDocIds.has(doc.document_id) ? 'unsaved' : 'saved';
    const documentSaveStatusMatches =
      parsedQuery.filters.saveStatuses.length === 0 ||
      parsedQuery.filters.saveStatuses.includes(documentSaveStatus);
    if (!documentSaveStatusMatches) continue;

    const documentTrackingStatus = documentAnnotatedStatus(doc);
    const documentTrackingStatusMatches =
      parsedQuery.filters.annotatedStatuses.length === 0 ||
      parsedQuery.filters.annotatedStatuses.includes(documentTrackingStatus);
    if (!documentTrackingStatusMatches) continue;

    const documentTextMatches = queryKeywordRanges(doc, parsedQuery).length > 0;
    let spanMatchCount = 0;

    doc.annotations.forEach((annotation, annotationIndex) => {
      const label = spanLabel(annotation);
      const text = String(annotation.text ?? doc.text.slice(annotation.begin, annotation.end));
      const spanMatches = spanMatchesQuery(annotation, doc.text, parsedQuery);
      const reviewType = suggestionReviewType(annotation);
      const reviewStatus = suggestionReviewStatus(annotation);

      if (spanMatches) {
        spanMatchCount += 1;
        matches.push({
          kind: 'annotation',
          document_id: doc.document_id,
          annotationIndex,
          suggestionIndex: -1,
          label,
          valid: spanIsValid(annotation, subtypesByCategory),
          issue: spanValidationIssue(annotation, subtypesByCategory),
          text,
          begin: annotation.begin,
          end: annotation.end,
          changeStatus: annotation._changeStatus,
          reviewType,
          reviewStatus,
          matchedByText: documentTextMatches,
          matchedByDocumentId: false,
          matchedBySpan: true,
        });
      }
    });

    (doc.suggestions ?? []).forEach((suggestion, suggestionIndex) => {
      const label = spanLabel(suggestion);
      const text = String(suggestion.text ?? doc.text.slice(suggestion.begin, suggestion.end));
      const existing = suggestion.existing ?? {};
      const reviewType = String(suggestion.reviewType ?? '').trim();
      const reviewStatus = String(suggestion.reviewStatus ?? '').trim();
      const suggestionMatches = suggestionMatchesQuery(suggestion, doc.text, parsedQuery);
      if (!suggestionMatches) return;

      spanMatchCount += 1;
      matches.push({
        kind: 'suggestion',
        document_id: doc.document_id,
        annotationIndex: -1,
        suggestionIndex,
        label,
        text,
        begin: suggestion.begin,
        end: suggestion.end,
        reviewType,
        reviewStatus,
        existing,
        matchedByText: documentTextMatches,
        matchedByDocumentId: documentIdMatches,
        matchedBySpan: suggestionMatches,
      });
    });

    const hasExactFilters = hasPositiveFacetFilters(parsedQuery.filters);
    const hasDocumentFilters =
      parsedQuery.filters.documents.length > 0 ||
      parsedQuery.filters.saveStatuses.length > 0 ||
      parsedQuery.filters.annotatedStatuses.length > 0;

    if (spanMatchCount === 0 && (documentTextMatches || (hasDocumentFilters && !hasExactFilters))) {
      matches.push({
        kind: 'document',
        document_id: doc.document_id,
        annotationIndex: -1,
        suggestionIndex: -1,
        label: '',
        text: '',
        begin: 0,
        end: 0,
        matchedByText: documentTextMatches,
        matchedByDocumentId: parsedQuery.filters.documents.length > 0,
        matchedBySaveStatus: parsedQuery.filters.saveStatuses.length > 0,
        matchedByTrackingStatus: parsedQuery.filters.annotatedStatuses.length > 0,
        matchedBySpan: false,
      });
    }
  }

  return matches;
}

function keywordRanges(value, keyword, caseSensitive = false) {
  const needle = String(keyword ?? '').trim();
  if (!needle) return [];

  const haystack = String(value ?? '');

  // Quoted (exact) searches stay literal; unquoted searches match across
  // whitespace boundaries, so a query can span newlines in the document.
  if (caseSensitive) {
    const ranges = [];
    let cursor = 0;
    while (cursor < haystack.length) {
      const index = haystack.indexOf(needle, cursor);
      if (index === -1) break;
      ranges.push({ begin: index, end: index + needle.length });
      cursor = index + Math.max(1, needle.length);
    }
    return ranges;
  }

  const pattern = whitespaceFlexiblePattern(needle);
  if (!pattern) return [];
  const regex = new RegExp(pattern, 'gi');
  const ranges = [];
  let match;
  while ((match = regex.exec(haystack)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    ranges.push({ begin: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

function batchAnnotationRanges(value, keyword, exact = false) {
  const ranges = keywordRanges(value, keyword, exact);
  if (exact) return ranges;

  const text = String(value ?? '');
  const seenRanges = new Set();
  return ranges.flatMap((range) => {
    const normalized = normalizeRangeToWordBoundaries(range, text);
    if (normalized.begin >= normalized.end) return [];

    const key = `${normalized.begin}:${normalized.end}`;
    if (seenRanges.has(key)) return [];
    seenRanges.add(key);
    return [normalized];
  });
}

function textIncludesKeyword(annotation, docText, parsedQuery) {
  return spanMatchesQuery(annotation, docText, parsedQuery);
}

function renderTextFragment(value, highlightRanges, keyPrefix, absoluteStart) {
  const text = String(value ?? '');
  const absoluteEnd = absoluteStart + text.length;
  const filteredRanges = highlightRanges.flatMap((range) => {
    const begin = Math.max(absoluteStart, range.begin);
    const end = Math.min(absoluteEnd, range.end);
    if (begin >= end) return [];
    return [{ begin: begin - absoluteStart, end: end - absoluteStart }];
  });
  if (filteredRanges.length === 0) {
    return (
      <span data-text-start={absoluteStart} key={`${keyPrefix}-plain`}>
        {text}
      </span>
    );
  }

  const pieces = [];
  let cursor = 0;
  filteredRanges.forEach((range, index) => {
    if (range.begin < cursor) return;
    if (cursor < range.begin) {
      pieces.push(
        <span data-text-start={absoluteStart + cursor} key={`${keyPrefix}-text-${index}`}>
          {text.slice(cursor, range.begin)}
        </span>,
      );
    }
    pieces.push(
      <mark data-text-start={absoluteStart + range.begin} key={`${keyPrefix}-match-${index}`} className="keyword-hit">
        {text.slice(range.begin, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) {
    pieces.push(
      <span data-text-start={absoluteStart + cursor} key={`${keyPrefix}-tail`}>
        {text.slice(cursor)}
      </span>,
    );
  }
  return pieces;
}

function textSegments(
  text,
  annotations,
  selectedIndex,
  onSelectSpan,
  parsedQuery,
  subtypesByCategory = {},
  showAnnotationStateTags = true,
  showValidationTags = false,
) {
  const sorted = annotations
    .map((annotation, index) => ({ ...annotation, index }))
    .filter((annotation) => annotation._changeStatus !== 'deleted')
    .sort((a, b) => a.begin - b.begin || a.end - b.end);
  const pieces = [];
  let cursor = 0;
  const textSearch = parsedQuery?.textSearch;
  const hasKeyword = Boolean(textSearch);
  const highlightRanges = queryHighlightRanges({ text, annotations }, parsedQuery);

  for (const annotation of sorted) {
    const begin = Math.max(cursor, Math.min(annotation.begin, text.length));
    const end = Math.max(begin, Math.min(annotation.end, text.length));
    const spanText = text.slice(begin, end);
    const annotationLabel = spanLabel(annotation);
    const annotationIssue = spanValidationIssue(annotation, subtypesByCategory);
    const annotationIssueLabel = annotationIssue === 'subtype' ? 'subtype?' : 'label?';
    const spanHasKeyword =
      textIncludesKeyword(annotation, text, parsedQuery) ||
      highlightRanges.some((range) => rangesOverlap(range, { begin, end }));
    if (cursor < begin) {
      pieces.push(
        <span key={`text-${cursor}`}>
          {renderTextFragment(text.slice(cursor, begin), highlightRanges, `text-${cursor}`, cursor)}
        </span>,
      );
    }
    pieces.push(
      <span
        key={`span-${annotation.index}-${begin}-${end}`}
        className={`inline-span ${selectedIndex === annotation.index ? 'selected' : ''} ${
          annotation.confirmed ? 'confirmed' : ''
        } ${annotation._changeStatus ? `change-${annotation._changeStatus}` : ''} ${
          annotationIssue ? 'invalid' : ''
        } ${
          annotationIssue && showValidationTags ? 'blocked-invalid' : ''
        } ${
          showAnnotationStateTags ? '' : 'hide-tags'
        } ${
          hasKeyword && !spanHasKeyword ? 'keyword-muted' : ''
        }`}
        data-issue={annotationIssue ? annotationIssueLabel : undefined}
        role="button"
        tabIndex={0}
        style={{ '--span-color': annotationLabel ? labelColor(annotationLabel) : '#fff4d6' }}
        onClick={() => onSelectSpan(annotation.index)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectSpan(annotation.index);
          }
        }}
        title={`${annotationLabel || 'Unlabeled'} [${annotation.begin}, ${annotation.end})`}
      >
        {annotationLabel && (
          <span className="inline-span-label" aria-hidden="true">
            {annotationLabel}
          </span>
        )}
        <span className="inline-span-text">
          {renderTextFragment(spanText, highlightRanges, `span-${annotation.index}`, begin)}
        </span>
      </span>,
    );
    cursor = Math.max(cursor, end);
  }

  if (cursor < text.length) {
    pieces.push(
      <span key={`text-${cursor}`}>
        {renderTextFragment(text.slice(cursor), highlightRanges, `text-${cursor}`, cursor)}
      </span>,
    );
  }
  return pieces;
}

function App({ apiRoot = '/api', assignmentId = 'legacy', onWorkspaceState, workspaceControl } = {}) {
  const API_ROOT = apiRoot;
  const [pendingRequests, setPendingRequests] = React.useState(0);
  async function assignmentFetch(url, options) {
    const writing = options?.method && options.method !== 'GET';
    if (writing) setPendingRequests((n) => n + 1);
    try { return await fetch(url, options); }
    finally { if (writing) setPendingRequests((n) => n - 1); }
  }

  const [documents, setDocuments] = React.useState([]);
  const [savedDocuments, setSavedDocuments] = React.useState([]);
  const [labels, setLabels] = React.useState(FALLBACK_LABELS);
  const [categories, setCategories] = React.useState(CATEGORY_DEFINITIONS);
  const [subtypes, setSubtypes] = React.useState(SUBTYPE_DEFINITIONS);
  const [subtypesByCategory, setSubtypesByCategory] = React.useState(SUBTYPES_BY_CATEGORY);
  const [dataPath, setDataPath] = React.useState('');
  const [status, setStatus] = React.useState('Loading data...');
  const [query, setQuery] = React.useState('');
  // The query that is actually applied to filtering. The input edits `query`
  // freely; searching only runs when the user commits it (Enter), at which
  // point `submittedQuery` is updated.
  const [submittedQuery, setSubmittedQuery] = React.useState('');
  const [selectedDocId, setSelectedDocId] = React.useState(() => {
    try { return localStorage.getItem(`meddeid.annotate.${assignmentId}.position`) || null; } catch { return null; }
  });
  const [selectedSpanIndex, setSelectedSpanIndex] = React.useState(0);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = React.useState(-1);
  const [batchCategory, setBatchCategory] = React.useState('Address_Location');
  const [batchSubtype, setBatchSubtype] = React.useState('Caregiver');
  const [dirtyDocIds, setDirtyDocIds] = React.useState(() => new Set());
  const [undoStack, setUndoStack] = React.useState([]);
  const [redoStack, setRedoStack] = React.useState([]);
  const [draftRange, setDraftRange] = React.useState(null);
  const [continueToNextPendingAfterSave, setContinueToNextPendingAfterSave] = React.useState(() => {
    try {
      const stored = window.localStorage.getItem('annotationSettings.continueToNextPendingAfterSave');
      const legacy = window.localStorage.getItem('annotationSettings.continueToNextUnsavedAfterSave');
      return (stored ?? legacy) !== 'false';
    } catch {
      return true;
    }
  });
  const [showAnnotationStateTags, setShowAnnotationStateTags] = React.useState(() => {
    try {
      return window.localStorage.getItem('annotationSettings.showAnnotationStateTags') !== 'false';
    } catch {
      return true;
    }
  });
  const [editDocumentText, setEditDocumentText] = React.useState(() => {
    try {
      return window.localStorage.getItem('annotationSettings.editDocumentText') === 'true';
    } catch {
      return false;
    }
  });
  const [readerWidthMode, setReaderWidthMode] = React.useState(() => {
    try {
      const stored = window.localStorage.getItem('annotationSettings.readerWidthMode');
      return READER_WIDTH_MODES.some((mode) => mode.value === stored) ? stored : 'balanced';
    } catch {
      return 'balanced';
    }
  });
  const [autoSaveEnabled, setAutoSaveEnabled] = React.useState(() => {
    try {
      return window.localStorage.getItem('annotationSettings.autoSaveEnabled') !== 'false';
    } catch {
      return true;
    }
  });
  // Which save action the main Save button performs; mirrors the last option
  // chosen from the dropdown.
  const [lastSaveAction, setLastSaveAction] = React.useState(() => {
    try {
      const stored = window.localStorage.getItem('annotationSettings.lastSaveAction');
      return SAVE_ACTIONS.some((action) => action.value === stored) ? stored : 'current';
    } catch {
      return 'current';
    }
  });
  const readerRef = React.useRef(null);
  const textEditUndoSessionRef = React.useRef(null);
  const saveMenuRef = React.useRef(null);
  const settingsMenuRef = React.useRef(null);
  const queryInfoRef = React.useRef(null);
  const metadataMenuRef = React.useRef(null);

  function closePopoverMenus(except = null) {
    for (const ref of [saveMenuRef, settingsMenuRef, queryInfoRef, metadataMenuRef]) {
      if (ref.current && ref.current !== except) ref.current.open = false;
    }
  }

  function handlePopoverToggle(event) {
    if (event.currentTarget.open) closePopoverMenus(event.currentTarget);
  }

  const selectedDoc = React.useMemo(
    () => documents.find((doc) => doc.document_id === selectedDocId) ?? documents[0] ?? null,
    [documents, selectedDocId],
  );
  const selectedDocIsDirty = Boolean(selectedDoc && dirtyDocIds.has(selectedDoc.document_id));

  const parsedQuery = React.useMemo(
    () =>
      parseQuery(submittedQuery, {
        labels,
        categories: categories.map((category) => category.value),
        subtypes: subtypes.map((subtype) => subtype.value),
      }),
    [categories, labels, submittedQuery, subtypes],
  );
  const searchPending = query !== submittedQuery;

  const matches = React.useMemo(
    () => buildMatches(documents, parsedQuery, subtypesByCategory, dirtyDocIds),
    [dirtyDocIds, documents, parsedQuery, subtypesByCategory],
  );
  const queryIsValid = parsedQuery.invalidFilters.length === 0;

  const visibleDocumentIds = React.useMemo(() => {
    if (!parsedQuery.raw) return documents.map((doc) => doc.document_id);
    return Array.from(new Set(matches.map((match) => match.document_id)));
  }, [documents, matches, parsedQuery.raw]);

  const visibleDocuments = documents.filter((doc) => visibleDocumentIds.includes(doc.document_id));
  const selectedDocIndex = selectedDoc
    ? visibleDocuments.findIndex((doc) => doc.document_id === selectedDoc.document_id)
    : -1;
  const annotatedDocumentCount = React.useMemo(
    () => documents.filter(isDocumentAnnotated).length,
    [documents],
  );
  const annotatedProgress = React.useMemo(() => {
    const percent = documents.length > 0 ? (annotatedDocumentCount / documents.length) * 100 : 0;
    return {
      count: annotatedDocumentCount,
      total: documents.length,
      percent,
      label: formatPercent(percent),
    };
  }, [annotatedDocumentCount, documents.length]);

  const activeMatches = selectedDoc
    ? matches.filter(
        (match) =>
          match.document_id === selectedDoc.document_id &&
          (match.annotationIndex >= 0 || match.suggestionIndex >= 0),
      )
    : [];
  const visibleSpanRows = parsedQuery.raw
    ? activeMatches
    : selectedDoc?.annotations.map((span, index) => ({
        kind: 'annotation',
        document_id: selectedDoc.document_id,
        annotationIndex: index,
        suggestionIndex: -1,
        label: spanLabel(span),
        valid: spanIsValid(span, subtypesByCategory),
        issue: spanValidationIssue(span, subtypesByCategory),
        text: span.text,
        begin: span.begin,
        end: span.end,
        confirmed: span.confirmed,
        changeStatus: span._changeStatus,
        reviewType: suggestionReviewType(span),
        reviewStatus: suggestionReviewStatus(span),
      })) ?? [];
  const matchedSpans = React.useMemo(
    () => matches.filter((match) => match.annotationIndex >= 0 && match.changeStatus !== 'deleted'),
    [matches],
  );

  const selectedSpan =
    selectedDoc && selectedSpanIndex >= 0 ? selectedDoc.annotations[selectedSpanIndex] ?? null : null;
  const selectedSuggestion =
    selectedDoc && selectedSuggestionIndex >= 0 ? selectedDoc.suggestions?.[selectedSuggestionIndex] ?? null : null;

  const selectedSpanIssue = selectedSpan ? spanValidationIssue(selectedSpan, subtypesByCategory) : null;
  const selectedCategory = selectedSpan ? spanCategory(selectedSpan) : '';
  const selectedSubtype = selectedSpan ? spanSubtype(selectedSpan) : '';
  const selectedAllowedSubtypes = allowedSubtypesFor(selectedCategory, subtypesByCategory);
  const saveBlocked = status.startsWith('Cannot save');
  const saveBlockedMessage = status.includes('choose a subtype')
    ? 'Choose a subtype before saving.'
    : 'Assign a label before saving.';
  const batchAllowedSubtypes = allowedSubtypesFor(batchCategory, subtypesByCategory);
  const batchEffectiveSubtype = batchAllowedSubtypes.includes(batchSubtype) ? batchSubtype : '';
  const batchLabel = composeLabel(batchCategory, batchEffectiveSubtype);
  const keywordOccurrenceCount = React.useMemo(() => {
    if (!parsedQuery.textSearch) return 0;
    return visibleDocuments.reduce(
      (total, doc) => total + queryKeywordRanges(doc, parsedQuery).length,
      0,
    );
  }, [parsedQuery, visibleDocuments]);
  const selectedDocKeywordOccurrenceCount = React.useMemo(() => {
    if (!parsedQuery.textSearch || !selectedDoc) return 0;
    return queryKeywordRanges(selectedDoc, parsedQuery).length;
  }, [parsedQuery, selectedDoc]);
  const selectedMetadataEntries = React.useMemo(() => metadataEntries(selectedDoc), [selectedDoc]);

  const categoryByShortcut = React.useMemo(
    () =>
      Object.fromEntries(
        categories.filter((category) => category.key).map((category) => [category.key, category.value]),
      ),
    [categories],
  );

  const subtypeByShortcut = React.useMemo(
    () =>
      Object.fromEntries(
        subtypes.filter((subtype) => subtype.key).map((subtype) => [subtype.key, subtype.value]),
      ),
    [subtypes],
  );

  function snapshot(historySelection = null) {
    return {
      documents: cloneDocuments(documents),
      dirtyDocIds: Array.from(dirtyDocIds),
      selectedDocId: historySelection?.selectedDocId ?? selectedDocId,
      selectedSpanIndex: historySelection?.selectedSpanIndex ?? selectedSpanIndex,
      selectedSuggestionIndex:
        historySelection?.selectedSuggestionIndex ?? selectedSuggestionIndex,
    };
  }

  function recordUndo() {
    setUndoStack((current) => [...current.slice(-49), snapshot()]);
    setRedoStack([]);
  }

  function restoreSnapshot(nextSnapshot, { markAllDirty = false } = {}) {
    setDocuments(cloneDocuments(nextSnapshot.documents));
    setDirtyDocIds(
      new Set([
        ...nextSnapshot.dirtyDocIds,
        ...(markAllDirty ? nextSnapshot.documents.map((doc) => doc.document_id) : []),
      ]),
    );
    if (nextSnapshot.selectedDocId) {
      setSelectedDocId(nextSnapshot.selectedDocId);
      setSelectedSpanIndex(nextSnapshot.selectedSpanIndex ?? 0);
      setSelectedSuggestionIndex(nextSnapshot.selectedSuggestionIndex ?? -1);
    }
  }

  function undo() {
    setUndoStack((current) => {
      if (current.length === 0) return current;
      const previous = current[current.length - 1];
      setRedoStack((redo) => [...redo, snapshot(previous)]);
      restoreSnapshot(previous, { markAllDirty: true });
      setStatus(`Undid last change in ${previous.selectedDocId}; save affected documents to persist`);
      return current.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((current) => {
      if (current.length === 0) return current;
      const next = current[current.length - 1];
      setUndoStack((undoItems) => [...undoItems, snapshot(next)]);
      restoreSnapshot(next, { markAllDirty: true });
      setStatus(`Redid last change in ${next.selectedDocId}; save affected documents to persist`);
      return current.slice(0, -1);
    });
  }

  function applyBootstrapPayload(payload, nextStatus = null) {
    const incomingDocuments = fromApiDocuments(payload.documents ?? []);
    setDocuments(incomingDocuments);
    setSavedDocuments(cloneDocuments(incomingDocuments));
    setLabels(payload.labels ?? FALLBACK_LABELS);
    setCategories(payload.categories ?? CATEGORY_DEFINITIONS);
    setSubtypes(payload.subtypes ?? SUBTYPE_DEFINITIONS);
    setSubtypesByCategory(payload.subtypesByCategory ?? SUBTYPES_BY_CATEGORY);
    setDataPath(payload.dataPath ?? '');
    setDirtyDocIds(new Set());
    setUndoStack([]);
    setRedoStack([]);
    setSelectedSuggestionIndex(-1);
    setStatus(
      nextStatus ??
        `Loaded ${payload.stats?.documentCount ?? 0} documents, ${payload.stats?.spanCount ?? 0} spans, and ${
          payload.stats?.annotatedCount ?? 0
        } annotated documents`,
    );
    if (!payload.documents?.some((doc) => doc.document_id === selectedDocId) && payload.documents?.[0]) {
      setSelectedDocId(payload.documents[0].document_id);
      setSelectedSpanIndex(0);
    }
  }

  async function loadData() {
    setStatus('Loading data...');
    const response = await assignmentFetch(`${API_ROOT}/bootstrap`);
    if (!response.ok) throw new Error(await response.text());
    applyBootstrapPayload(await response.json());
  }

  React.useEffect(() => {
    loadData().catch((error) => setStatus(`Load failed: ${error.message}`));
  }, []);

  React.useLayoutEffect(() => {
    onWorkspaceState?.({
      dirty: dirtyDocIds.size > 0,
      saving: pendingRequests > 0,
      reviewed: savedDocuments.filter((doc) => doc.annotated === true).length,
      total: savedDocuments.length,
      save: () => saveAllDirtyDocuments({ preserveAnnotationState: true }),
    });
  });
  React.useEffect(() => {
    if (selectedDocId) {
      try { localStorage.setItem(`meddeid.annotate.${assignmentId}.position`, selectedDocId); } catch { /* storage may be unavailable */ }
    }
  }, [selectedDocId, assignmentId]);

  React.useEffect(() => {
    function dismissPopoverMenus(event) {
      const clickedInsideOpenMenu = [saveMenuRef, settingsMenuRef, queryInfoRef, metadataMenuRef].some(
        (ref) => ref.current?.open && ref.current.contains(event.target),
      );
      if (!clickedInsideOpenMenu) closePopoverMenus();
    }

    function dismissPopoverMenusWithKeyboard(event) {
      if (event.key === 'Escape') closePopoverMenus();
    }

    document.addEventListener('pointerdown', dismissPopoverMenus);
    document.addEventListener('keydown', dismissPopoverMenusWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', dismissPopoverMenus);
      document.removeEventListener('keydown', dismissPopoverMenusWithKeyboard);
    };
  }, []);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(
        'annotationSettings.continueToNextPendingAfterSave',
        String(continueToNextPendingAfterSave),
      );
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
  }, [continueToNextPendingAfterSave]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('annotationSettings.showAnnotationStateTags', String(showAnnotationStateTags));
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
  }, [showAnnotationStateTags]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('annotationSettings.editDocumentText', String(editDocumentText));
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
    if (editDocumentText) {
      setDraftRange(null);
      window.getSelection()?.removeAllRanges();
    }
  }, [editDocumentText]);

  React.useEffect(() => {
    textEditUndoSessionRef.current = null;
  }, [editDocumentText, selectedDocId]);

  React.useEffect(() => {
    // When switching to another document, scroll the reader back to the top
    // instead of keeping the previous document's scroll position.
    if (readerRef.current) {
      readerRef.current.scrollTop = 0;
    }
  }, [selectedDocId]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('annotationSettings.readerWidthMode', readerWidthMode);
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
  }, [readerWidthMode]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('annotationSettings.autoSaveEnabled', String(autoSaveEnabled));
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
  }, [autoSaveEnabled]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('annotationSettings.lastSaveAction', lastSaveAction);
    } catch {
      // Ignore storage failures; the in-memory setting still applies for this session.
    }
  }, [lastSaveAction]);

  React.useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      const token = event.key.toLowerCase();
      // Ctrl/Cmd+S, or Ctrl/Cmd+Enter as a fallback. Some browsers (e.g. GNOME
      // Epiphany/WebKitGTK) reserve Ctrl+S for "Save Page" at the window level
      // and never let the page suppress it, so Ctrl+Enter is offered as a
      // shortcut no browser intercepts.
      if ((event.metaKey || event.ctrlKey) && (token === 's' || token === 'enter')) {
        event.preventDefault();
        if (selectedDoc) {
          void saveDocument(selectedDoc.document_id, null, {
            continueToNextPending: continueToNextPendingAfterSave,
          });
        }
        return;
      }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && token === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && token === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        void confirmSelectedSpan();
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        deleteSelectedSpan();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (event.shiftKey) selectSpanByDelta(1);
        else selectDocumentByDelta(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (event.shiftKey) selectSpanByDelta(-1);
        else selectDocumentByDelta(-1);
        return;
      }
      if (categoryByShortcut[token] && selectedDoc && selectedSpan) {
        event.preventDefault();
        relabelSelectedSpan({ category: categoryByShortcut[token] });
        return;
      }
      if (subtypeByShortcut[token] && selectedDoc && selectedSpan) {
        event.preventDefault();
        relabelSelectedSpan({ subtype: subtypeByShortcut[token] });
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    categoryByShortcut,
    documents,
    dirtyDocIds,
    continueToNextPendingAfterSave,
    redoStack,
    selectedDoc,
    selectedDocIndex,
    savedDocuments,
    selectedSpan,
    selectedSpanIndex,
    subtypeByShortcut,
    undoStack,
    visibleDocuments,
  ]);

  function updateDocument(documentId, updater, { record = true } = {}) {
    if (record) recordUndo();
    setDocuments((current) =>
      current.map((doc) => {
        if (doc.document_id !== documentId) return doc;
        return updater(doc);
      }),
    );
    setDirtyDocIds((current) => new Set([...current, documentId]));
  }

  function findNextPendingDocumentId(afterDocumentId) {
    const isNextPending = (doc) =>
      doc.document_id !== afterDocumentId &&
      (!isDocumentAnnotated(doc) || dirtyDocIds.has(doc.document_id));
    const visibleIndex = visibleDocuments.findIndex((doc) => doc.document_id === afterDocumentId);
    const visibleOrderedDocuments =
      visibleIndex >= 0
        ? [...visibleDocuments.slice(visibleIndex + 1), ...visibleDocuments.slice(0, visibleIndex)]
        : visibleDocuments;
    const visibleMatch = visibleOrderedDocuments.find(isNextPending);
    if (visibleMatch) return visibleMatch.document_id;

    const documentIndex = documents.findIndex((doc) => doc.document_id === afterDocumentId);
    const orderedDocuments =
      documentIndex >= 0
        ? [...documents.slice(documentIndex + 1), ...documents.slice(0, documentIndex)]
        : documents;
    return orderedDocuments.find(isNextPending)?.document_id ?? null;
  }

  function validateDocumentForSave(doc) {
    const invalidCount = invalidSpanCount(doc, subtypesByCategory);
    if (invalidCount === 0) return true;

    const firstInvalidIndex = firstInvalidSpanIndex(doc, subtypesByCategory);
    const firstInvalidSpan = firstInvalidIndex >= 0 ? doc.annotations[firstInvalidIndex] : null;
    const issue = spanValidationIssue(firstInvalidSpan, subtypesByCategory);
    if (firstInvalidIndex >= 0) {
      setSelectedDocId(doc.document_id);
      setSelectedSpanIndex(firstInvalidIndex);
    }
    setStatus(`Cannot save ${doc.document_id}: ${issue === 'subtype' ? 'choose a subtype' : 'assign a label'} first`);
    return false;
  }

  function documentSavePayload(doc, { preserveAnnotationState = false } = {}) {
    const savedDoc = savedDocuments.find((entry) => entry.document_id === doc.document_id);
    // Wire payload uses the one canonical `spans` key.
    const payload = { spans: persistableAnnotations(doc.annotations) };
    if (!savedDoc || doc.text !== savedDoc.text) {
      payload.text = doc.text;
    }
    if (preserveAnnotationState) {
      // Persist the annotations without flipping the document's tracking state.
      // The server marks a document annotated on save unless told otherwise, so
      // echo the current state back to keep it unchanged.
      payload.annotated = isDocumentAnnotated(doc);
    }
    return payload;
  }

  function applySavedDocuments(nextSavedDocuments) {
    // Save responses use the canonical public schema (`spans`), just like the
    // bootstrap response. Convert them at the same boundary before inserting
    // them into the UI's internal `annotations` view model.
    const incomingDocuments = fromApiDocuments(nextSavedDocuments);
    const savedById = new Map(incomingDocuments.map((doc) => [doc.document_id, doc]));
    setDocuments((current) =>
      current.map((entry) => savedById.get(entry.document_id) ?? entry),
    );
    setSavedDocuments((current) => {
      const nextById = new Map(current.map((entry) => [entry.document_id, entry]));
      for (const doc of incomingDocuments) {
        nextById.set(doc.document_id, cloneDocuments([doc])[0]);
      }
      return Array.from(nextById.values());
    });
    setDirtyDocIds((current) => {
      const next = new Set(current);
      for (const doc of nextSavedDocuments) next.delete(doc.document_id);
      return next;
    });
  }

  function relabelSelectedSpan(change) {
    if (!selectedDoc || !selectedSpan) return;
    if (selectedSpan._changeStatus === 'deleted') {
      setStatus('Cannot relabel a span marked for deletion; undo to restore it');
      return;
    }
    updateDocument(selectedDoc.document_id, (doc) => ({
      ...doc,
      annotations: doc.annotations.map((span, index) =>
        index === selectedSpanIndex
          ? updateSpanCategorySubtype(span, change, doc.text, subtypesByCategory)
          : span,
      ),
    }));
    const nextCategory = change.category ?? selectedCategory;
    const requestedSubtype = change.subtype ?? selectedSubtype;
    const nextSubtype = allowedSubtypesFor(nextCategory, subtypesByCategory).includes(requestedSubtype)
      ? requestedSubtype
      : '';
    setStatus(`Changed selected span to ${composeLabel(nextCategory, nextSubtype)}`);
  }

  async function saveDocument(documentId, overrideDoc = null, { continueToNextPending = false } = {}) {
    const doc = overrideDoc ?? documents.find((entry) => entry.document_id === documentId);
    if (!doc) return false;
    if (!validateDocumentForSave(doc)) return false;
    setStatus(`Saving ${documentId}...`);
    const response = await assignmentFetch(`${API_ROOT}/documents/${encodeURIComponent(documentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(documentSavePayload(doc)),
    });
    if (!response.ok) {
      setStatus(`Save failed: ${await response.text()}`);
      return false;
    }
    const payload = await response.json();
    applySavedDocuments([payload.document]);
    const nextPendingDocumentId = continueToNextPending ? findNextPendingDocumentId(documentId) : null;
    if (nextPendingDocumentId) {
      selectDocument(nextPendingDocumentId);
      setStatus(`Saved ${documentId}; moved to ${nextPendingDocumentId}`);
    } else {
      setStatus(`Saved ${documentId}`);
    }
    return true;
  }

  async function saveAllDirtyDocuments({
    preserveAnnotationState = false,
    skipInvalid = false,
    silent = false,
  } = {}) {
    let docsToSave = documents.filter((doc) => dirtyDocIds.has(doc.document_id));
    if (docsToSave.length === 0) {
      if (!silent) setStatus('No unsaved documents to save');
      return true;
    }
    if (skipInvalid) {
      // Background auto-save shouldn't interrupt the user with validation
      // errors; just persist the documents that are currently valid.
      docsToSave = docsToSave.filter((doc) => invalidSpanCount(doc, subtypesByCategory) === 0);
      if (docsToSave.length === 0) return true;
    } else {
      for (const doc of docsToSave) {
        if (!validateDocumentForSave(doc)) return false;
      }
    }

    if (!silent) setStatus(`Saving ${docsToSave.length} documents...`);
    const savedDocs = [];
    for (const doc of docsToSave) {
      const response = await assignmentFetch(`${API_ROOT}/documents/${encodeURIComponent(doc.document_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documentSavePayload(doc, { preserveAnnotationState })),
      });
      if (!response.ok) {
        if (savedDocs.length > 0) applySavedDocuments(savedDocs);
        setStatus(`Save all failed at ${doc.document_id}: ${await response.text()}`);
        return false;
      }
      const payload = await response.json();
      savedDocs.push(payload.document);
    }

    applySavedDocuments(savedDocs);
    const noun = savedDocs.length === 1 ? 'document' : 'documents';
    setStatus(
      silent
        ? `Auto-saved ${savedDocs.length} ${noun}`
        : `Saved ${savedDocs.length} ${noun}${preserveAnnotationState ? ' (tracking state kept)' : ''}`,
    );
    return true;
  }

  // Dispatch the chosen save action and remember it so the main Save button
  // repeats it next time.
  function runSaveAction(action) {
    setLastSaveAction(action);
    if (action === 'all') {
      return saveAllDirtyDocuments();
    }
    if (action === 'all-keep') {
      return saveAllDirtyDocuments({ preserveAnnotationState: true });
    }
    if (!selectedDoc) return Promise.resolve(false);
    return saveDocument(selectedDoc.document_id, null, {
      continueToNextPending: continueToNextPendingAfterSave,
    });
  }

  // Keep a ref to the latest auto-save closure so the interval always sees
  // current state without resubscribing on every render.
  const autoSaveRef = React.useRef(null);
  autoSaveRef.current = () => {
    if (dirtyDocIds.size === 0) return;
    void saveAllDirtyDocuments({ preserveAnnotationState: true, skipInvalid: true, silent: true });
  };

  React.useEffect(() => {
    if (!autoSaveEnabled) return undefined;
    const intervalId = window.setInterval(() => {
      autoSaveRef.current?.();
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [autoSaveEnabled]);

  async function resetTracking() {
    if (
      dirtyDocIds.size > 0 &&
      !window.confirm('Reset tracking will reload the data and discard unsaved local changes. Continue?')
    ) {
      return false;
    }

    setStatus('Resetting annotation tracking...');
    const response = await assignmentFetch(`${API_ROOT}/tracking/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      setStatus(`Reset tracking failed: ${await response.text()}`);
      return false;
    }

    const payload = await response.json();
    applyBootstrapPayload(
      payload.bootstrap,
      `Reset tracking for ${payload.changed ?? 0} annotated documents`,
    );
    return true;
  }

  function reloadSelectedDocument() {
    if (!selectedDoc || !dirtyDocIds.has(selectedDoc.document_id)) return;
    const savedDoc = savedDocuments.find((doc) => doc.document_id === selectedDoc.document_id);
    if (!savedDoc) {
      setStatus(`Cannot reload ${selectedDoc.document_id}: no saved copy is available`);
      return;
    }

    recordUndo();
    const restoredDoc = cloneDocuments([savedDoc])[0];
    setDocuments((current) =>
      current.map((doc) => (doc.document_id === restoredDoc.document_id ? restoredDoc : doc)),
    );
    setDirtyDocIds((current) => {
      const next = new Set(current);
      next.delete(restoredDoc.document_id);
      return next;
    });
    setSelectedSpanIndex(0);
    setDraftRange(null);
    window.getSelection()?.removeAllRanges();
    setStatus(`Reloaded ${restoredDoc.document_id}; discarded unsaved changes for this document only`);
  }

  function handleDocumentTextChange(nextText) {
    if (!selectedDoc || nextText === selectedDoc.text) return;
    if (textEditUndoSessionRef.current !== selectedDoc.document_id) {
      recordUndo();
      textEditUndoSessionRef.current = selectedDoc.document_id;
    }

    const nextAnnotations = adjustAnnotationsForTextChange({
      annotations: selectedDoc.annotations,
      oldText: selectedDoc.text,
      newText: nextText,
    });
    const maxSpanIndex = nextAnnotations.length > 0 ? nextAnnotations.length - 1 : 0;
    setDocuments((current) =>
      current.map((doc) =>
        doc.document_id === selectedDoc.document_id
          ? {
              ...doc,
              text: nextText,
              annotations: nextAnnotations,
            }
          : doc,
      ),
    );
    setDirtyDocIds((current) => new Set([...current, selectedDoc.document_id]));
    setSelectedSpanIndex((index) => Math.max(0, Math.min(index, maxSpanIndex)));
    setSelectedSuggestionIndex(-1);
    setDraftRange(null);
    setStatus(`Edited ${selectedDoc.document_id} text; save document to persist`);
  }

  async function confirmSelectedSpan() {
    if (!selectedDoc || !selectedSpan) return;
    if (selectedSpan._changeStatus === 'deleted') {
      setStatus('Cannot confirm a span marked for deletion; undo to restore it');
      return;
    }
    if (!spanHasLabel(selectedSpan)) {
      setStatus('Choose a label before confirming this span');
      return;
    }
    if (requiresSubtype(selectedCategory, subtypesByCategory) && !selectedSubtype) {
      setStatus(`Choose a subtype before confirming ${selectedCategory}`);
      return;
    }

    recordUndo();
    const nextDoc = {
      ...selectedDoc,
      annotations: selectedDoc.annotations.map((span, index) =>
        index === selectedSpanIndex ? markSpanConfirmed(span, selectedDoc.text) : span,
      ),
    };
    setDocuments((current) => current.map((doc) => (doc.document_id === nextDoc.document_id ? nextDoc : doc)));
    setDirtyDocIds((current) => new Set([...current, nextDoc.document_id]));
    await saveDocument(nextDoc.document_id, nextDoc);
    setStatus(`Confirmed ${nextDoc.document_id} span ${selectedSpanIndex + 1}`);
    selectSpanByDelta(1);
  }

  function batchRelabel() {
    const spanMatches = matchedSpans;
    if (spanMatches.length === 0) return;
    if (requiresSubtype(batchCategory, subtypesByCategory) && !batchAllowedSubtypes.includes(batchSubtype)) {
      setStatus(`Choose a subtype before batch relabeling ${batchCategory}`);
      return;
    }

    recordUndo();
    const grouped = new Map();
    for (const match of spanMatches) {
      if (!grouped.has(match.document_id)) grouped.set(match.document_id, new Set());
      grouped.get(match.document_id).add(match.annotationIndex);
    }

    setDocuments((current) =>
      current.map((doc) => {
        const indexes = grouped.get(doc.document_id);
        if (!indexes) return doc;
        return {
          ...doc,
          annotations: doc.annotations.map((span, index) =>
            indexes.has(index)
              ? updateSpanCategorySubtype(
                  span,
                  { category: batchCategory, subtype: batchAllowedSubtypes.includes(batchSubtype) ? batchSubtype : '' },
                  doc.text,
                  subtypesByCategory,
                )
              : span,
          ),
        };
      }),
    );
    setDirtyDocIds((current) => new Set([...current, ...grouped.keys()]));
    setStatus(`Batch relabeled ${spanMatches.length} spans to ${batchLabel}; save documents to persist`);
  }

  function createSpanFromDraftRange() {
    if (!selectedDoc || !draftRange) return;
    createSpanFromRange(draftRange);
  }

  function createSpanFromRange(range) {
    if (!selectedDoc || !range) return false;
    if (range.begin < 0 || range.end > selectedDoc.text.length || range.begin >= range.end) {
      setStatus('Select text inside the document before creating a span');
      return false;
    }
    // Don't overwrite a larger span that fully contains this range — keep it
    // and refuse, since the new span would just be a nested subspan.
    const containing = strictlyContainingAnnotation(range, selectedDoc.annotations);
    if (containing) {
      setStatus(
        `Kept existing span ${spanLabel(containing) || '(unlabeled)'}; new selection sits inside it as a subspan`,
      );
      window.getSelection()?.removeAllRanges();
      setDraftRange(null);
      return false;
    }
    // Overwrite: replace spans the new range covers or crosses.
    const overwritten = overlappingAnnotations(range, selectedDoc.annotations).length;
    const baseAnnotations = removeOverlappingAnnotations(selectedDoc.annotations, range);

    const created = makeAnnotation({
      begin: range.begin,
      end: range.end,
      docText: selectedDoc.text,
      category: batchCategory,
      subtype: batchEffectiveSubtype,
    });
    const nextAnnotations = sortAnnotations([...baseAnnotations, created]);
    const createdIndex = nextAnnotations.findIndex(
      (annotation) => annotation.begin === created.begin && annotation.end === created.end,
    );
    updateDocument(selectedDoc.document_id, (doc) => ({ ...doc, annotations: nextAnnotations }));
    setSelectedSpanIndex(createdIndex);
    setStatus(
      overwritten > 0
        ? `Created ${batchLabel} span [${range.begin}, ${range.end}); overwrote ${overwritten} overlapping span${
            overwritten === 1 ? '' : 's'
          }`
        : `Created ${batchLabel} span [${range.begin}, ${range.end})`,
    );
    window.getSelection()?.removeAllRanges();
    setDraftRange(null);
    return true;
  }

  function batchCreateKeywordSpans() {
    if (!parsedQuery.textSearch) {
      setStatus('Enter text or regex before batch creating spans');
      return;
    }

    // Confirm before clobbering existing spans across potentially many documents.
    // Ranges that sit inside a larger existing span are skipped (kept as-is), so
    // they don't count toward the overwrite total.
    let plannedOverwrite = 0;
    for (const doc of documents) {
      if (!visibleDocumentIds.includes(doc.document_id)) continue;
      for (const range of queryKeywordRanges(doc, parsedQuery)) {
        if (strictlyContainingAnnotation(range, doc.annotations)) continue;
        plannedOverwrite += overlappingAnnotations(range, doc.annotations).length;
      }
    }
    if (
      plannedOverwrite > 0 &&
      !window.confirm(
        `This will overwrite ${plannedOverwrite} existing span${
          plannedOverwrite === 1 ? '' : 's'
        } overlapping the matches. Continue?`,
      )
    ) {
      return;
    }

    let createdCount = 0;
    let overwrittenCount = 0;
    let skippedSubspans = 0;
    const touchedDocIds = new Set();
    const nextDocuments = documents.map((doc) => {
      if (!visibleDocumentIds.includes(doc.document_id)) return doc;
      let nextAnnotations = [...doc.annotations];
      let changed = false;
      for (const range of queryKeywordRanges(doc, parsedQuery)) {
        // Keep a larger span that contains this match; skip creating a subspan.
        if (strictlyContainingAnnotation(range, nextAnnotations)) {
          skippedSubspans += 1;
          continue;
        }
        overwrittenCount += overlappingAnnotations(range, nextAnnotations).length;
        // Overwrite spans the match covers or crosses, then add the new span.
        nextAnnotations = removeOverlappingAnnotations(nextAnnotations, range);
        nextAnnotations.push(
          makeAnnotation({
            begin: range.begin,
            end: range.end,
            docText: doc.text,
            category: batchCategory,
            subtype: batchEffectiveSubtype,
          }),
        );
        createdCount += 1;
        changed = true;
        touchedDocIds.add(doc.document_id);
      }
      if (!changed) return doc;
      return { ...doc, annotations: sortAnnotations(nextAnnotations) };
    });
    if (createdCount === 0) {
      setStatus(
        skippedSubspans > 0
          ? `No spans created; ${skippedSubspans} match${
              skippedSubspans === 1 ? '' : 'es'
            } already sit inside a larger span`
          : 'No text occurrences to create',
      );
      return;
    }
    recordUndo();
    setDocuments(nextDocuments);
    setDirtyDocIds((current) => new Set([...current, ...touchedDocIds]));
    const overwroteNote =
      overwrittenCount > 0
        ? `; overwrote ${overwrittenCount} overlapping span${overwrittenCount === 1 ? '' : 's'}`
        : '';
    const skippedNote =
      skippedSubspans > 0
        ? `; kept ${skippedSubspans} match${skippedSubspans === 1 ? '' : 'es'} nested in a larger span`
        : '';
    setStatus(`Created ${createdCount} ${batchLabel} spans${overwroteNote}${skippedNote}`);
  }

  function deleteSelectedSpan() {
    if (!selectedDoc || !selectedSpan) return;
    const deletedLabel = spanLabel(selectedSpan);
    updateDocument(selectedDoc.document_id, (doc) => ({
      ...doc,
      annotations:
        selectedSpan._changeStatus === 'added'
          ? doc.annotations.filter((_span, index) => index !== selectedSpanIndex)
          : doc.annotations.map((span, index) =>
              index === selectedSpanIndex ? { ...span, confirmed: false, _changeStatus: 'deleted' } : span,
            ),
    }));
    setSelectedSpanIndex((index) => Math.max(0, Math.min(index, selectedDoc.annotations.length - 2)));
    setStatus(`Deleted selected span ${deletedLabel}; save document to persist`);
  }

  function applySelectedSuggestion() {
    if (!selectedDoc || !selectedSuggestion) return;
    const candidate = makeAnnotationFromSuggestion(selectedSuggestion, selectedDoc.text);
    const existingIndex = Number(selectedSuggestion.existing?.annotationIndex);
    const nextAnnotations =
      Number.isInteger(existingIndex) && existingIndex >= 0 && existingIndex < selectedDoc.annotations.length
        ? sortAnnotations(selectedDoc.annotations.map((span, index) => (index === existingIndex ? candidate : span)))
        : sortAnnotations([...selectedDoc.annotations, candidate]);
    const nextSelectedSpanIndex = nextAnnotations.findIndex(
      (annotation) => annotation.begin === candidate.begin && annotation.end === candidate.end && spanLabel(annotation) === candidate.label,
    );

    updateDocument(selectedDoc.document_id, (doc) => ({ ...doc, annotations: nextAnnotations }));
    selectSpan(Math.max(0, nextSelectedSpanIndex));
    setStatus(`Applied ${selectedSuggestion.reviewType || 'suggestion'}; save document to persist`);
  }

  function batchDeleteMatchingSpans() {
    const spanMatches = matchedSpans;
    if (spanMatches.length === 0) return;

    recordUndo();
    const grouped = new Map();
    for (const match of spanMatches) {
      if (!grouped.has(match.document_id)) grouped.set(match.document_id, new Set());
      grouped.get(match.document_id).add(match.annotationIndex);
    }
    setDocuments((current) =>
      current.map((doc) => {
        const indexes = grouped.get(doc.document_id);
        if (!indexes) return doc;
        return {
          ...doc,
          annotations: doc.annotations.flatMap((span, index) => {
            if (!indexes.has(index)) return [span];
            if (span._changeStatus === 'added') return [];
            return [{ ...span, confirmed: false, _changeStatus: 'deleted' }];
          }),
        };
      }),
    );
    setDirtyDocIds((current) => new Set([...current, ...grouped.keys()]));
    setSelectedSpanIndex(0);
    setStatus(`Deleted ${spanMatches.length} matching spans; save documents to persist`);
  }

  function selectSpan(index) {
    setSelectedSpanIndex(index);
    setSelectedSuggestionIndex(-1);
  }

  function selectSuggestion(index) {
    setSelectedSpanIndex(-1);
    setSelectedSuggestionIndex(index);
  }

  function selectMatch(match) {
    if (match?.suggestionIndex >= 0) {
      selectSuggestion(match.suggestionIndex);
      return;
    }
    selectSpan(match?.annotationIndex ?? 0);
  }

  function selectDocument(documentId) {
    setSelectedDocId(documentId);
    const firstMatch = matches.find(
      (match) =>
        match.document_id === documentId &&
        (match.annotationIndex >= 0 || match.suggestionIndex >= 0),
    );
    selectMatch(firstMatch ?? { annotationIndex: 0, suggestionIndex: -1 });
  }

  function selectDocumentByDelta(delta) {
    if (visibleDocuments.length === 0) return;
    const currentIndex = Math.max(0, selectedDocIndex);
    const nextIndex = Math.max(0, Math.min(visibleDocuments.length - 1, currentIndex + delta));
    selectDocument(visibleDocuments[nextIndex].document_id);
  }

  function selectSpanByDelta(delta) {
    if (!selectedDoc || selectedDoc.annotations.length === 0) return;
    setSelectedSuggestionIndex(-1);
    setSelectedSpanIndex((index) => Math.max(0, Math.min(selectedDoc.annotations.length - 1, Math.max(0, index) + delta)));
  }

  function handleBatchCategoryChange(category) {
    const allowed = allowedSubtypesFor(category, subtypesByCategory);
    setBatchCategory(category);
    setBatchSubtype(allowed[0] ?? '');
  }

  function updateDraftRangeFromSelection(event) {
    if (editDocumentText) return;
    const container = readerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setDraftRange(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      setDraftRange(null);
      return;
    }

    const startOffset = textOffsetFromDomPoint(container, range.startContainer, range.startOffset);
    const endOffset = textOffsetFromDomPoint(container, range.endContainer, range.endOffset);
    if (startOffset === null || endOffset === null) {
      setDraftRange(null);
      return;
    }
    const nextRange = {
      begin: Math.max(0, Math.min(startOffset, endOffset)),
      end: Math.max(startOffset, endOffset),
    };
    if (nextRange.begin === nextRange.end) {
      setDraftRange(null);
      return;
    }
    const rangeToCreate =
      event?.ctrlKey || event?.metaKey ? nextRange : normalizeRangeToWordBoundaries(nextRange, selectedDoc?.text);
    setDraftRange(rangeToCreate);
    createSpanFromRange(rangeToCreate);
  }

  function textOffsetFromDomPoint(container, node, offset) {
    try {
      const range = document.createRange();
      range.setStart(container, 0);
      range.setEnd(node, offset);
      return countReaderText(range.cloneContents());
    } catch {
      return null;
    }
  }

  function countReaderText(root) {
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.parentElement?.closest('[data-text-start]')) {
        total += node.textContent?.length ?? 0;
      }
      node = walker.nextNode();
    }
    return total;
  }

  return (
    <div className={`app-shell layout-${readerWidthMode}`}>
      <header className="topbar">
        <div>
          <div className="ws-editor-title"><h1>Document review</h1>{workspaceControl}</div>
          <p>{dataPath || 'data/annotations.jsonl'}</p>
        </div>
        <div
          className="progress-summary"
          aria-label={`${annotatedProgress.count} of ${annotatedProgress.total} texts annotated`}
        >
          <div className="progress-copy">
            <strong>{annotatedProgress.count}/{annotatedProgress.total} texts annotated</strong>
            <span>{annotatedProgress.label}</span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${annotatedProgress.percent}%` }} />
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="icon-button secondary" onClick={() => undo()} disabled={undoStack.length === 0}>
            <Undo2 size={16} />
            Undo
          </button>
          <button type="button" className="icon-button secondary" onClick={() => redo()} disabled={redoStack.length === 0}>
            <Redo2 size={16} />
            Redo
          </button>
          <button
            type="button"
            className="icon-button secondary"
            onClick={() => reloadSelectedDocument()}
            disabled={!selectedDocIsDirty}
            title="Discard unsaved changes for the current document only"
          >
            <RefreshCw size={16} />
            Reload doc
          </button>
          <div className="save-split">
            <button
              type="button"
              className="icon-button primary save-main"
              onClick={() => runSaveAction(lastSaveAction)}
              disabled={lastSaveAction === 'current' ? !selectedDoc : dirtyDocIds.size === 0}
              title={`Save · ${
                SAVE_ACTIONS.find((action) => action.value === lastSaveAction)?.label
              } (Ctrl+S or Ctrl+Enter)`}
            >
              <Save size={16} />
              Save
              <span className="save-action-label">
                {SAVE_ACTIONS.find((action) => action.value === lastSaveAction)?.label}
              </span>
            </button>
            <details className="save-menu" ref={saveMenuRef} onToggle={handlePopoverToggle}>
              <summary
                className="icon-button primary save-summary"
                aria-label="Save options"
                title="Save options"
              >
                <ChevronDown className="save-chevron" size={15} aria-hidden="true" />
              </summary>
              <div className="save-popover">
                {SAVE_ACTIONS.map((action) => {
                  const isAll = action.value !== 'current';
                  return (
                    <button
                      key={action.value}
                      type="button"
                      className={`menu-action ${lastSaveAction === action.value ? 'active' : ''}`}
                      onClick={() => {
                        if (saveMenuRef.current) saveMenuRef.current.open = false;
                        runSaveAction(action.value);
                      }}
                      disabled={isAll ? dirtyDocIds.size === 0 : !selectedDoc}
                    >
                      {action.label}
                      {isAll ? ` (${dirtyDocIds.size})` : ''}
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
          <details className="settings-menu" ref={settingsMenuRef} onToggle={handlePopoverToggle}>
            <summary className="icon-button secondary settings-summary" aria-label="Settings" title="Settings">
              <Settings size={17} />
            </summary>
            <div className="settings-popover">
              <strong>Settings</strong>
              <label className="settings-option">
                <span>Continue to next pending document after saving</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={continueToNextPendingAfterSave}
                    onChange={(event) => setContinueToNextPendingAfterSave(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
              <label className="settings-option">
                <span>Auto-save every 2 min (keep tracking state)</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={autoSaveEnabled}
                    onChange={(event) => setAutoSaveEnabled(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
              <label className="settings-option">
                <span>Show annotation state tags</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={showAnnotationStateTags}
                    onChange={(event) => setShowAnnotationStateTags(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
              <label className="settings-option">
                <span>Edit document text</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={editDocumentText}
                    onChange={(event) => setEditDocumentText(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
              <div className="settings-option stacked">
                <span>Text column width</span>
                <div className="segmented-control" role="group" aria-label="Text column width">
                  {READER_WIDTH_MODES.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      className={readerWidthMode === mode.value ? 'active' : ''}
                      aria-pressed={readerWidthMode === mode.value}
                      onClick={() => setReaderWidthMode(mode.value)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="icon-button danger full" onClick={() => resetTracking()}>
                <RefreshCw size={16} />
                Reset tracking
              </button>
            </div>
          </details>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="search-panel">
            <div className="field-label-row">
              <label className="field-label" htmlFor="keyword">
                Query
              </label>
              <details className="query-info" ref={queryInfoRef} onToggle={handlePopoverToggle}>
                <summary aria-label="Show query language rules" title="Query rules">
                  <Info size={15} />
                </summary>
                <div className="query-info-popover">
                  <strong>How to search</strong>
                  <p>Combine any of these, then press Enter.</p>
                  <dl className="query-rule-list">
                    <div>
                      <dt>text</dt>
                      <dd>Words in the document</dd>
                      <code>Janssens</code>
                    </div>
                    <div>
                      <dt>category:</dt>
                      <dd>Span category</dd>
                      <code>category:Name</code>
                    </div>
                    <div>
                      <dt>subtype:</dt>
                      <dd>Span subtype</dd>
                      <code>subtype:Patient</code>
                    </div>
                    <div>
                      <dt>label:</dt>
                      <dd>Full span label</dd>
                      <code>label:Name:Patient</code>
                    </div>
                    <div>
                      <dt>doc:</dt>
                      <dd>Document ID</dd>
                      <code>doc:note-42</code>
                    </div>
                    <div>
                      <dt>saved:</dt>
                      <dd>Saved changes</dd>
                      <code>saved:false</code>
                    </div>
                    <div>
                      <dt>annotated:</dt>
                      <dd>Tracking status</dd>
                      <code>annotated:false</code>
                    </div>
                    <div>
                      <dt>regex:</dt>
                      <dd>Text pattern</dd>
                      <code>{'regex:/\\d+/'}</code>
                    </div>
                  </dl>
                  <p><strong>Tip:</strong> Values are partial and case-insensitive. Use quotes for an exact match.</p>
                  <p>
                    For category/subtype, use commas to combine values and <code>-value</code> to exclude one:
                    {' '}<code>category:any,-Name</code>.
                  </p>
                  <p>
                    Also available: <code>cat:</code>, <code>sub:</code>, <code>re:</code>,
                    {' '}<code>not_category:</code>, <code>not_subtype:</code>, and <code>not_label:</code>.
                  </p>
                </div>
              </details>
            </div>
            <div className={`search-box ${searchPending ? 'pending' : ''}`}>
              <Search size={17} />
              <input
                id="keyword"
                value={query}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setQuery(nextValue);
                  // Clearing the field resets immediately to all documents,
                  // without waiting for Enter.
                  if (nextValue.trim() === '') setSubmittedQuery('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setSubmittedQuery(query);
                  }
                }}
                placeholder={'regex:/\\d+/ category:any,-Name annotated:false review:pending'}
              />
            </div>
            <div className="match-summary">
              <Filter size={15} />
              {searchPending
                ? 'Press Enter to search'
                : parsedQuery.invalidFilters.length > 0
                  ? `Invalid filter: ${parsedQuery.invalidFilters.join(', ')}`
                  : `${visibleDocuments.length} docs, ${
                      matches.filter((match) => match.annotationIndex >= 0 || match.suggestionIndex >= 0).length
                    } matching spans/suggestions`}
            </div>
          </section>

          <section className="document-list" aria-label="Documents">
            {visibleDocuments.map((doc) => {
              const spanHits = matches.filter(
                (match) =>
                  match.document_id === doc.document_id &&
                  (match.annotationIndex >= 0 || match.suggestionIndex >= 0),
              ).length;
              return (
                <button
                  key={doc.document_id}
                  type="button"
                  className={`document-row ${doc.annotated ? 'annotated' : 'unannotated'} ${
                    selectedDoc?.document_id === doc.document_id ? 'active' : ''
                  }`}
                  onClick={() => selectDocument(doc.document_id)}
                >
                  <span>
                    <strong>{doc.document_id}</strong>
                    <small>
                      {visibleSpanCount(doc)} spans{isDocumentAnnotated(doc) ? ', annotated' : ''}
                      {doc.suggestionStats?.pendingCount ? `, ${doc.suggestionStats.pendingCount} suggestions` : ''}
                    </small>
                  </span>
                  <span className="doc-badges">
                    {dirtyDocIds.has(doc.document_id) && <em>unsaved</em>}
                    {doc.annotated && <i>annotated</i>}
                    {doc.suggestionStats?.pendingCount ? <em>{doc.suggestionStats.pendingCount} review</em> : null}
                    {parsedQuery.raw && <b>{spanHits}</b>}
                  </span>
                </button>
              );
            })}
          </section>
        </aside>

        <section className="reader">
          {selectedDoc ? (
            <>
              <div className="reader-header">
                <div>
                  <h2>{selectedDoc.document_id}</h2>
                  <p>
                    {selectedDocIndex + 1 || 1}/{visibleDocuments.length || documents.length} texts,{' '}
                    {selectedDoc.text.length.toLocaleString()} characters, {visibleSpanCount(selectedDoc)} spans
                    {selectedDoc.suggestions?.length ? `, ${selectedDoc.suggestions.length} suggestions` : ''}
                  </p>
                </div>
                <div className="status-stack">
                  <div className="status-pill">
                    <CircleDot size={14} />
                    {dirtyDocIds.has(selectedDoc.document_id)
                      ? 'Unsaved changes'
                      : selectedDoc.annotated
                        ? 'Annotated'
                        : 'Not annotated'}
                  </div>
                  <details className="metadata-menu" ref={metadataMenuRef} onToggle={handlePopoverToggle}>
                    <summary className="icon-button secondary metadata-summary" aria-label="Show document metadata" title="Show metadata">
                      <Info size={15} />
                      Metadata
                    </summary>
                    <div className="metadata-popover">
                      <strong>Metadata</strong>
                      {selectedMetadataEntries.length > 0 ? (
                        <dl>
                          {selectedMetadataEntries.map((entry) => (
                            <React.Fragment key={entry.key}>
                              <dt>{entry.label}</dt>
                              <dd>{entry.value}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      ) : (
                        <p>No metadata for this document.</p>
                      )}
                      <dl>
                        <dt>Tracking</dt>
                        <dd>{selectedDoc.annotated ? 'Annotated' : 'Not annotated'}</dd>
                      </dl>
                    </div>
                  </details>
                  {saveBlocked && <div className="save-inline-message">{saveBlockedMessage}</div>}
                </div>
              </div>
              <article
                className={`text-canvas ${editDocumentText ? 'text-canvas-editing' : ''}`}
                ref={readerRef}
                onMouseUp={editDocumentText ? undefined : (event) => updateDraftRangeFromSelection(event)}
                onKeyUp={editDocumentText ? undefined : (event) => updateDraftRangeFromSelection(event)}
              >
                {editDocumentText ? (
                  <textarea
                    className="text-editor"
                    value={selectedDoc.text}
                    onChange={(event) => handleDocumentTextChange(event.target.value)}
                    onBlur={() => {
                      textEditUndoSessionRef.current = null;
                    }}
                    aria-label={`Edit text for ${selectedDoc.document_id}`}
                    spellCheck={false}
                  />
                ) : (
                  <div className="text-content">
                    {textSegments(
                      selectedDoc.text,
                      selectedDoc.annotations,
                      selectedSpanIndex,
                      selectSpan,
                      parsedQuery,
                      subtypesByCategory,
                      showAnnotationStateTags,
                      saveBlocked,
                    )}
                  </div>
                )}
              </article>
            </>
          ) : (
            <div className="empty-state">No documents loaded.</div>
          )}
        </section>

        <aside className="inspector">
          <section className="panel">
            <div className="panel-title">
              <Keyboard size={16} />
              Category
            </div>
            <div className="shortcut-grid compact">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.value}
                  className={`shortcut ${selectedCategory === category.value ? 'active' : ''}`}
                  style={{ '--label-color': labelColor(category.value) }}
                  onClick={() => relabelSelectedSpan({ category: category.value })}
                  disabled={!selectedSpan || selectedSpan._changeStatus === 'deleted'}
                  title={`Set category: ${category.value}`}
                >
                  {category.key && <kbd>{category.key}</kbd>}
                  <span>{category.value}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <Keyboard size={16} />
              Subtype
            </div>
            <div className="shortcut-grid compact">
              {subtypes.map((subtype) => {
                const enabled = selectedAllowedSubtypes.includes(subtype.value);
                return (
                  <button
                    type="button"
                    key={subtype.value}
                    className={`shortcut ${selectedSubtype === subtype.value ? 'active' : ''}`}
                    style={{ '--label-color': labelColor(subtype.value) }}
                    onClick={() => relabelSelectedSpan({ subtype: subtype.value })}
                    disabled={!selectedSpan || selectedSpan._changeStatus === 'deleted' || !enabled}
                    title={enabled ? `Set subtype: ${subtype.value}` : `Subtype not valid for ${selectedCategory || 'category'}`}
                  >
                    {subtype.key && <kbd>{subtype.key}</kbd>}
                    <span>{subtype.value}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className={`panel ${selectedSpan?._changeStatus ? `change-${selectedSpan._changeStatus}` : ''}`}>
            <div className="panel-title">Selected span</div>
            {selectedSpan ? (
              <div className="span-detail">
                <strong>{selectedSpan.text}</strong>
                <span>
                  [{selectedSpan.begin}, {selectedSpan.end}){' '}
                  {selectedSpan._changeStatus === 'added'
                    ? selectedSpanIssue === 'label'
                      ? 'needs label before saving'
                      : selectedSpanIssue === 'subtype'
                        ? 'needs subtype before saving'
                        : 'new, unsaved'
                    : selectedSpan._changeStatus === 'changed'
                      ? 'changed, unsaved'
                      : selectedSpan._changeStatus === 'deleted'
                        ? 'deleted when saved'
                        : selectedSpan.confirmed
                          ? 'confirmed'
                          : 'unconfirmed'}
                </span>
                {selectedSpan.suggestionReview && (
                  <span className="review-badge">
                    {selectedSpan.suggestionReview.status} {selectedSpan.suggestionReview.type}
                  </span>
                )}
                <label className="field-label" htmlFor="selected-category">
                  Category
                </label>
                <select
                  id="selected-category"
                  value={selectedCategory}
                  onChange={(event) => relabelSelectedSpan({ category: event.target.value })}
                  disabled={selectedSpan._changeStatus === 'deleted'}
                >
                  <option value="">No label</option>
                  {categories.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.value}
                    </option>
                  ))}
                </select>
                <label className="field-label" htmlFor="selected-subtype">
                  Subtype
                </label>
                <select
                  id="selected-subtype"
                  value={selectedSubtype}
                  onChange={(event) => relabelSelectedSpan({ subtype: event.target.value })}
                  disabled={selectedAllowedSubtypes.length === 0 || selectedSpan._changeStatus === 'deleted'}
                >
                  <option value="">No subtype</option>
                  {selectedAllowedSubtypes.map((subtype) => (
                    <option key={subtype} value={subtype}>
                      {subtype}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button primary full"
                  onClick={() => confirmSelectedSpan()}
                  disabled={selectedSpan._changeStatus === 'deleted' || Boolean(selectedSpanIssue)}
                >
                  <Check size={16} />
                  Confirm span
                </button>
                <button type="button" className="icon-button danger full" onClick={() => deleteSelectedSpan()}>
                  <Trash2 size={16} />
                  Delete span
                </button>
              </div>
            ) : selectedSuggestion ? (
              <div className="span-detail">
                <strong>{selectedSuggestion.text}</strong>
                <span>
                  [{selectedSuggestion.begin}, {selectedSuggestion.end}) {spanLabel(selectedSuggestion)}
                </span>
                <span className="review-badge">
                  {selectedSuggestion.reviewStatus} {selectedSuggestion.reviewType}
                </span>
                {selectedSuggestion.existing && (
                  <span>
                    Existing: {selectedSuggestion.existing.label} [{selectedSuggestion.existing.begin},{' '}
                    {selectedSuggestion.existing.end})
                  </span>
                )}
                <button type="button" className="icon-button primary full" onClick={() => applySelectedSuggestion()}>
                  <Check size={16} />
                  Apply suggestion
                </button>
              </div>
            ) : (
              <p className="muted">Select a highlighted span or suggestion.</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-title">
              <Replace size={16} />
              Batch relabel
            </div>
            <p className="muted">
              Existing-span actions apply to all matching spans in the filtered documents, not just the open text.
            </p>
            <label className="field-label" htmlFor="batch-category">
              Category
            </label>
            <select id="batch-category" value={batchCategory} onChange={(event) => handleBatchCategoryChange(event.target.value)}>
              {categories.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.value}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="batch-subtype">
              Subtype
            </label>
            <select
              id="batch-subtype"
              value={batchAllowedSubtypes.includes(batchSubtype) ? batchSubtype : ''}
              onChange={(event) => setBatchSubtype(event.target.value)}
              disabled={batchAllowedSubtypes.length === 0}
            >
              <option value="">No subtype</option>
              {batchAllowedSubtypes.map((subtype) => (
                <option key={subtype} value={subtype}>
                  {subtype}
                </option>
              ))}
            </select>
            <div className="range-summary">
              {draftRange && selectedDoc
                ? `Selected text [${draftRange.begin}, ${draftRange.end}): ${selectedDoc.text
                    .slice(draftRange.begin, draftRange.end)
                    .slice(0, 64)}`
                : parsedQuery.raw && !queryIsValid
                    ? `Use category, subtype, label, doc, saved, annotated, not_category, not_subtype, not_label, or regex filters. Category/subtype accept comma lists, any, none, and - exclusions. Examples: regex:/\\d+/, category:any,-${categories[0]?.value ?? 'Name'}, subtype:${
                      subtypes[0]?.value ?? 'Patient'
                    }, annotated:false, or label:${labels[0] ?? 'Name:Patient'}.`
                  : parsedQuery.raw
                    ? `${matchedSpans.length} existing span matches across ${visibleDocuments.length} docs; ${activeMatches.length} in this text. ${keywordOccurrenceCount} text occurrences; ${selectedDocKeywordOccurrenceCount} in this text.`
                  : 'Select text in the document to create one span immediately.'}
            </div>
            {draftRange && (
              <button type="button" className="icon-button secondary full" onClick={() => createSpanFromDraftRange()}>
                <Plus size={16} />
                Create from current selection
              </button>
            )}
            {queryIsValid && matchedSpans.length > 0 && (
              <button type="button" className="icon-button primary full" onClick={() => batchRelabel()}>
                <Check size={16} />
                Relabel {matchedSpans.length} existing span matches
              </button>
            )}
            {queryIsValid && parsedQuery.textSearch && keywordOccurrenceCount > 0 && (
              <button type="button" className="icon-button secondary full" onClick={() => batchCreateKeywordSpans()}>
                <Plus size={16} />
                Create spans for {keywordOccurrenceCount} text occurrences
              </button>
            )}
            {queryIsValid && matchedSpans.length > 0 && (
              <button type="button" className="icon-button danger full" onClick={() => batchDeleteMatchingSpans()}>
                <Trash2 size={16} />
                Delete {matchedSpans.length} existing span matches
              </button>
            )}
          </section>

          <section className="panel spans-panel">
            <div className="panel-title">Spans in document</div>
            <div className="span-list">
              {visibleSpanRows.length === 0 && (
                <p className="muted">{parsedQuery.raw ? 'No matching spans in this document.' : 'No spans in this document.'}</p>
              )}
              {visibleSpanRows.map((match) => (
                <button
                  type="button"
                  key={`${match.kind ?? 'annotation'}-${match.annotationIndex}-${match.suggestionIndex}-${match.begin}-${match.end}`}
                  className={`span-row ${
                    (match.annotationIndex >= 0 && selectedSpanIndex === match.annotationIndex) ||
                    (match.suggestionIndex >= 0 && selectedSuggestionIndex === match.suggestionIndex)
                      ? 'active'
                      : ''
                  } ${match.kind === 'suggestion' ? 'suggestion-row' : ''} ${
                    match.changeStatus ? `change-${match.changeStatus}` : ''
                  } ${
                    match.valid === false ? 'invalid' : ''
                  }`}
                  onClick={() => selectMatch(match)}
                >
                  <span className="label-chip" style={{ background: match.label ? labelColor(match.label) : '#fff4d6' }}>
                    {match.label || 'Unlabeled'}
                  </span>
                  <strong>{match.text}</strong>
                  <small>
                    [{match.begin}, {match.end}){' '}
                    {match.changeStatus === 'added'
                      ? match.valid
                        ? 'new'
                        : match.issue === 'subtype'
                          ? 'needs subtype'
                          : 'needs label'
                      : match.changeStatus === 'changed'
                        ? 'changed'
                        : match.changeStatus === 'deleted'
                          ? 'deleted'
                        : match.confirmed
                            ? 'confirmed'
                            : ''}
                    {match.reviewType ? ` ${match.reviewStatus || ''} ${match.reviewType}` : ''}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </main>
      <footer className="status-bar">{status}</footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Workspace Editor={App} kind="annotate" />);
