/**
 * POST /api/siteflow/preflight — zero-send configuration/arity check.
 *
 * The whole point of this endpoint is that it never reaches the provider, so
 * the fetch stub installed in beforeEach COUNTS and THROWS, and afterEach
 * fails any test in which it was touched even once.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";

import {
  createSiteflowPreflightHandler,
  PREFLIGHT_CODES,
  validateSiteflowPreflightRequest,
} from "./siteflow-preflight.js";

const SECRET = "test-siteflow-secret";
const HEADERS = { "x-siteflow-dispatch-secret": SECRET };
/** Stand-in for a real Umbler provider ID. A real one must never be committed. */
const PROVIDER_ID_SENTINEL = "PROVIDER-ID-SENTINEL";
/** Provider-ID-SHAPED but entirely fake — never a real approved ID. */
const FAKE_PROVIDER_ID = "aoi-FAKE-PROVIDER-ID";

/** The complete closed registry, with each entry's env var and arity. */
const ALL_TEMPLATES = [
  { key: "continuar_conversa", envVar: "SITEFLOW_TEMPLATE_ID", params: 2 },
  { key: "confirmacao_contato", envVar: "SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID", params: 1 },
  { key: "notificacao_interna", envVar: "SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID", params: 2 },
  { key: "camp_primeiro_contato", envVar: "SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID", params: 2 },
  {
    key: "camp_reativacao_comercial",
    envVar: "SITEFLOW_TEMPLATE_CAMP_REATIVACAO_COMERCIAL_ID",
    params: 2,
  },
  { key: "camp_convite_comercial", envVar: "SITEFLOW_TEMPLATE_CAMP_CONVITE_COMERCIAL_ID", params: 2 },
  {
    key: "compartilhar_link_contextual",
    envVar: "SITEFLOW_TEMPLATE_COMPARTILHAR_LINK_CONTEXTUAL_ID",
    params: 3,
  },
] as const;

/** The four templates Slice 5 registers. */
const CAMPAIGN_TEMPLATES = ALL_TEMPLATES.filter(
  (t) => t.key.startsWith("camp_") || t.key === "compartilhar_link_contextual",
);
/** The three that existed before Slice 5. */
const EXISTING_TEMPLATES = ALL_TEMPLATES.filter((t) => !CAMPAIGN_TEMPLATES.includes(t));

const ENV_KEYS = ["SITEFLOW_DISPATCH_SECRET", "DRY_RUN", ...ALL_TEMPLATES.map((t) => t.envVar)];
const savedEnv = new Map<string, string | undefined>();

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.SITEFLOW_DISPATCH_SECRET = SECRET;
  delete process.env.DRY_RUN;
  for (const t of ALL_TEMPLATES) delete process.env[t.envVar];

  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("preflight must never reach the provider");
  }) as typeof fetch;
});

