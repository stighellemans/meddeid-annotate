import fs from 'node:fs';

const contract = JSON.parse(
  fs.readFileSync(new URL('../contracts/taxonomy.json', import.meta.url), 'utf8'),
);

export const CATEGORY_VALUES = Object.freeze(contract.categories);
export const SUBTYPE_VALUES = Object.freeze(contract.subtypes);
export const SUBTYPES_BY_CATEGORY = Object.freeze(contract.subtypes_by_category);
export const LABELS = Object.freeze(contract.entity_labels);

export function splitLabel(label) {
  const normalized = String(label ?? '').trim();
  if (!normalized) return { category: '', subtype: null };
  const [category, ...subtypeParts] = normalized.split(':');
  return { category, subtype: subtypeParts.length > 0 ? subtypeParts.join(':') : null };
}

export function composeLabel(annotation) {
  const category = String(annotation?.category ?? '').trim();
  const rawSubtype = annotation?.subtype;
  const subtype = rawSubtype === null || rawSubtype === undefined ? '' : String(rawSubtype).trim();
  if (category && subtype) return `${category}:${subtype}`;
  if (category) return category;
  return String(annotation?.label ?? '').trim();
}
