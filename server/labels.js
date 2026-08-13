import fs from 'node:fs';

const contract = JSON.parse(
  fs.readFileSync(new URL('../contracts/taxonomy.json', import.meta.url), 'utf8'),
);

// Keyboard choices are UI metadata. Taxonomy membership and subtype validity
// come exclusively from the generated meddeid-core contract.
const CATEGORY_KEYS = Object.freeze({
  Address_Location: 'a',
  Age_Birthdate: 'l',
  Anonymize_Other: 'x',
  Contactdetails: 'c',
  Date: 'd',
  ID: 'i',
  Name: 'n',
  Organization: 'o',
  Profession: 'b',
});
const SUBTYPE_KEYS = Object.freeze({ Caregiver: 'z', Healthcare: 'h', Patient: 'p', Other: 'f' });

export const CATEGORIES = Object.freeze(
  contract.categories.map((value) => Object.freeze({ value, key: CATEGORY_KEYS[value] })),
);
export const SUBTYPES = Object.freeze(
  contract.subtypes.map((value) => Object.freeze({ value, key: SUBTYPE_KEYS[value] })),
);
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
