export function bytesToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToText(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeBasicAuth(username, password) {
  return `Basic ${bytesToBase64(`${username}:${password}`)}`;
}

export function normaliseEpoch(value, unit = "auto") {
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric)) throw new Error("Epoch must be a finite number.");
  if (unit === "milliseconds") return numeric;
  if (unit === "seconds") return numeric * 1000;
  return Math.abs(numeric) >= 1e12 ? numeric : numeric * 1000;
}

export function dateToEpoch(value, unit = "seconds") {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Enter a valid date and time.");
  return unit === "milliseconds" ? timestamp : Math.floor(timestamp / 1000);
}

export function identifyHash(value) {
  const hash = value.trim();
  if (!hash) return [];

  const signatures = [
    ["Argon2", /^\$argon2(?:id|i|d)\$/i],
    ["bcrypt", /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/],
    ["scrypt", /^\$scrypt\$/i],
    ["PBKDF2", /^(?:\$?pbkdf2|pbkdf2_)/i],
    ["Unix MD5-crypt", /^\$1\$[^$]+\$[./A-Za-z0-9]{22}$/],
    ["Unix SHA-256 crypt", /^\$5\$[^$]+(?:\$rounds=\d+)?\$[./A-Za-z0-9]{43}$/],
    ["Unix SHA-512 crypt", /^\$6\$[^$]+(?:\$rounds=\d+)?\$[./A-Za-z0-9]{86}$/],
    ["Apache APR1", /^\$apr1\$[^$]+\$[./A-Za-z0-9]{22}$/],
    ["PHPass / WordPress", /^\$P\$[./A-Za-z0-9]{31}$/],
    ["MySQL 4.1+", /^\*[A-F0-9]{40}$/i],
    ["Cisco type 5", /^\$1\$[./A-Za-z0-9]+\$[./A-Za-z0-9]{22}$/],
    ["Cisco type 8", /^\$8\$/],
    ["Cisco type 9", /^\$9\$/],
    ["Django", /^(?:pbkdf2_sha256|argon2|bcrypt_sha256)\$/i]
  ];

  const matches = signatures
    .filter(([, pattern]) => pattern.test(hash))
    .map(([name]) => name);

  if (/^[a-f0-9]+$/i.test(hash)) {
    const candidates = {
      32: "MD5 / MD4 / NTLM",
      40: "SHA-1 / RIPEMD-160",
      56: "SHA-224",
      64: "SHA-256",
      96: "SHA-384",
      128: "SHA-512"
    };
    if (candidates[hash.length]) matches.push(candidates[hash.length]);
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(hash)) {
    const decodedBytes = Math.floor((hash.replace(/=/g, "").length * 6) / 8);
    const candidate = {
      16: "Possible Base64-encoded MD5",
      20: "Possible Base64-encoded SHA-1",
      28: "Possible Base64-encoded SHA-224",
      32: "Possible Base64-encoded SHA-256",
      48: "Possible Base64-encoded SHA-384",
      64: "Possible Base64-encoded SHA-512"
    }[decodedBytes];
    if (candidate) matches.push(candidate);
  }

  return [...new Set(matches)];
}

export function urlEncodePayload(value) {
  return encodeURIComponent(value);
}

