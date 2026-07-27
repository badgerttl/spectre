import test from "node:test";
import assert from "node:assert/strict";

if (!globalThis.btoa) {
  globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

const {
  analyseJwt,
  base64ToText,
  bytesToBase64,
  dateToEpoch,
  decodeJwt,
  encodeBasicAuth,
  encodeJwt,
  extractJwt,
  identifyHash,
  isJwt,
  normaliseEpoch,
  originRegex,
  prettyPrintValue,
  serialisePrettyValue,
  signJwtHmac,
  urlDecodeValue,
  urlEncodePayload,
  verifyJwtHmac
} = await import("../src/utils.mjs");

test("Base64 helpers preserve Unicode", () => {
  const value = "Spectre 👻";
  assert.equal(base64ToText(bytesToBase64(value)), value);
});

test("Basic authentication is encoded correctly", () => {
  assert.equal(encodeBasicAuth("alice", "s3cret"), "Basic YWxpY2U6czNjcmV0");
});

test("Epoch conversion supports seconds and milliseconds", () => {
  assert.equal(normaliseEpoch("1704067200"), 1704067200000);
  assert.equal(normaliseEpoch("1704067200000"), 1704067200000);
  assert.equal(dateToEpoch("2024-01-01T00:00:00.000Z"), 1704067200);
});

test("Hash identification returns useful candidates", () => {
  assert.deepEqual(
    identifyHash("d41d8cd98f00b204e9800998ecf8427e"),
    ["MD5 / MD4 / NTLM"]
  );
  assert.deepEqual(
    identifyHash("$2b$12$C6UzMDM.H6dfI/f/IKcEe.2PpN4X4D.4Kj6K8V.0JO4G7tMZPz5G2"),
    ["bcrypt"]
  );
});

test("URL helpers scope rules to an exact origin", () => {
  const pattern = new RegExp(originRegex("https://example.test:8443"));
  assert.equal(pattern.test("https://example.test:8443/path"), true);
  assert.equal(pattern.test("https://example.test/path"), false);
  assert.equal(urlEncodePayload("<script>alert(1)</script>"), "%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal(urlDecodeValue("hello+world%21"), "hello world!");
});

test("structured values are pretty printed without changing their source", () => {
  const source = "%7B%22role%22%3A%22admin%22%2C%22enabled%22%3Atrue%7D";
  const preview = prettyPrintValue(source);
  assert.equal(preview.format, "URL-encoded JSON");
  assert.equal(preview.codec, "url-json");
  assert.equal(preview.formatted, '{\n  "role": "admin",\n  "enabled": true\n}');
  assert.equal(source, "%7B%22role%22%3A%22admin%22%2C%22enabled%22%3Atrue%7D");
});

test("pretty edits round-trip through their original representation", () => {
  const cases = [
    '{"role":"user","enabled":true}',
    "%7B%22role%22%3A%22user%22%7D",
    bytesToBase64('{"role":"user"}'),
    "role=user&scope=read&scope=write",
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxIn0."
  ];

  for (const source of cases) {
    const preview = prettyPrintValue(source);
    const edited = preview.formatted.replace('"user"', '"admin"');
    const serialised = serialisePrettyValue(edited, preview.codec);
    const reparsed = prettyPrintValue(serialised);
    assert.equal(reparsed.formatted, edited);
  }
});

test("JWT helpers decode, rebuild, and analyse claims", () => {
  const token = encodeJwt(
    { alg: "none", typ: "JWT" },
    { sub: "alice", iss: "spectre", exp: 1704067200 }
  );
  const decoded = decodeJwt(`Bearer ${token}`);
  const analysis = analyseJwt(decoded, 1704067100);

  assert.deepEqual(decoded.header, { alg: "none", typ: "JWT" });
  assert.equal(decoded.payload.sub, "alice");
  assert.equal(decoded.signature, "");
  assert.equal(analysis.timeStatus, "valid");
  assert.equal(analysis.warnings.includes("The token declares alg=none and must be treated as unsigned."), true);
  assert.equal(isJwt(token), true);
  assert.equal(isJwt(JSON.stringify(token)), true);
  assert.equal(isJwt(token.replaceAll(".", "%2E")), true);
  assert.equal(isJwt("ordinary-session-value"), false);
  assert.equal(extractJwt(`Bearer ${token}`), token);
  assert.equal(extractJwt(JSON.stringify(token)), token);
});

test("JWT HMAC signing and verification support HS256, HS384, and HS512", async () => {
  const payload = { sub: "alice", exp: 4102444800 };
  for (const algorithm of ["HS256", "HS384", "HS512"]) {
    const token = await signJwtHmac(
      { alg: algorithm, typ: "JWT" },
      payload,
      "correct horse battery staple"
    );
    assert.equal(await verifyJwtHmac(token, "correct horse battery staple"), true);
    assert.equal(await verifyJwtHmac(token, "wrong secret"), false);
    assert.equal(decodeJwt(token).payload.sub, "alice");
  }
});

test("JWT helpers reject malformed tokens and unsupported HMAC algorithms", async () => {
  assert.throws(() => decodeJwt("not-a-jwt"), /three|contain header/i);
  await assert.rejects(
    () => signJwtHmac({ alg: "RS256" }, { sub: "alice" }, "secret"),
    /HS256, HS384, or HS512/
  );
});