afterEach(() => {
  const calls = fetchCalls;
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  // Global zero-send guard: no preflight path may ever touch the network.
  assert.equal(calls, 0, "preflight called fetch");
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

async function preflight(
  body: unknown,
  headers: Record<string, string> = HEADERS,
): Promise<Response & FakeRes> {
  const res = fakeRes();
  await createSiteflowPreflightHandler()(fakeReq(body, headers), res);
  return res;
}

function bodyOf(res: Response & FakeRes): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

/** Configure every template with the sentinel provider ID. */
function configureAll(): void {
  for (const t of ALL_TEMPLATES) process.env[t.envVar] = PROVIDER_ID_SENTINEL;
}

// ---------------------------------------------------------------------
// Ready path — all four new keys, and the three that already existed
// ---------------------------------------------------------------------

test("the four campaign templates are recognized and report ready when configured", async () => {
  configureAll();
  for (const t of CAMPAIGN_TEMPLATES) {
    const res = await preflight({ template: t.key, params_count: t.params });
    assert.equal(res.statusCode, 200, t.key);
    assert.deepEqual(bodyOf(res), {
      success: true,
      ready: true,
      template: t.key,
      expected_params: t.params,
      provider_attempted: false,
      failure_stage: "none",
    });
  }
});

test("the three pre-existing templates keep working, unchanged", async () => {
  configureAll();
  for (const t of EXISTING_TEMPLATES) {
    const res = await preflight({ template: t.key, params_count: t.params });
    assert.equal(res.statusCode, 200, t.key);
    assert.equal(bodyOf(res).ready, true, t.key);
    assert.equal(bodyOf(res).expected_params, t.params, t.key);
  }
});

test("arity is exactly 2 / 2 / 2 for the camp_* templates and 3 for compartilhar_link_contextual", async () => {
  configureAll();
  const expected: Record<string, number> = {
    camp_primeiro_contato: 2,
    camp_reativacao_comercial: 2,
    camp_convite_comercial: 2,
    compartilhar_link_contextual: 3,
  };
  for (const [key, count] of Object.entries(expected)) {
    const res = await preflight({ template: key, params_count: count });
    assert.equal(bodyOf(res).expected_params, count, key);
    assert.equal(bodyOf(res).ready, true, key);
  }
});

// ---------------------------------------------------------------------
// Arity mismatches
// ---------------------------------------------------------------------

test("too few params is rejected, and the response carries the authoritative count", async () => {
  configureAll();
  for (const t of ALL_TEMPLATES) {
    const res = await preflight({ template: t.key, params_count: t.params - 1 });
    assert.equal(res.statusCode, 400, t.key);
    const body = bodyOf(res);
    assert.equal(body.code, PREFLIGHT_CODES.PARAMS_COUNT_MISMATCH, t.key);
    assert.equal(body.ready, false, t.key);
    assert.equal(body.expected_params, t.params, t.key);
    assert.equal(body.template, t.key, t.key);
  }
});

test("too many params is rejected", async () => {
  configureAll();
  for (const t of ALL_TEMPLATES) {
    const res = await preflight({ template: t.key, params_count: t.params + 1 });
    assert.equal(res.statusCode, 400, t.key);
    assert.equal(bodyOf(res).code, PREFLIGHT_CODES.PARAMS_COUNT_MISMATCH, t.key);
    assert.equal(bodyOf(res).expected_params, t.params, t.key);
  }
});

test("zero params is rejected for every template (none takes zero)", async () => {
  configureAll();
  for (const t of ALL_TEMPLATES) {
    const res = await preflight({ template: t.key, params_count: 0 });
    assert.equal(bodyOf(res).code, PREFLIGHT_CODES.PARAMS_COUNT_MISMATCH, t.key);
  }
});

// ---------------------------------------------------------------------
// Unknown key / raw provider IDs
// ---------------------------------------------------------------------

test("an unknown logical key is rejected, with no expected_params to guess from", async () => {
  configureAll();
  const res = await preflight({ template: "nao_existe", params_count: 2 });
  assert.equal(res.statusCode, 400);
  const body = bodyOf(res);
  assert.equal(body.code, PREFLIGHT_CODES.UNKNOWN_TEMPLATE);
  assert.equal(body.ready, false);
  assert.equal("expected_params" in body, false);
  assert.equal("template" in body, false);
});

test("a provider-ID-shaped string is NOT accepted as a logical template key", async () => {
  configureAll();
  for (const candidate of [FAKE_PROVIDER_ID, "amjmzFAKEFAKEFAKE", "aoi-_fake_-id"]) {
    const res = await preflight({ template: candidate, params_count: 2 });
    assert.equal(res.statusCode, 400, candidate);
    assert.equal(bodyOf(res).code, PREFLIGHT_CODES.UNKNOWN_TEMPLATE, candidate);
  }
});

// ---------------------------------------------------------------------
// Auth and dispatcher configuration
// ---------------------------------------------------------------------

test("missing secret header is rejected", async () => {
  configureAll();
  const res = await preflight({ template: "camp_primeiro_contato", params_count: 2 }, {});
  assert.equal(res.statusCode, 401);
  assert.equal(bodyOf(res).code, PREFLIGHT_CODES.UNAUTHORIZED);
  assert.equal(bodyOf(res).error, "Unauthorized.");
});

test("wrong secret header is rejected, and the expected value is never echoed", async () => {
  configureAll();
  const res = await preflight(
    { template: "camp_primeiro_contato", params_count: 2 },
    { "x-siteflow-dispatch-secret": "wrong" },
  );
  assert.equal(res.statusCode, 401);
  assert.equal(bodyOf(res).code, PREFLIGHT_CODES.UNAUTHORIZED);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false);
});

test("SITEFLOW_DISPATCH_SECRET unset -> 503, checked before authentication", async () => {
  delete process.env.SITEFLOW_DISPATCH_SECRET;
  configureAll();
  // Even a wrong header still gets the configuration answer, not 401.
  const res = await preflight(
    { template: "camp_primeiro_contato", params_count: 2 },
    { "x-siteflow-dispatch-secret": "wrong" },
  );
  assert.equal(res.statusCode, 503);
  assert.equal(bodyOf(res).code, PREFLIGHT_CODES.DISPATCH_NOT_CONFIGURED);
  assert.equal(bodyOf(res).error, "SiteFlow dispatch is not configured.");
});

// ---------------------------------------------------------------------
// Provider-template configuration
// ---------------------------------------------------------------------

test("a known template whose env var is unset -> 503 naming only that template", async () => {
  configureAll();
  delete process.env.SITEFLOW_TEMPLATE_CAMP_CONVITE_COMERCIAL_ID;

  const res = await preflight({ template: "camp_convite_comercial", params_count: 2 });
  assert.equal(res.statusCode, 503);
  const body = bodyOf(res);
  assert.equal(body.code, PREFLIGHT_CODES.TEMPLATE_NOT_CONFIGURED);
  assert.equal(body.ready, false);
  assert.equal(body.error, 'SiteFlow template "camp_convite_comercial" is not configured.');
  assert.equal(body.template, "camp_convite_comercial");
  assert.equal(body.expected_params, 2);

  // The other six are unaffected.
  const other = await preflight({ template: "camp_primeiro_contato", params_count: 2 });
  assert.equal(other.statusCode, 200);
  assert.equal(bodyOf(other).ready, true);
});

test("an env var set to whitespace counts as unset", async () => {
  configureAll();
  process.env.SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID = "   ";
  const res = await preflight({ template: "camp_primeiro_contato", params_count: 2 });
  assert.equal(res.statusCode, 503);
  assert.equal(bodyOf(res).code, PREFLIGHT_CODES.TEMPLATE_NOT_CONFIGURED);
});

test("DRY_RUN cannot hide a missing provider-template configuration", async () => {
  for (const value of ["1", "true"]) {
    process.env.DRY_RUN = value;
    // Every template env var is unset here.
    const res = await preflight({ template: "camp_primeiro_contato", params_count: 2 });
    assert.equal(res.statusCode, 503, `DRY_RUN=${value}`);
    assert.equal(bodyOf(res).code, PREFLIGHT_CODES.TEMPLATE_NOT_CONFIGURED, `DRY_RUN=${value}`);
    assert.equal(bodyOf(res).ready, false, `DRY_RUN=${value}`);
  }
});

test("DRY_RUN does not change a ready answer either", async () => {
  configureAll();
  process.env.DRY_RUN = "1";
  const res = await preflight({ template: "camp_primeiro_contato", params_count: 2 });
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).ready, true);
});