export function urlDecodeValue(value) {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

export function normaliseProxyEndpoint(hostValue, portValue) {
  const input = String(hostValue ?? "").trim();
  if (!input) throw new Error("Proxy host is required.");

  let host = input;
  let port = Number(portValue);
  let scheme = null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const hasInlinePort = /^[^:/\s]+:\d+$/.test(input) ||
    /^\[[0-9a-f:]+\](?::\d+)?$/i.test(input);

  if (hasScheme || hasInlinePort) {
    let endpoint;
    try {
      endpoint = new URL(hasScheme ? input : `http://${input}`);
    } catch {
      throw new Error("Enter a valid proxy hostname, IP address, or URL.");
    }
    if (endpoint.username || endpoint.password) {
      throw new Error("Enter proxy credentials in the Username and Password fields.");
    }
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      throw new Error("A proxy endpoint cannot contain a path, query, or fragment.");
    }
    host = endpoint.hostname;
    if (endpoint.port) port = Number(endpoint.port);
    if (hasScheme) scheme = endpoint.protocol.slice(0, -1).toLowerCase();
  }

  if (!host || /[\s/?#@]/.test(host)) {
    throw new Error("Proxy host must be a hostname or IP address.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy port must be between 1 and 65535.");
  }

  return { host, port, scheme };
}

export function normaliseDomainScope(value) {
  const input = String(value ?? "").trim().replace(/^\*\./, "").replace(/^\./, "");
  if (!input) return "";
  if (input.includes("://")) {
    throw new Error("Enter a domain only, without http:// or https://.");
  }

  let parsed;
  try {
    parsed = new URL(`http://${input}`);
  } catch {
    throw new Error("Enter a valid role scope domain.");
  }
  if (
    !parsed.hostname ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Role scope must be a domain without a port, path, query, or credentials.");
  }
  return parsed.hostname.toLowerCase();
}

export function prettyPrintValue(value) {
  const input = String(value ?? "");
  const jsonCandidates = [{ label: "JSON", codec: "json", value: input }];

  try {
    const decoded = urlDecodeValue(input);
    if (decoded !== input) {
      jsonCandidates.push({ label: "URL-encoded JSON", codec: "url-json", value: decoded });
    }
  } catch {
    // Keep inspecting other structured formats.
  }

  try {
    const decoded = base64ToText(input);
    if (decoded !== input) {
      jsonCandidates.push({
        label: "Base64-encoded JSON",
        codec: /[-_]/.test(input) ? "base64url-json" : "base64-json",
        value: decoded
      });
    }
  } catch {
    // Keep inspecting other structured formats.
  }

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate.value);
      return {
        codec: candidate.codec,
        format: candidate.label,
        formatted: JSON.stringify(parsed, null, 2)
      };
    } catch {
      // Try the next representation.
    }
  }

  const jwtParts = input.split(".");
  if (jwtParts.length === 3) {
    try {
      const header = JSON.parse(base64ToText(jwtParts[0]));
      const payload = JSON.parse(base64ToText(jwtParts[1]));
      return {
        codec: "jwt",
        format: "JWT",
        formatted: JSON.stringify(
          { header, payload, signature: jwtParts[2] },
          null,
          2
        )
      };
    } catch {
      // It looks token-like but is not a decodable JSON Web Token.
    }
  }

  if (input.includes("=")) {
    try {
      const entries = {};
      for (const [key, entryValue] of new URLSearchParams(input)) {
        if (Object.hasOwn(entries, key)) {
          entries[key] = Array.isArray(entries[key])
            ? [...entries[key], entryValue]
            : [entries[key], entryValue];
        } else {
          entries[key] = entryValue;
        }
      }
      if (Object.keys(entries).length) {
        return {
          codec: "form",
          format: "Form/query parameters",
          formatted: JSON.stringify(entries, null, 2)
        };
      }
    } catch {
      // Fall through to plain text.
    }
  }

  return { codec: "text", format: "Plain text", formatted: input };
}

export function serialisePrettyValue(value, codec) {
  if (codec === "text") return value;

  const parsed = JSON.parse(value);
  if (codec === "json") return JSON.stringify(parsed);
  if (codec === "url-json") return encodeURIComponent(JSON.stringify(parsed));
  if (codec === "base64-json") return bytesToBase64(JSON.stringify(parsed));
  if (codec === "base64url-json") return toBase64Url(JSON.stringify(parsed));

  if (codec === "jwt") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pretty JWT mode requires an object with header, payload, and signature.");
    }
    if (!Object.hasOwn(parsed, "header") || !Object.hasOwn(parsed, "payload")) {
      throw new Error("Pretty JWT mode requires header and payload properties.");
    }
    const signature = parsed.signature == null ? "" : String(parsed.signature);
    return `${toBase64Url(JSON.stringify(parsed.header))}.${toBase64Url(JSON.stringify(parsed.payload))}.${signature}`;
  }

  if (codec === "form") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pretty form mode requires a JSON object.");
    }
    const parameters = new URLSearchParams();
    for (const [key, entryValue] of Object.entries(parsed)) {
      if (Array.isArray(entryValue)) {
        for (const item of entryValue) parameters.append(key, String(item));
      } else {
        parameters.append(key, String(entryValue));
      }
    }
    return parameters.toString();
  }

  throw new Error(`Unsupported pretty-print codec: ${codec}`);
}

