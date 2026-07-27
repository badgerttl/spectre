import test from "node:test";
import assert from "node:assert/strict";
import { PAYLOADS } from "../src/payloads.mjs";

test("payload catalogue is broad and well-formed", () => {
  const categories = PAYLOADS.map(({ category }) => category);
  const payloadCount = PAYLOADS.reduce((total, group) => total + group.payloads.length, 0);

  assert.equal(new Set(categories).size, categories.length, "category names must be unique");
  assert.ok(categories.length >= 20, "expected at least 20 payload categories");
  assert.ok(payloadCount >= 200, "expected at least 200 payloads");

  for (const group of PAYLOADS) {
    assert.ok(group.category.trim(), "category name cannot be empty");
    assert.ok(group.payloads.length >= 3, `${group.category} needs at least three payloads`);
    for (const payload of group.payloads) {
      assert.equal(typeof payload.value, "string");
      assert.ok(payload.value.length > 0, `${group.category} contains an empty payload`);
      assert.ok(payload.note.trim(), `${group.category} contains an entry without a note`);
    }
  }
});
