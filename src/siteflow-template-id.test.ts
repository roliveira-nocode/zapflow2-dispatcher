import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isValidProviderTemplateId,
  validateProviderTemplateId,
  validateTemplateIdentity,
} from "./siteflow-template-id.js";

// =====================================================================
// validateProviderTemplateId / isValidProviderTemplateId
// =====================================================================

// ---------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------

test("validateProviderTemplateId: accepts a real-shaped Umbler/Meta ID", () => {
  for (const id of ["aYSx9KNRwPC0hnHe", "an4ZQL9PiM6AvyyT", "under_score-ID_123", "abcd"]) {
    assert.equal(validateProviderTemplateId(id), null, id);
    assert.equal(isValidProviderTemplateId(id), true, id);
  }
});

test("validateProviderTemplateId: accepts exactly 4 characters (the minimum)", () => {
  const id = "abcd";
  assert.equal(validateProviderTemplateId(id), null);
  assert.equal(isValidProviderTemplateId(id), true);
});

test("validateProviderTemplateId: accepts exactly 64 characters (the maximum)", () => {
  const id = "a".repeat(64);
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
    "slash/es!!",
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

test("validateProviderTemplateId: rejects a value shorter than 4 characters — 'a' is not a real-shaped provider ID", () => {
  for (const id of ["a", "ab", "abc"]) {
    assert.match(String(validateProviderTemplateId(id)), /at least 4 characters/, id);
    assert.equal(isValidProviderTemplateId(id), false, id);
  }
});

test("validateProviderTemplateId: rejects a value longer than 64 characters", () => {
  const id = "a".repeat(65);
  assert.match(String(validateProviderTemplateId(id)), /at most 64 characters/);
  assert.equal(isValidProviderTemplateId(id), false);
});

test("validateProviderTemplateId: rejects leading/trailing whitespace around an otherwise valid ID", () => {
  for (const id of [" aYSx9KNRwPC0hnHe", "aYSx9KNRwPC0hnHe ", "\taYSx9KNRwPC0hnHe\n"]) {
    assert.match(String(validateProviderTemplateId(id)), /invalid format/, JSON.stringify(id));
    assert.equal(isValidProviderTemplateId(id), false, JSON.stringify(id));
  }
});

// =====================================================================
// validateTemplateIdentity — the dynamic path's logical/internal identity
// =====================================================================

test("validateTemplateIdentity: accepts a safe slug/token, of any shape, not tied to the closed registry", () => {
  for (const id of [
    "camp_catalogo_dinamico_v3",
    "qualquer_identidade_siteflow_v9",
    "a",
    "A-B_C-123",
    "no_camp_prefix_required",
  ]) {
    assert.equal(validateTemplateIdentity(id), null, id);
  }
});

test("validateTemplateIdentity: accepts exactly 128 characters", () => {
  const id = "a".repeat(128);
  assert.equal(validateTemplateIdentity(id), null);
});

test("validateTemplateIdentity: rejects empty and whitespace-only strings", () => {
  for (const id of ["", "   ", "\t\n"]) {
    assert.match(String(validateTemplateIdentity(id)), /template is required/, JSON.stringify(id));
  }
});

test("validateTemplateIdentity: rejects non-string values", () => {
  for (const id of [undefined, null, 123, true, {}, []]) {
    assert.match(String(validateTemplateIdentity(id)), /template is required/, JSON.stringify(id));
  }
});

test("validateTemplateIdentity: rejects newlines, control characters and spaces — it is interpolated into a server log line", () => {
  for (const id of [
    "has a space",
    "newline\nid",
    "carriage\rreturn",
    "tab\tid",
    "null\0byte",
    "\x1b[31mANSI\x1b[0m",
    "<script>alert(1)</script>",
    "template;`rm -rf /`",
  ]) {
    assert.match(String(validateTemplateIdentity(id)), /invalid format/, JSON.stringify(id));
  }
});

test("validateTemplateIdentity: rejects a value longer than 128 characters", () => {
  const id = "a".repeat(129);
  assert.match(String(validateTemplateIdentity(id)), /at most 128 characters/);
});

test("validateTemplateIdentity: does not require any particular prefix or registry membership", () => {
  // Not a key of SITEFLOW_TEMPLATES, no camp_ prefix — still a valid slug.
  assert.equal(validateTemplateIdentity("totally-unregistered-identity"), null);
});
