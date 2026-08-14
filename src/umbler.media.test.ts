import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getMessageMedia } from "./umbler.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Install a fake fetch that returns exactly one canned JSON response. */
function mockFetchJson(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("getMessageMedia: File.url null -> processing, media/token never leaked", async () => {
  mockFetchJson(200, { id: "msg-1", messageState: "Processing", file: { url: null } });

  const result = await getMessageMedia("msg-1", "secret-token");

  assert.equal(result.state, "processing");
  assert.equal(result.media, null);
  assert.equal(result.error, null);
});

test("getMessageMedia: absent file -> processing", async () => {
  mockFetchJson(200, { id: "msg-1", messageState: "Processing" });

  const result = await getMessageMedia("msg-1", "secret-token");

  assert.equal(result.state, "processing");
});

test("getMessageMedia: File.url populated -> ready with sanitized contract, ignores MessageState", async () => {
  mockFetchJson(200, {
    id: "msg-2",
    // MessageState intentionally still "Processing" here — readiness must
    // come from File.url alone, matching measured real-production behavior.
    messageState: "Processing",
    file: {
      url: "https://utalk-wamedia.s3.amazonaws.com/some/audio.mp3",
      contentType: "audio/mpeg",
      originalSizeBytes: 171198,
      transcription: null,
    },
  });

  const result = await getMessageMedia("msg-2", "secret-token");

  assert.equal(result.state, "ready");
  assert.deepEqual(result.media, {
    url: "https://utalk-wamedia.s3.amazonaws.com/some/audio.mp3",
    contentType: "audio/mpeg",
    sizeBytes: 171198,
  });
  assert.equal(result.error, null);
});

test("getMessageMedia: preserves contentType audio/mpeg and OriginalSizeBytes exactly", async () => {
  mockFetchJson(200, {
    id: "msg-3",
    file: { url: "https://example-bucket.s3.amazonaws.com/x.mp3", contentType: "audio/mpeg", originalSizeBytes: 70888 },
  });

  const result = await getMessageMedia("msg-3", "secret-token");

  assert.equal(result.media?.contentType, "audio/mpeg");
  assert.equal(result.media?.sizeBytes, 70888);
});

test("getMessageMedia: non-HTTPS media URL rejected fail-closed", async () => {
  mockFetchJson(200, {
    id: "msg-4",
    file: { url: "http://insecure.example.com/audio.mp3", contentType: "audio/mpeg" },
  });

  const result = await getMessageMedia("msg-4", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.match(result.error ?? "", /https/i);
});

test("getMessageMedia: malformed media URL rejected fail-closed", async () => {
  mockFetchJson(200, {
    id: "msg-5",
    file: { url: "not-a-url", contentType: "audio/mpeg" },
  });

  const result = await getMessageMedia("msg-5", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
});

test("getMessageMedia: Umbler 404 sanitized", async () => {
  mockFetchJson(404, { title: "Not Found", status: 404 });

  const result = await getMessageMedia("msg-missing", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.equal(result.error, "Message not found.");
});

test("getMessageMedia: Umbler malformed (non-JSON) response sanitized", async () => {
  globalThis.fetch = (async () =>
    new Response("<html>not json</html>", { status: 200 })) as typeof fetch;

  const result = await getMessageMedia("msg-6", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.ok(result.error);
});

test("getMessageMedia: network error sanitized to a fixed message, never throws", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;

  const result = await getMessageMedia("msg-7", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.equal(result.error, "Umbler request failed.");
});

test("getMessageMedia: AbortError (timeout) sanitized to a fixed message", async () => {
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  const result = await getMessageMedia("msg-7b", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.equal(result.error, "Umbler request timed out.");
});

test("getMessageMedia: other non-2xx (500) sanitized to a fixed message", async () => {
  mockFetchJson(500, { title: "Internal Server Error" });

  const result = await getMessageMedia("msg-500", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.media, null);
  assert.equal(result.error, "Umbler media lookup failed.");
});

test("getMessageMedia: hostile provider 'message' field never reaches the caller", async () => {
  const secretPayload = "fake-token-abc123 https://internal.example.com/secret-path";
  mockFetchJson(500, {
    title: "boom",
    error: secretPayload,
    message: secretPayload,
    errorMessage: secretPayload,
  });

  const result = await getMessageMedia("msg-hostile", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.error, "Umbler media lookup failed.");
  assert.ok(!(result.error ?? "").includes("fake-token-abc123"));
  assert.ok(!(result.error ?? "").includes("internal.example.com"));
});

test("getMessageMedia: hostile exception message (fake token/URL) never reaches the caller", async () => {
  globalThis.fetch = (async () => {
    throw new Error("failed for token=fake-token-xyz789 at https://leaky.example.com/path");
  }) as typeof fetch;

  const result = await getMessageMedia("msg-hostile-2", "secret-token");

  assert.equal(result.state, "error");
  assert.equal(result.error, "Umbler request failed.");
  assert.ok(!(result.error ?? "").includes("fake-token-xyz789"));
  assert.ok(!(result.error ?? "").includes("leaky.example.com"));
});

test("getMessageMedia: never sends the media URL back through a download request", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    const url = String(input);
    // The only network call this function may make is the messages lookup —
    // never a request to the media host itself.
    assert.ok(url.includes("app-utalk.umbler.com/api/v1/messages/"));
    return new Response(
      JSON.stringify({ id: "msg-8", file: { url: "https://media.example.com/a.mp3" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  await getMessageMedia("msg-8", "secret-token");

  assert.equal(calls, 1);
});
