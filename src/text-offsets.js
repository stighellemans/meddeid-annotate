export function describeTextChange(oldText, newText) {
  const oldValue = String(oldText ?? '');
  const newValue = String(newText ?? '');
  let prefixLength = 0;
  const shortestLength = Math.min(oldValue.length, newValue.length);

  while (prefixLength < shortestLength && oldValue[prefixLength] === newValue[prefixLength]) {
    prefixLength += 1;
  }

  let oldSuffixStart = oldValue.length;
  let newSuffixStart = newValue.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldValue[oldSuffixStart - 1] === newValue[newSuffixStart - 1]
  ) {
    oldSuffixStart -= 1;
    newSuffixStart -= 1;
  }

  return {
    oldBegin: prefixLength,
    oldEnd: oldSuffixStart,
    newBegin: prefixLength,
    newEnd: newSuffixStart,
    delta: newValue.length - oldValue.length,
  };
}

function validRange(begin, end) {
  return Number.isInteger(begin) && Number.isInteger(end) && begin >= 0 && end > begin;
}

function deletedAnnotation(annotation) {
  if (annotation._changeStatus === 'added') return [];
  return [
    {
      ...annotation,
      confirmed: false,
      _changeStatus: 'deleted',
    },
  ];
}

function refreshAnnotation(annotation, begin, end, newText, touched = false) {
  const safeBegin = Math.max(0, Math.min(begin, newText.length));
  const safeEnd = Math.max(safeBegin, Math.min(end, newText.length));
  if (safeBegin >= safeEnd) return deletedAnnotation(annotation);

  return [
    {
      ...annotation,
      begin: safeBegin,
      end: safeEnd,
      text: newText.slice(safeBegin, safeEnd),
      ...(touched
        ? {
            confirmed: false,
            _changeStatus: annotation._changeStatus === 'added' ? 'added' : 'changed',
          }
        : {}),
    },
  ];
}

export function adjustAnnotationsForTextChange({ annotations, oldText, newText }) {
  const oldValue = String(oldText ?? '');
  const newValue = String(newText ?? '');
  if (oldValue === newValue) {
    return (annotations ?? []).map((annotation) => ({ ...annotation }));
  }

  const change = describeTextChange(oldValue, newValue);
  const { oldBegin, oldEnd, newEnd, delta } = change;
  const isInsertion = oldBegin === oldEnd;

  return (annotations ?? []).flatMap((annotation) => {
    const begin = Number(annotation?.begin);
    const end = Number(annotation?.end);
    if (!validRange(begin, end)) return [];

    if (end <= oldBegin) {
      return refreshAnnotation(annotation, begin, end, newValue);
    }

    if (begin >= oldEnd) {
      return refreshAnnotation(annotation, begin + delta, end + delta, newValue);
    }

    if (isInsertion && begin < oldBegin && end > oldBegin) {
      return refreshAnnotation(annotation, begin, end + delta, newValue, true);
    }

    if (!isInsertion && begin <= oldBegin && end >= oldEnd) {
      return refreshAnnotation(annotation, begin, end + delta, newValue, true);
    }

    if (begin < oldBegin && end > oldBegin && end <= oldEnd) {
      return refreshAnnotation(annotation, begin, oldBegin, newValue, true);
    }

    if (begin >= oldBegin && begin < oldEnd && end > oldEnd) {
      return refreshAnnotation(annotation, newEnd, end + delta, newValue, true);
    }

    return deletedAnnotation(annotation);
  });
}