// ---------------------------------------------------------------------
// Body shape
// ---------------------------------------------------------------------

test("malformed bodies are rejected with INVALID_REQUEST", async () => {
  configureAll();
  const cases: unknown[] = [
    null,
    "a string",
    42,
    {},
    { params_count: 2 },
    { template: "camp_primeiro_contato" },
    { template: 123, params_count: 2 },
    { template: "", params_count: 2 },
    { template: "   ", params_count: 2 },
    { template: "camp_primeiro_contato", params_count: "2" },
    { template: "camp_primeiro_contato", params_count: -1 },
    { template: "camp_primeiro_contato", params_count: 1.5 },
    { template: "camp_primeiro_contato", params_count: Number.NaN },
    { template: "camp_primeiro_contato", params_count: Number.POSITIVE_INFINITY },
    { template: "camp_primeiro_contato", params_count: null },
  ];

  for (const body of cases) {
    const res = await preflight(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(bodyOf(res).code, PREFLIGHT_CODES.INVALID_REQUEST, JSON.stringify(body));
    assert.equal(bodyOf(res).ready, false, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------
// Unexpected exception
// ---------------------------------------------------------------------

test("an unexpected exception yields a sanitized 500 with pre_provider_error", async () => {
  configureAll();
  const req = {
    body: { template: "camp_primeiro_contato", params_count: 2 },
    header: () => {
      throw new Error(`header exploded secret=${SECRET} id=${PROVIDER_ID_SENTINEL}`);
    },
  } as unknown as Request;

  const res = fakeRes();
  await createSiteflowPreflightHandler()(req, res);

  assert.equal(res.statusCode, 500);
  const body = bodyOf(res);
  assert.equal(body.success, false);
  assert.equal(body.ready, false);
  assert.equal(body.code, PREFLIGHT_CODES.UNEXPECTED_ERROR);
  assert.equal(body.error, "Unexpected dispatcher error.");
  assert.equal(body.provider_attempted, false);
  assert.equal(body.failure_stage, "pre_provider_error");

  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes("header exploded"), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PROVIDER_ID_SENTINEL), false);
});

test("nothing is written once headers are already sent", async () => {
  configureAll();
  const res = fakeRes();
  res.headersSent = true;
  res.json = (() => {
    throw new Error("stream already closed");
  }) as typeof res.json;

  await createSiteflowPreflightHandler()(
    fakeReq({ template: "camp_primeiro_contato", params_count: 2 }, HEADERS),
    res,
  );
  assert.equal(res.body, undefined);
});

// ---------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------

/** Every distinct response preflight can produce, in one place. */
async function everyResponse(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];

  configureAll();
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 2 })));
  out.push(bodyOf(await preflight({ template: "compartilhar_link_contextual", params_count: 3 })));
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 1 })));
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 9 })));
  out.push(bodyOf(await preflight({ template: "nao_existe", params_count: 2 })));
  out.push(bodyOf(await preflight({ template: FAKE_PROVIDER_ID, params_count: 2 })));
  out.push(bodyOf(await preflight({}, HEADERS)));
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 2 }, {})));
  out.push(
    bodyOf(
      await preflight(
        { template: "camp_primeiro_contato", params_count: 2 },
        { "x-siteflow-dispatch-secret": "wrong" },
      ),
    ),
  );

  delete process.env.SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID;
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 2 })));

  delete process.env.SITEFLOW_DISPATCH_SECRET;
  out.push(bodyOf(await preflight({ template: "camp_primeiro_contato", params_count: 2 })));

  return out;
}

