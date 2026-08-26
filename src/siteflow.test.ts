import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";

import {
  createSiteflowDispatchHandler,
  createSiteflowMessageHandler,
  DEFAULT_SITEFLOW_TEMPLATE_KEY,
  SITEFLOW_TEMPLATES,
  validateSiteflowRequest,
} from "./siteflow.js";

const originalFetch = globalThis.fetch;
const SECRET = "test-siteflow-secret";
const ENV_KEYS = [
  "SITEFLOW_DISPATCH_SECRET",
  "DRY_RUN",
  "SITEFLOW_TEMPLATE_ID",
  "SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID",
  "SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.SITEFLOW_DISPATCH_SECRET = SECRET;
  delete process.env.DRY_RUN;
  delete process.env.SITEFLOW_TEMPLATE_ID;
  delete process.env.SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID;
  delete process.env.SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

/** Minimal fake Express Request satisfying only what the handler reads. */
function fakeReq(body: unknown, headers: Record<string, string> = {}): Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    body,
    header: (name: string) => lower.get(name.toLowerCase()),
  } as unknown as Request;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
}

/** Minimal fake Express Response that records status/json calls. */
function fakeRes(): Response & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  } as unknown as Response & FakeRes;
  return res;
}

function mockFetchOk(body: Record<string, unknown>): { calls: unknown[] } {
  const calls: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: unknown) => {
    calls.push(init);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

const HEADERS = { "x-siteflow-dispatch-secret": SECRET };

const NOW = "2026-08-24T12:00:00.000Z";

function legacyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "1pra5",
    client_brand: "1pra5",
    conversation_id: "conv-1",
    lead_id: "lead-1",
    visitor_first_name: "Maria",
    phone: "+5511988887777",
    consent: { granted: true, granted_at: NOW, source: "siteflow-web" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// validateSiteflowRequest — resolution + shape
// ---------------------------------------------------------------------

test("validateSiteflowRequest: legacy path (no `template`) resolves the default template and computes params from the fixed fields", () => {
  const result = validateSiteflowRequest(legacyBody());
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("unexpected error: " + result);
  assert.equal(result.templateKey, DEFAULT_SITEFLOW_TEMPLATE_KEY);
  assert.equal(result.spec.logicalName, "siteflow_continuar_conversa");
  assert.deepEqual(result.params, ["Maria", "1pra5"]);
});

test("validateSiteflowRequest: legacy path requires client_brand", () => {
  const body = legacyBody();
  delete body.client_brand;
  assert.match(String(validateSiteflowRequest(body)), /client_brand is required/);
});

test("validateSiteflowRequest: unknown `template` is rejected, never forwarded", () => {
  const body = legacyBody({ template: "algum_id_arbitrario", params: ["x"] });
  assert.match(String(validateSiteflowRequest(body)), /not one of the known SiteFlow templates/);
});

test("validateSiteflowRequest: confirmacao_contato requires params of exact length and consent", () => {
  const ok = validateSiteflowRequest(
    legacyBody({ template: "confirmacao_contato", params: ["Maria"] })
  );
  assert.equal(typeof ok, "object");

  const wrongLength = validateSiteflowRequest(
    legacyBody({ template: "confirmacao_contato", params: ["Maria", "extra"] })
  );
  assert.match(String(wrongLength), /params must have exactly 1 value/);

  const noConsent = legacyBody({ template: "confirmacao_contato", params: ["Maria"] });
  delete noConsent.consent;
  assert.match(String(validateSiteflowRequest(noConsent)), /consent is required/);
});

test("validateSiteflowRequest: notificacao_interna requires 2 params and NEVER requires consent", () => {
  const body = legacyBody({
    template: "notificacao_interna",
    params: ["Maria Silva", "+5511988887777"],
  });
  delete body.consent; // no consent object at all — must still validate.
  const result = validateSiteflowRequest(body);
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("unexpected error: " + result);
  assert.equal(result.spec.requiresConsent, false);
  assert.deepEqual(result.params, ["Maria Silva", "+5511988887777"]);
});

test("validateSiteflowRequest: notificacao_interna still rejects a wrong param count", () => {
  const body = legacyBody({ template: "notificacao_interna", params: ["only-one"] });
  delete body.consent;
  assert.match(String(validateSiteflowRequest(body)), /params must have exactly 2 value/);
});

test("validateSiteflowRequest: rejects non-string / empty params entries", () => {
  const body = legacyBody({ template: "confirmacao_contato", params: [""] });
  assert.match(String(validateSiteflowRequest(body)), /params is required/);
});

test("validateSiteflowRequest: phone/client_id/conversation_id/lead_id/visitor_first_name always required, regardless of template", () => {
  for (const field of ["client_id", "conversation_id", "lead_id", "visitor_first_name", "phone"]) {
    const body = legacyBody({ template: "notificacao_interna", params: ["a", "b"] });
    delete body.consent;
    delete body[field];
    assert.match(String(validateSiteflowRequest(body)), new RegExp(`${field} is required`));
  }
});

// ---------------------------------------------------------------------
// createSiteflowDispatchHandler — secret gates (unchanged behaviour)
// ---------------------------------------------------------------------

test("handler: missing SITEFLOW_DISPATCH_SECRET -> 503, provider never called", async () => {
  delete process.env.SITEFLOW_DISPATCH_SECRET;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const handler = createSiteflowDispatchHandler("token");
  const res = fakeRes();
  await handler(fakeReq(legacyBody(), HEADERS), res);

  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

test("handler: wrong secret header -> 401, provider never called", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const handler = createSiteflowDispatchHandler("token");
  const res = fakeRes();
  await handler(fakeReq(legacyBody(), { "x-siteflow-dispatch-secret": "wrong" }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------
// Regression — ausência de `template` continua enviando siteflow_continuar_conversa
// ---------------------------------------------------------------------

test("regression: omitting `template` sends siteflow_continuar_conversa with [visitor_first_name, client_brand], byte-for-byte", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = "provider-id-legacy";
  const { calls } = mockFetchOk({ id: "wamid.abc", chatId: "chat-1" });

  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(fakeReq(legacyBody(), HEADERS), res);

  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.template_name, "siteflow_continuar_conversa");
  assert.deepEqual(body.params, ["Maria", "1pra5"]);

  const sentBody = JSON.parse((calls[0] as { body: string }).body);
  assert.equal(sentBody.templateId, "provider-id-legacy");
  assert.deepEqual(sentBody.params, ["Maria", "1pra5"]);
  assert.equal(sentBody.contactName, "Maria");
});

// ---------------------------------------------------------------------
// Dispatcher resolves each of the three templates correctly (11-13)
// ---------------------------------------------------------------------

test("dispatcher resolves confirmacao_contato: correct provider id, correct params", async () => {
  process.env.SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID = "provider-id-confirmacao";
  const { calls } = mockFetchOk({ id: "wamid.conf", chatId: null });

  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(
    fakeReq(legacyBody({ template: "confirmacao_contato", params: ["Maria"] }), HEADERS),
    res
  );

  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.template_name, "siteflow_confirmacao_contato");
  const sentBody = JSON.parse((calls[0] as { body: string }).body);
  assert.equal(sentBody.templateId, "provider-id-confirmacao");
  assert.deepEqual(sentBody.params, ["Maria"]);
});

test("dispatcher resolves notificacao_interna: correct provider id, correct params, no consent required", async () => {
  process.env.SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID = "provider-id-interna";
  const { calls } = mockFetchOk({ id: "wamid.int", chatId: null });

  const body = legacyBody({
    template: "notificacao_interna",
    params: ["Maria Silva", "+5511988887777"],
    phone: "+5521999998888", // Rafael's number — the dispatcher does not care whose it is.
  });
  delete body.consent;

  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(fakeReq(body, HEADERS), res);

  assert.equal(res.statusCode, 200);
  const resBody = res.body as Record<string, unknown>;
  assert.equal(resBody.template_name, "siteflow_nova_solicitacao_interna");
  const sentBody = JSON.parse((calls[0] as { body: string }).body);
  assert.equal(sentBody.templateId, "provider-id-interna");
  assert.deepEqual(sentBody.params, ["Maria Silva", "+5511988887777"]);
});

test("unknown template is rejected with 400, provider never called", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(
    fakeReq(legacyBody({ template: "siteflow_qualquer_coisa", params: ["x"] }), HEADERS),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------
// Consent (15-16)
// ---------------------------------------------------------------------

test("consent continues to be mandatory for the visitor-facing legacy template", async () => {
  const body = legacyBody({ consent: { granted: false, granted_at: NOW, source: "siteflow-web" } });
  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(fakeReq(body, HEADERS), res);
  assert.equal(res.statusCode, 403);
});

test("consent continues to be mandatory for confirmacao_contato", async () => {
  const body = legacyBody({
    template: "confirmacao_contato",
    params: ["Maria"],
    consent: { granted: false, granted_at: NOW, source: "siteflow-web" },
  });
  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(fakeReq(body, HEADERS), res);
  assert.equal(res.statusCode, 403);
});

test("notificacao_interna has the ONE explicit consent exception — never granted:false is checked, never synthesized", async () => {
  process.env.SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID = "provider-id-interna";
  mockFetchOk({ id: "wamid.int" });

  // Even a body claiming granted:false is accepted — the field is simply
  // ignored for this one template, never inspected, never forged as true.
  const body = legacyBody({
    template: "notificacao_interna",
    params: ["Maria Silva", "+5511988887777"],
    consent: { granted: false, granted_at: NOW, source: "siteflow-web" },
  });
  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  await handler(fakeReq(body, HEADERS), res);
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------
// Missing per-template env var isolates that template only
// ---------------------------------------------------------------------

test("missing env var for one template -> 503 naming that template; other templates stay configured", async () => {
  // Only the legacy template is configured.
  process.env.SITEFLOW_TEMPLATE_ID = "provider-id-legacy";

  const handler = createSiteflowDispatchHandler("umbler-token");
  const res = fakeRes();
  const body = legacyBody({ template: "confirmacao_contato", params: ["Maria"] });
  await handler(fakeReq(body, HEADERS), res);

  assert.equal(res.statusCode, 503);
  assert.match(String((res.body as Record<string, unknown>).error), /siteflow_confirmacao_contato/);
});

// ---------------------------------------------------------------------
// Dry-run: no provider call, no per-template env var required
// ---------------------------------------------------------------------

test("dry-run: any of the three templates simulate without calling the provider or requiring its env var", async () => {
  process.env.DRY_RUN = "true";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  for (const [key, body] of [
    ["legacy", legacyBody()],
    ["confirmacao", legacyBody({ template: "confirmacao_contato", params: ["Maria"] })],
    [
      "interna",
      (() => {
        const b = legacyBody({ template: "notificacao_interna", params: ["Maria Silva", "+5511988887777"] });
        delete b.consent;
        return b;
      })(),
    ],
  ] as const) {
    const handler = createSiteflowDispatchHandler("umbler-token");
    const res = fakeRes();
    await handler(fakeReq(body, HEADERS), res);
    assert.equal(res.statusCode, 200, `dry-run failed for ${key}`);
    const resBody = res.body as Record<string, unknown>;
    assert.equal(resBody.dry_run, true);
    assert.equal(resBody.accepted, true);
  }
  assert.equal(called, false);
});

// ---------------------------------------------------------------------
// Closed registry — a template is never chosen by the numbers array
// or by a raw provider id: SITEFLOW_TEMPLATES is the only source.
// ---------------------------------------------------------------------

test("SITEFLOW_TEMPLATES is a closed set of exactly the three approved templates", () => {
  assert.deepEqual(Object.keys(SITEFLOW_TEMPLATES).sort(), [
    "confirmacao_contato",
    "continuar_conversa",
    "notificacao_interna",
  ]);
  assert.equal(SITEFLOW_TEMPLATES.continuar_conversa.logicalName, "siteflow_continuar_conversa");
  assert.equal(SITEFLOW_TEMPLATES.confirmacao_contato.logicalName, "siteflow_confirmacao_contato");
  assert.equal(SITEFLOW_TEMPLATES.notificacao_interna.logicalName, "siteflow_nova_solicitacao_interna");
});

// =====================================================================
// Slice 4 — dispatcher failure metadata (provider_attempted / failure_stage)
//
// The invariant under test: ONLY a literal `provider_attempted: false` may
// prove that no provider request was initiated. Every outcome at or after the
// provider-attempt boundary — timeout, reset, 5xx, malformed body, exception —
// must stay `true`, however clearly the dispatcher "failed".
// =====================================================================

const PROVIDER_ID = "provider-id-legacy";
const FULL_PHONE = "+5511988887777";

/** Install a fetch stub that fails the test if the provider is ever called. */
function blockFetch(): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async () => {
    counter.calls++;
    throw new Error("provider must not be called");
  }) as typeof fetch;
  return counter;
}

/** Install a fetch stub returning a fixed body/status, counting invocations. */
function mockFetchStatus(body: string, status: number): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async () => {
    counter.calls++;
    return new Response(body, { status });
  }) as typeof fetch;
  return counter;
}

/** Install a fetch stub that throws, counting invocations. */
function mockFetchThrow(error: unknown): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async () => {
    counter.calls++;
    throw error;
  }) as typeof fetch;
  return counter;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function runDispatch(
  body: unknown,
  headers: Record<string, string> = HEADERS,
): Promise<Response & FakeRes> {
  const res = fakeRes();
  await createSiteflowDispatchHandler("umbler-token")(fakeReq(body, headers), res);
  return res;
}

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "1pra5",
    conversation_id: "conv-1",
    lead_id: "lead-1",
    to_phone: FULL_PHONE,
    text: "Resumo da sua conversa.",
    ...overrides,
  };
}

async function runMessage(
  body: unknown,
  headers: Record<string, string> = HEADERS,
): Promise<Response & FakeRes> {
  const res = fakeRes();
  await createSiteflowMessageHandler("umbler-token")(fakeReq(body, headers), res);
  return res;
}

function meta(res: Response & FakeRes): { attempted: unknown; stage: unknown } {
  const body = res.body as Record<string, unknown>;
  return { attempted: body.provider_attempted, stage: body.failure_stage };
}

// ---------------------------------------------------------------------
// Pre-provider failures — the ONLY responses allowed to prove a non-send
// ---------------------------------------------------------------------

test("metadata: missing SITEFLOW_DISPATCH_SECRET -> 503, provider_attempted:false / configuration", async () => {
  delete process.env.SITEFLOW_DISPATCH_SECRET;
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(meta(res), { attempted: false, stage: "configuration" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: wrong secret header -> 401, provider_attempted:false / request_validation", async () => {
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody(), { "x-siteflow-dispatch-secret": "wrong" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(meta(res), { attempted: false, stage: "request_validation" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: invalid payload -> 400, provider_attempted:false / request_validation", async () => {
  const fetchCalls = blockFetch();
  const body = legacyBody();
  delete body.client_id;
  const res = await runDispatch(body);
  assert.equal(res.statusCode, 400);
  assert.match(String((res.body as Record<string, unknown>).error), /client_id is required/);
  assert.deepEqual(meta(res), { attempted: false, stage: "request_validation" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: unknown template -> 400, provider_attempted:false / request_validation", async () => {
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody({ template: "nao_existe", params: ["x"] }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(meta(res), { attempted: false, stage: "request_validation" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: consent not granted -> 403, provider_attempted:false / request_validation", async () => {
  const fetchCalls = blockFetch();
  const res = await runDispatch(
    legacyBody({ consent: { granted: false, granted_at: NOW, source: "siteflow-web" } }),
  );
  assert.equal(res.statusCode, 403);
  assert.deepEqual(meta(res), { attempted: false, stage: "request_validation" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: invalid phone -> 400, provider_attempted:false / request_validation", async () => {
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody({ phone: "+14155550000" }));
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as Record<string, unknown>).error, "Invalid phone number.");
  assert.deepEqual(meta(res), { attempted: false, stage: "request_validation" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: template env var unset -> 503, provider_attempted:false / configuration", async () => {
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody({ template: "confirmacao_contato", params: ["Maria"] }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(meta(res), { attempted: false, stage: "configuration" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: DRY_RUN -> success with provider_attempted:false / none, provider never called", async () => {
  process.env.DRY_RUN = "true";
  const fetchCalls = blockFetch();
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.dry_run, true);
  assert.equal(body.accepted, true);
  assert.equal(body.message_state, "simulated");
  assert.deepEqual(meta(res), { attempted: false, stage: "none" });
  assert.equal(fetchCalls.calls, 0);
});

// ---------------------------------------------------------------------
// Provider was reached — every outcome stays attempted
// ---------------------------------------------------------------------

test("metadata: provider 200 -> success, provider_attempted:true / none", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  const fetchCalls = mockFetchStatus(JSON.stringify({ id: "wamid.abc" }), 200);
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).success, true);
  assert.deepEqual(meta(res), { attempted: true, stage: "none" });
  assert.equal(fetchCalls.calls, 1);
});

test("metadata: provider 400 structured rejection -> HTTP 200 success:false, attempted / provider_rejected", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  const fetchCalls = mockFetchStatus(JSON.stringify({ message: "template not approved" }), 400);
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.accepted, false);
  assert.equal(body.error, "template not approved");
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_rejected" });
  assert.equal(fetchCalls.calls, 1);
});

test("metadata: provider 500 -> attempted / provider_indeterminate", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  const fetchCalls = mockFetchStatus(JSON.stringify({ error: "boom" }), 500);
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).success, false);
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_indeterminate" });
  assert.equal(fetchCalls.calls, 1);
});

test("metadata: provider timeout (AbortError) -> attempted / provider_indeterminate", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  const fetchCalls = mockFetchThrow(namedError("AbortError", "This operation was aborted"));
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_indeterminate" });
  assert.equal(fetchCalls.calls, 1);
});

test("metadata: connection reset (TypeError) -> attempted / provider_indeterminate", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  const fetchCalls = mockFetchThrow(new TypeError("fetch failed"));
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_indeterminate" });
  assert.equal(fetchCalls.calls, 1);
});

test("metadata: provider 200 with an HTML body -> attempted, never false", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  mockFetchStatus("<html><body>hello</body></html>", 200);
  const res = await runDispatch(legacyBody());
  assert.equal(res.statusCode, 200);
  assert.equal(meta(res).attempted, true);
});

test("metadata: provider 502 with an HTML body -> attempted / provider_indeterminate", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  mockFetchStatus("<html>502 Bad Gateway</html>", 502);
  const res = await runDispatch(legacyBody());
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_indeterminate" });
});

// ---------------------------------------------------------------------
// Unexpected exceptions — sanitized JSON 500 envelope
// ---------------------------------------------------------------------

test("metadata: exception BEFORE the boundary -> 500, provider_attempted:false / pre_provider_error", async () => {
  const fetchCalls = blockFetch();
  const req = {
    body: legacyBody(),
    header: () => {
      throw new Error("header exploded");
    },
  } as unknown as Request;

  const res = fakeRes();
  await createSiteflowDispatchHandler("umbler-token")(req, res);

  assert.equal(res.statusCode, 500);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.error, "Unexpected dispatcher error.");
  assert.deepEqual(meta(res), { attempted: false, stage: "pre_provider_error" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata: exception AFTER the boundary -> 500, provider_attempted:true / provider_indeterminate", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  mockFetchStatus(JSON.stringify({ id: "wamid.abc" }), 200);

  // Throws on the FIRST json() call (the success response) and records the
  // second (the sanitized 500 the catch produces).
  let thrown = false;
  const res = fakeRes();
  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    if (!thrown) {
      thrown = true;
      throw new Error(`serialize failed token=umbler-token phone=${FULL_PHONE} tpl=${PROVIDER_ID}`);
    }
    return originalJson(payload);
  }) as typeof res.json;

  await createSiteflowDispatchHandler("umbler-token")(fakeReq(legacyBody(), HEADERS), res);

  assert.equal(thrown, true);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(meta(res), { attempted: true, stage: "provider_indeterminate" });

  // The sanitized envelope leaks nothing from the raw exception.
  const serialized = JSON.stringify(res.body);
  assert.equal((res.body as Record<string, unknown>).error, "Unexpected dispatcher error.");
  assert.equal(serialized.includes("serialize failed"), false);
  assert.equal(serialized.includes("umbler-token"), false);
  assert.equal(serialized.includes(PROVIDER_ID), false);
  assert.equal(serialized.includes(FULL_PHONE), false);
});

test("metadata: the handler never writes a second body once headers are sent", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  mockFetchStatus(JSON.stringify({ id: "wamid.abc" }), 200);

  const res = fakeRes();
  res.headersSent = true;
  res.json = (() => {
    throw new Error("stream already closed");
  }) as typeof res.json;

  await createSiteflowDispatchHandler("umbler-token")(fakeReq(legacyBody(), HEADERS), res);

  // The catch bailed out on headersSent instead of writing a second body.
  assert.equal(res.body, undefined);
});