function toBase64Url(value) {
  return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeJwt(header, payload, signature = "") {
  if (!isPlainObject(header) || !isPlainObject(payload)) {
    throw new Error("JWT header and claims must both be JSON objects.");
  }
  return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.${signature}`;
}

export function decodeJwt(value) {
  const token = String(value ?? "").trim().replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("A JWT must contain header, claims, and signature segments.");
  }
  if (!parts.every((part) => /^[A-Za-z0-9_-]*$/.test(part))) {
    throw new Error("JWT segments must use Base64URL encoding.");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64ToText(parts[0]));
    payload = JSON.parse(base64ToText(parts[1]));
  } catch {
    throw new Error("JWT header or claims are not valid UTF-8 JSON.");
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) {
    throw new Error("JWT header and claims must both be JSON objects.");
  }

  return {
    token,
    header,
    payload,
    signature: parts[2],
    signingInput: `${parts[0]}.${parts[1]}`
  };
}

export function extractJwt(value) {
  const input = String(value ?? "").trim();
  const candidates = [input];
  try {
    const decoded = urlDecodeValue(input);
    if (decoded !== input) candidates.push(decoded);
  } catch {
    // Keep testing the raw value.
  }
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === "string") candidates.push(parsed);
  } catch {
    // The value is not a JSON string.
  }
  for (const candidate of candidates) {
    try {
      return decodeJwt(candidate).token;
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

export function isJwt(value) {
  return extractJwt(value) != null;
}

export function analyseJwt(decoded, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { header, payload, signature } = decoded;
  const exp = numericDate(payload.exp);
  const nbf = numericDate(payload.nbf);
  const iat = numericDate(payload.iat);
  const expired = exp != null && nowSeconds >= exp;
  const notYetValid = nbf != null && nowSeconds < nbf;
  const issuedInFuture = iat != null && iat > nowSeconds + 60;
  const warnings = [];

  if (!header.alg) warnings.push("The token does not declare a signing algorithm.");
  if (String(header.alg).toLowerCase() === "none") {
    warnings.push("The token declares alg=none and must be treated as unsigned.");
  }
  if (!signature) warnings.push("The token has no signature.");
  if (!Object.hasOwn(payload, "exp")) warnings.push("The token has no exp claim.");
  else if (exp == null) warnings.push("The exp claim is not a numeric date.");
  if (Object.hasOwn(payload, "nbf") && nbf == null) {
    warnings.push("The nbf claim is not a numeric date.");
  }
  if (Object.hasOwn(payload, "iat") && iat == null) {
    warnings.push("The iat claim is not a numeric date.");
  }
  if (expired) warnings.push("The token is expired.");
  if (notYetValid) warnings.push("The token is not valid yet.");
  if (issuedInFuture) warnings.push("The iat claim is in the future.");

  return {
    algorithm: header.alg == null ? "Missing" : String(header.alg),
    type: header.typ == null ? "—" : String(header.typ),
    subject: payload.sub == null ? "—" : String(payload.sub),
    issuer: payload.iss == null ? "—" : String(payload.iss),
    audience: Array.isArray(payload.aud)
      ? payload.aud.map(String).join(", ")
      : payload.aud == null ? "—" : String(payload.aud),
    jwtId: payload.jti == null ? "—" : String(payload.jti),
    expiration: exp,
    notBefore: nbf,
    issuedAt: iat,
    expired,
    notYetValid,
    issuedInFuture,
    timeStatus: expired ? "expired" : notYetValid ? "not-yet-valid" : exp == null ? "no-expiry" : "valid",
    warnings
  };
}

export async function signJwtHmac(header, payload, secret) {
  const algorithm = hmacAlgorithm(header?.alg);
  if (!String(secret ?? "").length) throw new Error("Enter an HMAC secret.");
  const unsigned = encodeJwt(header, payload);
  const signingInput = unsigned.slice(0, -1);
  const key = await importHmacKey(secret, algorithm, ["sign"]);
  const signature = await crypto.subtle.sign(
    { name: "HMAC" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyJwtHmac(value, secret) {
  const decoded = decodeJwt(value);
  const algorithm = hmacAlgorithm(decoded.header.alg);
  if (!String(secret ?? "").length) throw new Error("Enter an HMAC secret.");
  if (!decoded.signature) return false;
  const key = await importHmacKey(secret, algorithm, ["verify"]);
  return crypto.subtle.verify(
    { name: "HMAC" },
    key,
    base64UrlToBytes(decoded.signature),
    new TextEncoder().encode(decoded.signingInput)
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numericDate(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hmacAlgorithm(value) {
  const algorithms = {
    HS256: "SHA-256",
    HS384: "SHA-384",
    HS512: "SHA-512"
  };
  const name = algorithms[String(value ?? "")];
  if (!name) throw new Error("HMAC operations require alg HS256, HS384, or HS512.");
  return name;
}

async function importHmacKey(secret, hash, usages) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable.");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash },
    false,
    usages
  );
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("JWT signature is not valid Base64URL.");
  }
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function originRegex(origin) {
  const parsed = new URL(origin);
  return `^${escapeRegex(parsed.protocol)}//${escapeRegex(parsed.host)}(?:/|$)`;
}