test("INVARIANT: provider_attempted is literal false on every preflight response", async () => {
  for (const body of await everyResponse()) {
    assert.equal(body.provider_attempted, false, JSON.stringify(body));
    assert.notEqual(body.provider_attempted, true, JSON.stringify(body));
  }
});

test("INVARIANT: preflight never produces a provider_* failure stage", async () => {
  for (const body of await everyResponse()) {
    assert.notEqual(body.failure_stage, "provider_rejected", JSON.stringify(body));
    assert.notEqual(body.failure_stage, "provider_indeterminate", JSON.stringify(body));
    assert.equal(
      ["none", "request_validation", "configuration", "pre_provider_error"].includes(
        String(body.failure_stage),
      ),
      true,
      JSON.stringify(body),
    );
  }
});

test("INVARIANT: no response ever contains a provider template ID or the secret", async () => {
  for (const body of await everyResponse()) {
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(PROVIDER_ID_SENTINEL), false, serialized);
    assert.equal(serialized.includes(SECRET), false, serialized);
  }
});

test("INVARIANT: preflight never infers or reports consent", async () => {
  configureAll();
  const withoutConsent = await preflight({ template: "camp_primeiro_contato", params_count: 2 });
  const withConsent = await preflight({
    template: "camp_primeiro_contato",
    params_count: 2,
    consent: { granted: true, granted_at: "2026-08-26T00:00:00.000Z", source: "forged" },
  });

  // A consent object in the body is ignored entirely — byte-identical output.
  assert.deepEqual(withConsent.body, withoutConsent.body);

  for (const body of await everyResponse()) {
    for (const key of ["consent", "consent_granted", "granted", "phone"]) {
      assert.equal(key in body, false, `${key} must not appear in ${JSON.stringify(body)}`);
    }
  }
});