// ---------------------------------------------------------------------
// /api/siteflow/message — same contract
// ---------------------------------------------------------------------

test("metadata (message): pre-provider failures are all provider_attempted:false", async () => {
  const cases: Array<{
    name: string;
    run: () => Promise<Response & FakeRes>;
    status: number;
    stage: string;
  }> = [
    {
      name: "wrong secret",
      run: () => runMessage(messageBody(), { "x-siteflow-dispatch-secret": "wrong" }),
      status: 401,
      stage: "request_validation",
    },
    {
      name: "missing field",
      run: () => runMessage(messageBody({ text: "" })),
      status: 400,
      stage: "request_validation",
    },
    {
      name: "text too long",
      run: () => runMessage(messageBody({ text: "x".repeat(4001) })),
      status: 400,
      stage: "request_validation",
    },
    {
      name: "invalid phone",
      run: () => runMessage(messageBody({ to_phone: "+14155550000" })),
      status: 400,
      stage: "request_validation",
    },
  ];

  for (const c of cases) {
    const fetchCalls = blockFetch();
    const res = await c.run();
    assert.equal(res.statusCode, c.status, c.name);
    assert.deepEqual(meta(res), { attempted: false, stage: c.stage }, c.name);
    assert.equal(fetchCalls.calls, 0, c.name);
  }
});

