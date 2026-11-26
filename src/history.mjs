// Keep only changed records so undo preserves unrelated application updates.
export function changedRecords(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

export function cookieKey(cookie) {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.storeId, cookie.partitionKey]);
}

export function favoriteKey(category, value) {
  return JSON.stringify([category, value]);
}