test("STRUCTURAL: the preflight module cannot send — it never imports the provider transport", async () => {
  const source = await readFile(new URL("./siteflow-preflight.ts", import.meta.url), "utf8");

  // Scan the EXECUTABLE code only. The module's doc comment deliberately names
  // what it refuses to do ("does not import ./umbler.js"), and that prose must
  // not be mistaken for the thing itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.equal(code.includes("umbler"), false, "must not reference the provider transport");
  assert.equal(/\bfetch\s*\(/.test(code), false, "must not call fetch");
  assert.equal(code.includes("sendTemplateMessage"), false);
  assert.equal(code.includes("sendTextMessage"), false);
  assert.equal(code.includes("apiToken"), false, "must never receive the provider token");
  // The handler factory takes no apiToken.
  assert.equal(createSiteflowPreflightHandler.length, 0);
});

// ---------------------------------------------------------------------
// validateSiteflowPreflightRequest — the pure layer, tested directly
// ---------------------------------------------------------------------

test("validateSiteflowPreflightRequest: resolves a valid request", () => {
  const result = validateSiteflowPreflightRequest({
    template: "compartilhar_link_contextual",
    params_count: 3,
  });
  assert.equal("code" in result, false);
  if ("code" in result) throw new Error("unexpected failure");
  if (result.kind !== "static") throw new Error("expected the static path");
  assert.equal(result.templateKey, "compartilhar_link_contextual");
  assert.equal(result.expectedParams, 3);
  assert.equal(result.spec.envVar, "SITEFLOW_TEMPLATE_COMPARTILHAR_LINK_CONTEXTUAL_ID");
});

test("validateSiteflowPreflightRequest: returns the right code for each rejection", () => {
  const cases: Array<[unknown, string]> = [
    [null, PREFLIGHT_CODES.INVALID_REQUEST],
    [{}, PREFLIGHT_CODES.INVALID_REQUEST],
    [{ template: "camp_primeiro_contato" }, PREFLIGHT_CODES.INVALID_REQUEST],
    [{ template: "nao_existe", params_count: 2 }, PREFLIGHT_CODES.UNKNOWN_TEMPLATE],
    [
      { template: "camp_primeiro_contato", params_count: 3 },
      PREFLIGHT_CODES.PARAMS_COUNT_MISMATCH,
    ],
  ];

  for (const [input, code] of cases) {
    const result = validateSiteflowPreflightRequest(input);
    assert.equal("code" in result, true, JSON.stringify(input));
    if (!("code" in result)) throw new Error("expected a failure");
    assert.equal(result.code, code, JSON.stringify(input));
  }
});

test("validateSiteflowPreflightRequest: is pure — it reads no environment", () => {
  // Every template env var is unset in beforeEach, yet resolution still works:
  // configuration is the handler's step 6, not the validator's job.
  const result = validateSiteflowPreflightRequest({
    template: "camp_reativacao_comercial",
    params_count: 2,
  });
  assert.equal("code" in result, false);
});

// =====================================================================
// Dynamic campaign-template path — server-authoritative provider_template_id
//
// Presence of `provider_template_id` switches a request onto this path,
// bypassing the closed static registry (and its env-var configuration
// check — there is nothing to configure server-side for a dynamic
// template) entirely. Uses the SAME shared validator as the real dispatch
// route in src/siteflow.ts — the fixtures below are the exact same set
// exercised there, so a malformed ID is rejected identically by both.
// =====================================================================

const DYNAMIC_PROVIDER_ID = "aYSx9KNRwPC0hnHe";

/** Same malformed fixtures exercised in src/siteflow.test.ts. */
const INVALID_PROVIDER_TEMPLATE_IDS = [
  "",
  "   ",
  "has space",
  "semi;colon",
  "slash/es",
  "emoji-😀-id",
  "a".repeat(129),
];

function dynamicPreflightBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: "camp_catalogo_dinamico_v3",
    provider_template_id: DYNAMIC_PROVIDER_ID,
    requires_consent: true,
    ...overrides,
  };
}

