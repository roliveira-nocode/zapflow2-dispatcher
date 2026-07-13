# zapflow-disparo-teste

Minimal Node.js + TypeScript proof of concept that sends **one** approved
WhatsApp template message through **Umbler Talk**.

This is intentionally tiny: no frontend, no database, no batch sending, no
chatbot logic. Just one script that fires a single template message.

## Requirements

- Node.js **18+** (uses the built-in `fetch`). Tested on Node 24.

## Setup

```bash
npm install
```

Then create your local `.env` from the example and fill in real values:

```bash
cp .env.example .env
```

| Variable                 | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `UMBLER_TALK_API_TOKEN`  | Umbler Talk bearer token (**secret** — never commit)  |
| `TEST_TO_PHONE`          | Destination phone in E.164 format, e.g. `+5521999998888` |
| `TEST_CONTACT_NAME`      | Template param 1 (contact name)                       |
| `TEST_REASON`            | Template param 2 (contact reason / message)           |
| `DISPATCH_SECRET`        | Shared secret required to call the local API (see below) |
| `PORT`                   | Port the local API listens on (default `3000`)        |
| `MAX_CONTACTS`           | Max contacts allowed per dispatch (default `20`)      |

> Keep `DISPATCH_SECRET` out of source control. The provided value
> `change-this-secret` in `.env.example` is a placeholder — set a real secret in
> your local `.env`.

> The API token is **only** read from the environment. It is never hardcoded in
> source and never printed to the console.

## Send the test message

```bash
npm run send:test
```

The script will:

1. Read the four env vars above (and fail clearly if any is missing).
2. Build the request body and POST it to Umbler Talk.
3. Print the response status and response body.

## Request details

- **Method:** `POST`
- **URL:** `https://app-utalk.umbler.com/api/v1/template-messages/simplified/`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Body:**

```json
{
  "toPhone": "<TEST_TO_PHONE>",
  "fromPhone": "+5521990047343",
  "organizationId": "aQDFQYsjuFhKAP11",
  "templateId": "aYSx9KNRwPC0hnHe",
  "params": ["<TEST_CONTACT_NAME>", "<TEST_REASON>"],
  "contactName": "<TEST_CONTACT_NAME>",
  "skipReassign": false
}
```

The `fromPhone`, `organizationId`, and `templateId` values are fixed constants
in `src/send-test-template.ts` for this PoC.

## Local HTTP API

`src/server.ts` exposes a minimal local Express API that accepts a campaign
payload and sends the same approved template to every contact using the existing
Umbler Talk logic. No frontend, database, queue, or auto-dispatch — it only sends
when you POST to it.

Start it:

```bash
npm run dev
```

It listens on `PORT` (default `3000`).

### `GET /health`

Returns `{ "ok": true }`.

### `POST /api/dispatch`

Requires the header `x-dispatch-secret`, matched against `DISPATCH_SECRET` from
the environment. A missing or wrong secret returns `401`.

The body is the same structure as `payloads/test-campaign.json`:

```json
{
  "campaign_id": "teste_rafael_juan_001",
  "campaign_name": "Teste interno Juan e Rafael",
  "template_id": "aYSx9KNRwPC0hnHe",
  "contacts": [
    {
      "contact_id": "juan",
      "name": "Juan",
      "phone": "+5521971906175",
      "reason": "estamos validando o primeiro teste de disparo em campanha via Zapflow"
    }
  ]
}
```

Validation: `campaign_id`, `campaign_name`, and `template_id` are required;
`contacts` must be a non-empty array; each contact needs `contact_id`, `name`,
`phone`, and `reason`. Invalid bodies return `400`.

Additional guards:

- **Approved templates only.** Only `template_id` values registered in the
  dispatcher are allowed. Any other value returns `400` with
  `"Template is not approved for this local dispatcher."`
- **Phone normalization.** Phones are normalized to `+<digits>` E.164 form
  (e.g. `(21) 97190-6175` → `+5521971906175`). A contact with an invalid phone
  is marked failed and skipped — Umbler is not called for it.
- **Contact limit.** A payload with more than `MAX_CONTACTS` contacts (default
  `20`, from the environment) returns `400`.

Each contact is sent independently — one failure does not stop the rest. The
response summarizes the run and reports only concise per-contact fields (never
the raw provider response):

```json
{
  "success": true,
  "campaign_id": "teste_rafael_juan_001",
  "campaign_name": "Teste interno Juan e Rafael",
  "template_id": "aYSx9KNRwPC0hnHe",
  "template_label": "zapflow_primeiro_contato_v1",
  "total": 1,
  "sent": 1,
  "failed": 0,
  "results": [
    {
      "contact_id": "juan",
      "name": "Juan",
      "phone": "+5521971906175",
      "ok": true,
      "status": 200,
      "message_state": "Processing",
      "provider_message_id": "...",
      "chat_id": "...",
      "error": null
    }
  ]
}
```

Example call (does a **real** dispatch — only run when you mean it):

```bash
curl -X POST http://localhost:3000/api/dispatch \
  -H "Content-Type: application/json" \
  -H "x-dispatch-secret: $DISPATCH_SECRET" \
  --data @payloads/test-campaign.json
```

> The Umbler token is only read from the environment and is never printed.

## Deploying to Vercel

This project is deployed to **Vercel from GitHub** — push the repository to
GitHub and import it as a Vercel project. Vercel builds and hosts the same
Express app (`src/server.ts`) as a serverless function; no code changes are
needed between local and production.

How it works:

- `api/index.ts` re-exports the Express app from `src/server.ts` as the Vercel
  serverless handler.
- `vercel.json` rewrites every request (`/(.*)`) to that function, so the public
  routes stay exactly the same: `GET /health` and `POST /api/dispatch`.
- `src/server.ts` only calls `app.listen(...)` when the `VERCEL` env var is
  **not** set, so `npm run dev` still starts a normal local server while Vercel
  invokes the exported app directly.

### Environment variables

**Never commit `.env`.** It is git-ignored and its values must be set in the
Vercel dashboard instead (Project → Settings → Environment Variables):

| Variable                | Description                                              |
| ----------------------- | ------------------------------------------------------- |
| `UMBLER_TALK_API_TOKEN` | Umbler Talk bearer token (**secret**)                   |
| `DISPATCH_SECRET`       | Shared secret required in the `x-dispatch-secret` header |
| `MAX_CONTACTS`          | Max contacts allowed per dispatch (e.g. `20`)           |

`PORT` is only used for the local server (`npm run dev`) and is **not needed on
Vercel** — the platform handles routing, so you can leave it unset in
production.

### Test after deploy

Once deployed, replace `<vercel-url>` with your deployment URL:

```bash
# Health check
curl https://<vercel-url>/health
# → {"ok":true}

# Dispatch (real send — only run when you mean it)
curl -X POST https://<vercel-url>/api/dispatch \
  -H "Content-Type: application/json" \
  -H "x-dispatch-secret: <your DISPATCH_SECRET>" \
  --data @payloads/test-campaign.json
```