test("metadata (message): missing SITEFLOW_DISPATCH_SECRET -> 503 / configuration", async () => {
  delete process.env.SITEFLOW_DISPATCH_SECRET;
  const fetchCalls = blockFetch();
  const res = await runMessage(messageBody());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(meta(res), { attempted: false, stage: "configuration" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata (message): DRY_RUN -> provider_attempted:false / none, provider never called", async () => {
  process.env.DRY_RUN = "1";
  const fetchCalls = blockFetch();
  const res = await runMessage(messageBody());
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).dry_run, true);
  assert.deepEqual(meta(res), { attempted: false, stage: "none" });
  assert.equal(fetchCalls.calls, 0);
});

test("metadata (message): provider outcomes are always attempted", async () => {
  const cases: Array<{ name: string; stub: () => { calls: number }; stage: string }> = [
    {
      name: "200",
      stub: () => mockFetchStatus(JSON.stringify({ id: "wamid.x" }), 200),
      stage: "none",
    },
    {
      name: "404",
      stub: () => mockFetchStatus(JSON.stringify({ message: "no" }), 404),
      stage: "provider_rejected",
    },
    { name: "500", stub: () => mockFetchStatus("{}", 500), stage: "provider_indeterminate" },
    {
      name: "throw",
      stub: () => mockFetchThrow(new TypeError("fetch failed")),
      stage: "provider_indeterminate",
    },
    {
      name: "AbortError",
      stub: () => mockFetchThrow(namedError("AbortError", "aborted")),
      stage: "provider_indeterminate",
    },
  ];

  for (const c of cases) {
    const fetchCalls = c.stub();
    const res = await runMessage(messageBody());
    assert.equal(res.statusCode, 200, c.name);
    assert.deepEqual(meta(res), { attempted: true, stage: c.stage }, c.name);
    assert.equal(fetchCalls.calls, 1, `${c.name}: exactly one provider call, no retry`);
  }
});

