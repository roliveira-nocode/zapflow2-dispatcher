/**
 * Provider-attempt boundary tests for the two send functions.
 *
 * Every test replaces globalThis.fetch; the beforeEach guard below throws on
 * any unstubbed call, so a real network request can never escape this file.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { type FailureStage } from "./dispatch-outcome.js";
import { sendTemplateMessage, sendTextMessage, type SendTemplateResult } from "./umbler.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error("unstubbed network call — the test forgot to install a fetch stub");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Both senders share the same boundary code, so every case runs against both. */
const SENDERS = [
  {
    name: "sendTemplateMessage",
    send: () =>
      sendTemplateMessage(
        { toPhone: "+5511988887777", templateId: "provider-id-test", params: ["Maria"], contactName: "Maria" },
        "umbler-token",
      ),
  },
  {
    name: "sendTextMessage",
    send: () => sendTextMessage({ toPhone: "+5511988887777", message: "Resumo" }, "umbler-token"),
  },
] as const;

function respondWith(body: string, status: number): void {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

function throwWith(error: unknown): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

interface Scenario {
  name: string;
  stub: () => void;
  accepted: boolean;
  status: number | null;
  provider_attempted: boolean;
  failure_stage: FailureStage;
  error?: string | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: "200 + valid JSON",
    stub: () => respondWith(JSON.stringify({ id: "wamid.abc", chatId: "chat-1", messageState: "Processing" }), 200),
    accepted: true,
    status: 200,
    provider_attempted: true,
    failure_stage: "none",
    error: null,
  },
  {
    name: "200 + unparseable HTML body",
    stub: () => respondWith("<html><body>ok</body></html>", 200),
    accepted: true,
    status: 200,
    provider_attempted: true,
    failure_stage: "none",
    error: null,
  },
  {
    name: "400 + structured provider rejection",
    stub: () => respondWith(JSON.stringify({ message: "invalid template" }), 400),
    accepted: false,
    status: 400,
    provider_attempted: true,
    failure_stage: "provider_rejected",
    error: "invalid template",
  },
  {
    name: "422 + structured provider rejection (title)",
    stub: () => respondWith(JSON.stringify({ title: "Unprocessable params" }), 422),
    accepted: false,
    status: 422,
    provider_attempted: true,
    failure_stage: "provider_rejected",
    error: "Unprocessable params",
  },
  {
    name: "500 + JSON body",
    stub: () => respondWith(JSON.stringify({ error: "boom" }), 500),
    accepted: false,
    status: 500,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
    error: "boom",
  },
  {
    name: "502 + HTML body",
    stub: () => respondWith("<html>502 Bad Gateway</html>", 502),
    accepted: false,
    status: 502,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
    error: "Umbler returned HTTP 502.",
  },
  {
    name: "connection reset (TypeError)",
    stub: () => throwWith(new TypeError("fetch failed")),
    accepted: false,
    status: null,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  },
  {
    name: "timeout (AbortError)",
    stub: () => throwWith(named("AbortError", "This operation was aborted")),
    accepted: false,
    status: null,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  },
  {
    name: "timeout (TimeoutError)",
    stub: () => throwWith(named("TimeoutError", "The operation timed out")),
    accepted: false,
    status: null,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  },
  {
    name: "non-Error throw",
    stub: () => throwWith("boom"),
    accepted: false,
    status: null,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
    error: "boom",
  },
  {
    name: "throw after the request completed (response.text() rejects)",
    stub: () => {
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error("socket hang up");
          },
        }) as unknown as Response) as typeof fetch;
    },
    accepted: false,
    status: null,
    provider_attempted: true,
    failure_stage: "provider_indeterminate",
  },
];

for (const sender of SENDERS) {
  for (const scenario of SCENARIOS) {
    test(`${sender.name}: ${scenario.name}`, async () => {
      scenario.stub();
      const result = await sender.send();

      assert.equal(result.accepted, scenario.accepted, "accepted");
      assert.equal(result.status, scenario.status, "status");
      assert.equal(result.provider_attempted, scenario.provider_attempted, "provider_attempted");
      assert.equal(result.failure_stage, scenario.failure_stage, "failure_stage");
      if (scenario.error !== undefined) {
        assert.equal(result.error, scenario.error, "error");
      }
      assert.notEqual(result.error, "unstubbed network call", "no real network call");
    });
  }
}

test("200 + valid JSON keeps the existing provider fields untouched", async () => {
  respondWith(JSON.stringify({ id: "wamid.abc", chatId: "chat-1", messageState: "Processing" }), 200);
  const result = await sendTemplateMessage(
    { toPhone: "+5511988887777", templateId: "provider-id-test", params: ["Maria"], contactName: "Maria" },
    "umbler-token",
  );
  assert.equal(result.message_state, "Processing");
  assert.equal(result.provider_message_id, "wamid.abc");
  assert.equal(result.chat_id, "chat-1");
});

// ---------------------------------------------------------------------
// The invariant: no post-boundary outcome may report a proven non-send.
// ---------------------------------------------------------------------

test("INVARIANT: every outcome at or after the provider boundary is provider_attempted:true", async () => {
  const seen: SendTemplateResult[] = [];
  for (const sender of SENDERS) {
    for (const scenario of SCENARIOS) {
      scenario.stub();
      seen.push(await sender.send());
    }
  }
  assert.equal(seen.length, SENDERS.length * SCENARIOS.length);
  for (const result of seen) {
    assert.notEqual(result.provider_attempted, false);
    assert.equal(result.provider_attempted, true);
    assert.notEqual(result.failure_stage, "pre_provider_error");
    assert.notEqual(result.failure_stage, "request_validation");
    assert.notEqual(result.failure_stage, "configuration");
  }
});

test("the send functions never retry: exactly one fetch per call", async () => {
  for (const scenario of SCENARIOS) {
    for (const sender of SENDERS) {
      scenario.stub();
      const inner = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        calls++;
        return inner(...args);
      }) as typeof fetch;

      await sender.send();
      assert.equal(calls, 1, `${sender.name} / ${scenario.name}`);
    }
  }
});