test("dynamic: a well-formed request reports ready, with no expected_params (no registered arity)", async () => {
  const res = await preflight(dynamicPreflightBody());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), {
    success: true,
    ready: true,
    template: "camp_catalogo_dinamico_v3",
    provider_attempted: false,
    failure_stage: "none",
  });
});

test("dynamic: params_count is not required and is never used to reject a dynamic request", async () => {
  const body = dynamicPreflightBody();
  delete body.params_count; // not present anyway, but explicit about intent
  const res = await preflight(body);
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).ready, true);
});

test("dynamic: does not read a per-template env var — ready with nothing configured server-side", async () => {
  // Sanity: no campaign env var is set (beforeEach clears them all).
  assert.equal(process.env.SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID, undefined);
  const res = await preflight(dynamicPreflightBody());
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).ready, true);
});

test("dynamic: malformed provider_template_id fixtures are all rejected with INVALID_PROVIDER_TEMPLATE_ID, ready:false", async () => {
  for (const badId of INVALID_PROVIDER_TEMPLATE_IDS) {
    const res = await preflight(dynamicPreflightBody({ provider_template_id: badId }));
    assert.equal(res.statusCode, 400, JSON.stringify(badId));
    const body = bodyOf(res);
    assert.equal(body.ready, false, JSON.stringify(badId));
    assert.equal(body.code, PREFLIGHT_CODES.INVALID_PROVIDER_TEMPLATE_ID, JSON.stringify(badId));
    assert.match(String(body.error), /provider_template_id/, JSON.stringify(badId));
  }
});

test("dynamic: a blank (whitespace-only) provider_template_id is rejected with a clear code and message", async () => {
  const res = await preflight(dynamicPreflightBody({ provider_template_id: "   " }));
  assert.equal(res.statusCode, 400);
  const body = bodyOf(res);
  assert.equal(body.code, PREFLIGHT_CODES.INVALID_PROVIDER_TEMPLATE_ID);
  assert.match(String(body.error), /provider_template_id is required/);
});

test("dynamic: template (logical identity) is still required", async () => {
  const body = dynamicPreflightBody();
  delete body.template;
  const res = await preflight(body);
  assert.equal(res.statusCode, 400);
  assert.equal(bodyOf(res).code, PREFLIGHT_CODES.INVALID_REQUEST);
  assert.match(String(bodyOf(res).error), /template is required/);
});

test("dynamic: a template identity outside the closed static registry still resolves (not looked up there)", async () => {
  const res = await preflight(dynamicPreflightBody({ template: "qualquer_identidade_siteflow_v9" }));
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).template, "qualquer_identidade_siteflow_v9");
});

test("dynamic: requires_consent missing or non-boolean fails closed with INVALID_REQUEST", async () => {
  for (const value of [undefined, "true", 1, 0, null, {}]) {
    const overrides: Record<string, unknown> =
      value === undefined ? {} : { requires_consent: value };
    const body = dynamicPreflightBody(overrides);
    if (value === undefined) delete body.requires_consent;
    const res = await preflight(body);
    assert.equal(res.statusCode, 400, JSON.stringify(value));
    const resBody = bodyOf(res);
    assert.equal(resBody.code, PREFLIGHT_CODES.INVALID_REQUEST, JSON.stringify(value));
    assert.match(String(resBody.error), /requires_consent must be a boolean/, JSON.stringify(value));
  }
});

test("dynamic: requires_consent=false resolves ready — preflight never checks consent evidence either way", async () => {
  const res = await preflight(dynamicPreflightBody({ requires_consent: false }));
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).ready, true);
});

test("dynamic: never claims provider_attempted:true, ready or not", async () => {
  const ready = await preflight(dynamicPreflightBody());
  assert.equal(bodyOf(ready).provider_attempted, false);

  const notReady = await preflight(dynamicPreflightBody({ provider_template_id: "" }));
  assert.equal(bodyOf(notReady).provider_attempted, false);
});
