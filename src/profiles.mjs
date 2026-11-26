const FIELDS = {
  roles: ['id', 'name', 'type', 'scope', 'scopeDomain', 'token', 'username', 'password', 'cookieName', 'cookieValue', 'cookiePath', 'headerName', 'headerValue'],
  proxyProfiles: ['id', 'name', 'scheme', 'host', 'port', 'username', 'password', 'bypassList'],
  userAgentProfiles: ['id', 'name', 'value'],
  headers: ['id', 'name', 'value'],
  customPayloads: ['id', 'category', 'value', 'note']
};
const SECRETS = { roles: ['token', 'username', 'password', 'cookieValue', 'headerValue'], proxyProfiles: ['username', 'password'], headers: ['value'] };

export function readProfiles(input) {
  if (input?.format !== 'spectre-profiles' || input.version !== 1) throw new Error('Unsupported Spectre profile file.');
  const result = {};
  for (const [kind, fields] of Object.entries(FIELDS)) {
    const records = input[kind] ?? [];
    if (!Array.isArray(records) || records.length > 2000) throw new Error(`Invalid ${kind} list.`);
    result[kind] = records.map((record) => {
      if (!record || typeof record !== 'object') throw new Error(`Invalid ${kind} record.`);
      const clean = {};
      for (const field of fields) {
        if (record[field] === undefined) continue;
        if (field === 'port') {
          if (!Number.isInteger(record[field])) throw new Error('Proxy port must be a number.');
        } else if (field === 'bypassList') {
          if (!Array.isArray(record[field]) || record[field].some((item) => typeof item !== 'string')) throw new Error('Invalid proxy bypass list.');
        } else if (typeof record[field] !== 'string' || record[field].length > 100000) throw new Error(`Invalid ${field}.`);
        clean[field] = record[field];
      }
      if (kind === 'customPayloads' && (!clean.id || !clean.category?.trim() || !clean.value?.trim())) throw new Error('Custom payload requires a category and value.');
      return clean;
    });
  }
  if (!Array.isArray(input.payloadFavorites ?? []) || (input.payloadFavorites ?? []).some((id) => typeof id !== 'string')) throw new Error('Invalid favorites.');
  result.payloadFavorites = [...new Set(input.payloadFavorites ?? [])];
  return result;
}

export function exportProfiles(state, includeSecrets = false) {
  const data = readProfiles({ ...state, format: 'spectre-profiles', version: 1 });
  if (!includeSecrets) {
    for (const [kind, fields] of Object.entries(SECRETS)) {
      for (const record of data[kind]) for (const field of fields) if (field in record) record[field] = '';
    }
  }
  return { format: 'spectre-profiles', version: 1, includesSecrets: includeSecrets, ...data };
}

// Preserve existing records and activation. Imported entries always start disabled.
export function mergeProfiles(current, incoming, key = 'name') {
  const merged = structuredClone(current);
  for (const record of incoming) {
    if (merged.some((item) => String(item[key]).toLowerCase() === String(record[key]).toLowerCase())) continue;
    merged.push({ ...record, id: crypto.randomUUID(), enabled: false });
  }
  return merged;
}
