import assert from "node:assert/strict";
import { test } from "node:test";

import * as outcome from "./dispatch-outcome.js";
import {
  ATTEMPTED_INDETERMINATE,
  ATTEMPTED_OK,
  classifyProviderResponse,
  classifyProviderThrow,
  NOT_ATTEMPTED_CONFIGURATION,
  NOT_ATTEMPTED_OK,
  NOT_ATTEMPTED_PRE_PROVIDER_ERROR,
  NOT_ATTEMPTED_VALIDATION,
  type DispatchFailureMeta,
} from "./dispatch-outcome.js";

// ---------------------------------------------------------------------
// classifyProviderResponse — a response came back, so a request was sent
// ---------------------------------------------------------------------

test("classifyProviderResponse: ok -> attempted, no failure", () => {
  assert.deepEqual(classifyProviderResponse(true, 200), {
    provider_attempted: true,
    failure_stage: "none",
  });
  assert.deepEqual(classifyProviderResponse(true, 201), ATTEMPTED_OK);
});

test("classifyProviderResponse: 4xx -> attempted + provider_rejected", () => {
  for (const status of [400, 401, 403, 404, 422, 429, 499]) {
    assert.deepEqual(
      classifyProviderResponse(false, status),
      { provider_attempted: true, failure_stage: "provider_rejected" },
      `status ${status}`,
    );
  }
});

test("classifyProviderResponse: 5xx -> attempted + provider_indeterminate", () => {
  for (const status of [500, 502, 503, 504, 599]) {
    assert.deepEqual(
      classifyProviderResponse(false, status),
      { provider_attempted: true, failure_stage: "provider_indeterminate" },
      `status ${status}`,
    );
  }
});

test("classifyProviderResponse: any other non-ok status is indeterminate, never rejected", () => {
  for (const status of [100, 199, 302, 304, 399]) {
    assert.deepEqual(
      classifyProviderResponse(false, status),
      ATTEMPTED_INDETERMINATE,
      `status ${status}`,
    );
  }
});

test("classifyProviderThrow: always attempted + provider_indeterminate", () => {
  assert.deepEqual(classifyProviderThrow(), {
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  });
});

// ---------------------------------------------------------------------
// The invariant that the whole slice rests on
// ---------------------------------------------------------------------

test("INVARIANT: no classifier can ever produce provider_attempted:false", () => {
  for (let status = 100; status <= 599; status++) {
    for (const ok of [true, false]) {
      const meta = classifyProviderResponse(ok, status);
      assert.equal(
        meta.provider_attempted,
        true,
        `classifyProviderResponse(${ok}, ${status}) must be attempted`,
      );
      assert.notEqual(meta.failure_stage, "pre_provider_error");
    }
  }
  assert.equal(classifyProviderThrow().provider_attempted, true);
});

test("INVARIANT: only the NOT_ATTEMPTED_* constants carry provider_attempted:false", () => {
  const notAttempted = Object.entries(outcome)
    .filter((entry): entry is [string, DispatchFailureMeta] => {
      const value: unknown = entry[1];
      return typeof value === "object" && value !== null && "provider_attempted" in value;
    })
    .filter(([, meta]) => meta.provider_attempted === false)
    .map(([name]) => name)
    .sort();

  assert.deepEqual(notAttempted, [
    "NOT_ATTEMPTED_CONFIGURATION",
    "NOT_ATTEMPTED_OK",
    "NOT_ATTEMPTED_PRE_PROVIDER_ERROR",
    "NOT_ATTEMPTED_VALIDATION",
  ]);
});

test("the exported constants carry exactly their documented stage", () => {
  assert.deepEqual(NOT_ATTEMPTED_OK, { provider_attempted: false, failure_stage: "none" });
  assert.deepEqual(NOT_ATTEMPTED_VALIDATION, {
    provider_attempted: false,
    failure_stage: "request_validation",
  });
  assert.deepEqual(NOT_ATTEMPTED_CONFIGURATION, {
    provider_attempted: false,
    failure_stage: "configuration",
  });
  assert.deepEqual(NOT_ATTEMPTED_PRE_PROVIDER_ERROR, {
    provider_attempted: false,
    failure_stage: "pre_provider_error",
  });
  assert.deepEqual(ATTEMPTED_OK, { provider_attempted: true, failure_stage: "none" });
  assert.deepEqual(ATTEMPTED_INDETERMINATE, {
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  });
});
