import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";

import {
  createSiteflowDispatchHandler,
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
}

/** Minimal fake Express Response that records status/json calls. */
function fakeRes(): Response & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined,
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