// ---------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------

test("INVARIANT: no attempted/ambiguous outcome is ever reported as provider_attempted:false", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;

  const attemptedStubs: Array<{ name: string; stub: () => { calls: number } }> = [
    { name: "200 json", stub: () => mockFetchStatus(JSON.stringify({ id: "a" }), 200) },
    { name: "200 html", stub: () => mockFetchStatus("<html>ok</html>", 200) },
    { name: "400", stub: () => mockFetchStatus(JSON.stringify({ message: "no" }), 400) },
    { name: "429", stub: () => mockFetchStatus("{}", 429) },
    { name: "500", stub: () => mockFetchStatus("{}", 500) },
    { name: "502 html", stub: () => mockFetchStatus("<html>bad</html>", 502) },
    { name: "TypeError", stub: () => mockFetchThrow(new TypeError("fetch failed")) },
    { name: "AbortError", stub: () => mockFetchThrow(namedError("AbortError", "aborted")) },
    { name: "TimeoutError", stub: () => mockFetchThrow(namedError("TimeoutError", "timed out")) },
    { name: "non-Error", stub: () => mockFetchThrow("boom") },
  ];

  for (const c of attemptedStubs) {
    const fetchCalls = c.stub();
    for (const res of [await runDispatch(legacyBody()), await runMessage(messageBody())]) {
      const { attempted, stage } = meta(res);
      assert.notEqual(attempted, false, `${c.name}: must never be a proven non-send`);
      assert.equal(attempted, true, c.name);
      assert.notEqual(stage, "pre_provider_error", c.name);
      assert.notEqual(stage, "request_validation", c.name);
      assert.notEqual(stage, "configuration", c.name);
    }
    assert.equal(fetchCalls.calls, 2, `${c.name}: one call per handler, no retry`);
  }
});

test("INVARIANT: every SiteFlow send response carries both metadata fields", async () => {
  process.env.SITEFLOW_TEMPLATE_ID = PROVIDER_ID;
  mockFetchStatus(JSON.stringify({ id: "wamid.abc" }), 200);

  const responses = [
    await runDispatch(legacyBody()),
    await runMessage(messageBody()),
    await runDispatch(legacyBody(), { "x-siteflow-dispatch-secret": "wrong" }),
    await runMessage(messageBody(), { "x-siteflow-dispatch-secret": "wrong" }),
  ];

  for (const res of responses) {
    const body = res.body as Record<string, unknown>;
    assert.equal(typeof body.provider_attempted, "boolean");
    assert.equal(typeof body.failure_stage, "string");
  }
});
