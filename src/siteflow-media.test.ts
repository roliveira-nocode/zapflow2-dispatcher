import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";

import { createSiteflowMediaHandler, validateSiteflowMediaRequest } from "./siteflow-media.js";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.SITEFLOW_DISPATCH_SECRET;
const SECRET = "test-siteflow-secret";

beforeEach(() => {
  process.env.SITEFLOW_DISPATCH_SECRET = SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) {
    delete process.env.SITEFLOW_DISPATCH_SECRET;
  } else {
    process.env.SITEFLOW_DISPATCH_SECRET = originalSecret;
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
  headers: Record<string, string>;
}

/** Minimal fake Express Response that records status/json/set calls. */
function fakeRes(): Response & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  } as unknown as Response & FakeRes;
  return res;
}

function mockFetchJson(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("validateSiteflowMediaRequest: rejects missing/empty messageId", () => {
  assert.match(validateSiteflowMediaRequest({}) ?? "", /messageId is required/);
  assert.match(validateSiteflowMediaRequest({ messageId: "" }) ?? "", /messageId is required/);
  assert.match(validateSiteflowMediaRequest({ messageId: "   " }) ?? "", /messageId is required/);
});

test("validateSiteflowMediaRequest: rejects invalid format and oversized ids", () => {
  assert.ok(validateSiteflowMediaRequest({ messageId: "has a space" }));
  assert.ok(validateSiteflowMediaRequest({ messageId: "../etc/passwd" }));
  assert.ok(validateSiteflowMediaRequest({ messageId: "a".repeat(200) }));
});

test("validateSiteflowMediaRequest: accepts a real-shaped provider id", () => {
  assert.equal(validateSiteflowMediaRequest({ messageId: "an4ZQL9PiM6AvyyT" }), null);
});

test("handler: missing secret header -> 401, Umbler never called", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, error: "Unauthorized." });
  assert.equal(fetchCalled, false);
});

test("handler: wrong secret header -> 401", async () => {
  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": "wrong" });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
});

test("handler: secret not configured on server -> 503", async () => {
  delete process.env.SITEFLOW_DISPATCH_SECRET;

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 503);
});

test("handler: invalid messageId -> 400, Umbler never called", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

test("handler: media not ready -> 200 { success:true, state:'processing' }, no-store", async () => {
  mockFetchJson(200, { id: "msg-1", messageState: "Processing", file: { url: null } });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, state: "processing" });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("handler: media ready -> only the sanitized media contract is returned", async () => {
  mockFetchJson(200, {
    id: "msg-2",
    messageState: "Processing",
    content: null,
    contact: { name: "Someone", phoneNumber: "+5511999999999" },
    chat: { id: "chat-secret" },
    file: {
      url: "https://utalk-wamedia.s3.amazonaws.com/x.mp3",
      contentType: "audio/mpeg",
      originalSizeBytes: 171198,
      transcription: null,
    },
  });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    state: "ready",
    media: {
      url: "https://utalk-wamedia.s3.amazonaws.com/x.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 171198,
    },
  });
  // No contact/chat/content fields leaked into the response.
  const keys = Object.keys(res.body as object);
  assert.deepEqual(keys.sort(), ["media", "state", "success"]);
});

test("handler: Umbler 404 -> 502 sanitized, no provider body leaked", async () => {
  mockFetchJson(404, { title: "Not Found", traceId: "internal-trace-id-should-not-leak" });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: "Message not found." });
});

test("handler: Umbler network error -> 502 sanitized fixed message, token never leaked", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  const handler = createSiteflowMediaHandler("super-secret-umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: "Umbler request failed." });
  const bodyText = JSON.stringify(res.body);
  assert.ok(!bodyText.includes("super-secret-umbler-token"));
});

test("handler: hostile provider error body (fake secret/URL in 'message') never reaches the client", async () => {
  const hostilePayload = "fake-secret-abc123 https://internal.example.com/leak";
  mockFetchJson(500, { title: "boom", message: hostilePayload, error: hostilePayload });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: "Umbler media lookup failed." });
  const bodyText = JSON.stringify(res.body);
  assert.ok(!bodyText.includes("fake-secret-abc123"));
  assert.ok(!bodyText.includes("internal.example.com"));
});

test("handler: hostile fetch exception (fake token/URL in error.message) never reaches the client", async () => {
  globalThis.fetch = (async () => {
    throw new Error("failed for token=fake-token-xyz789 at https://leaky.example.com/path");
  }) as typeof fetch;

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: "Umbler request failed." });
  const bodyText = JSON.stringify(res.body);
  assert.ok(!bodyText.includes("fake-token-xyz789"));
  assert.ok(!bodyText.includes("leaky.example.com"));
});

test("handler: timeout (AbortError) -> 502 fixed sanitized message", async () => {
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: "Umbler request timed out." });
});

test("handler: media URL appears only in the successful ready contract, never in an error body", async () => {
  const secretLookingUrl = "https://utalk-wamedia.s3.amazonaws.com/should-not-leak-on-error.mp3";
  // Non-HTTPS on top of a value containing our sentinel URL as a decoy path
  // segment — the point is that no error path ever echoes back a URL.
  mockFetchJson(500, { message: secretLookingUrl });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  const bodyText = JSON.stringify(res.body);
  assert.ok(!bodyText.includes("utalk-wamedia.s3.amazonaws.com"));
});

test("handler: non-HTTPS media URL from provider -> 502 fail-closed, not returned", async () => {
  mockFetchJson(200, { id: "msg-3", file: { url: "http://insecure.example.com/a.mp3" } });

  const handler = createSiteflowMediaHandler("umbler-token");
  const req = fakeReq({ messageId: "an4ZQL9PiM6AvyyT" }, { "x-siteflow-dispatch-secret": SECRET });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal((res.body as { success: boolean }).success, false);
});
