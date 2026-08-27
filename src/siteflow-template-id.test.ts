import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidProviderTemplateId, validateProviderTemplateId } from "./siteflow-template-id.js";

// ---------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------

test("validateProviderTemplateId: accepts a real-shaped Umbler/Meta ID", () => {
  for (const id of ["aYSx9KNRwPC0hnHe", "an4ZQL9PiM6AvyyT", "a", "under_score-ID_123"]) {
    assert.equal(validateProviderTemplateId(id), null, id);
    assert.equal(isValidProviderTemplateId(id), true, id);
  }
});

test("validateProviderTemplateId: accepts exactly 128 characters", () => {
  const id = "a".repeat(128);
  assert.equal(validateProviderTemplateId(id), null);
  assert.equal(isValidProviderTemplateId(id), true);
});

// ---------------------------------------------------------------------
// Rejected shapes
// ---------------------------------------------------------------------

test("validateProviderTemplateId: rejects empty and whitespace-only strings", () => {
  for (const id of ["", "   ", "\t\n"]) {
    assert.match(String(validateProviderTemplateId(id)), /provider_template_id is required/, JSON.stringify(id));
    assert.equal(isValidProviderTemplateId(id), false, JSON.stringify(id));
  }
});

test("validateProviderTemplateId: rejects non-string values", () => {
  for (const id of [undefined, null, 123, true, {}, [], ["aYSx9KNRwPC0hnHe"]]) {
    assert.match(String(validateProviderTemplateId(id)), /provider_template_id is required/, JSON.stringify(id));
    assert.equal(isValidProviderTemplateId(id), false, JSON.stringify(id));
  }
});

test("validateProviderTemplateId: rejects unexpected characters", () => {
  for (const id of [
    "has a space",
    "semi;colon",
    "slash/es",
    "quote'here",
    "bracket[1]",
    "emoji-😀-id",
    "newline\nid",
    "<script>alert(1)</script>",
  ]) {
    assert.match(String(validateProviderTemplateId(id)), /invalid format/, id);
    assert.equal(isValidProviderTemplateId(id), false, id);
  }
});

test("validateProviderTemplateId: rejects a value longer than 128 characters", () => {
  const id = "a".repeat(129);
  assert.match(String(validateProviderTemplateId(id)), /at most 128 characters/);
  assert.equal(isValidProviderTemplateId(id), false);
});

test("validateProviderTemplateId: rejects leading/trailing whitespace around an otherwise valid ID", () => {
  for (const id of [" aYSx9KNRwPC0hnHe", "aYSx9KNRwPC0hnHe ", "\taYSx9KNRwPC0hnHe\n"]) {
    assert.match(String(validateProviderTemplateId(id)), /invalid format/, JSON.stringify(id));
    assert.equal(isValidProviderTemplateId(id), false, JSON.stringify(id));
  }
});
