# zapflow-disparo-teste

Minimal Node.js + TypeScript proof of concept that sends **one** approved
WhatsApp template message through **Umbler Talk**.

This is intentionally tiny: no frontend, no database, no batch sending, no
chatbot logic. Just one script that fires a single template message.

> **Integrating a website with the deployed API?** See
> [docs/INTEGRATION.md](docs/INTEGRATION.md) for the production base URL,
> endpoints, payload shape, examples, and caveats.

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
| `SITEFLOW_DISPATCH_SECRET` | Shared secret for `POST /api/siteflow/dispatch` (see below) |
| `SITEFLOW_TEMPLATE_ID`   | Umbler template ID for `siteflow_continuar_conversa`  |
| `DRY_RUN`                | `1` simulates the SiteFlow dispatch without calling Umbler |

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
  "accepted": 1,
  "failed": 0,
  "delivery_status": "pending",
  "results": [
    {
      "contact_id": "juan",
      "name": "Juan",
      "phone": "+5521971906175",
      "accepted": true,
      "status": 200,
      "message_state": "Processing",
      "provider_message_id": "...",
      "chat_id": "...",
      "error": null
    }
  ]
}
```

> `accepted` means Umbler accepted the request — **not** that WhatsApp delivered
> or read the message. `delivery_status` is always `"pending"`.

Example call (does a **real** dispatch — only run when you mean it):

```bash
curl -X POST http://localhost:3000/api/dispatch \
  -H "Content-Type: application/json" \
  -H "x-dispatch-secret: $DISPATCH_SECRET" \
  --data @payloads/test-campaign.json
```

> The Umbler token is only read from the environment and is never printed.

### `POST /api/siteflow/dispatch`

Server-to-server endpoint for the SiteFlow integration. Sends **one** template
message to **one** visitor who has explicitly consented. It is completely
separate from `/api/dispatch`: different secret, different payload, different
template.

**Authentication.** Requires the header `x-siteflow-dispatch-secret`, matched
against `SITEFLOW_DISPATCH_SECRET`. A missing or wrong value returns `401`. If
the variable itself is not configured the route returns `503` — the rest of the
server, including `/api/dispatch`, keeps working.

Request body:

```json
{
  "client_id": "client-example",
  "client_brand": "Marca Exemplo",
  "conversation_id": "conversation-example",
  "lead_id": "lead-example",
  "visitor_first_name": "Ana",
  "phone": "+5511900000000",
  "consent": {
    "granted": true,
    "granted_at": "2026-07-28T14:00:00Z",
    "source": "siteflow-web"
  }
}
```

| Field                 | Rule                                                     |
| --------------------- | -------------------------------------------------------- |
| `client_id`           | required, non-empty string                                |
| `client_brand`        | required — template param `{{2}}`                         |
| `conversation_id`     | required, non-empty string                                |
| `lead_id`             | required, non-empty string                                |
| `visitor_first_name`  | required — template param `{{1}}`                         |
| `phone`               | required; normalized with the same Brazilian rules as `/api/dispatch` |
| `consent.granted`     | must be exactly `true`                                    |
| `consent.granted_at`  | required ISO-8601 date string                             |
| `consent.source`      | required, non-empty string                                |

**Template.** The logical name is `siteflow_continuar_conversa`
(`{{1}} = visitor_first_name`, `{{2}} = client_brand`, plus the static
"Receber resumo" quick-reply button). Params are always sent in the order
`[visitor_first_name, client_brand]`. The provider ID comes only from
`SITEFLOW_TEMPLATE_ID` — it is never hardcoded and never returned in a response.

**Dry run.** With `DRY_RUN=1` (or `true`) the request is fully validated and
then simulated: Umbler is never called, no WhatsApp message is sent,
`SITEFLOW_TEMPLATE_ID` is not required, and the template does not need to be
approved. The response carries `"dry_run": true` and
`"message_state": "simulated"`. `DRY_RUN` affects this endpoint only —
`/api/dispatch` ignores it.

Response (dry run):

```json
{
  "success": true,
  "dry_run": true,
  "client_id": "client-example",
  "conversation_id": "conversation-example",
  "lead_id": "lead-example",
  "template_name": "siteflow_continuar_conversa",
  "phone": "+5511*******00",
  "params": ["Ana", "Marca Exemplo"],
  "accepted": true,
  "status": null,
  "message_state": "simulated",
  "provider_message_id": null,
  "chat_id": null,
  "delivery_status": "pending",
  "error": null
}
```

Errors: `400` (invalid payload or phone), `401` (bad secret), `403`
(`Consent was not granted.`), `503` (secret or template not configured).

Example call — safe, because `DRY_RUN=1` stops before any provider call:

```bash
curl -X POST http://localhost:3000/api/siteflow/dispatch \
  -H "Content-Type: application/json" \
  -H "x-siteflow-dispatch-secret: $SITEFLOW_DISPATCH_SECRET" \
  --data '{"client_id":"client-example","client_brand":"Marca Exemplo","conversation_id":"conversation-example","lead_id":"lead-example","visitor_first_name":"Ana","phone":"+5511900000000","consent":{"granted":true,"granted_at":"2026-07-28T14:00:00Z","source":"siteflow-web"}}'
```

> The phone number is masked in both logs and responses — the full number is
> never written to the console.

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
| `SITEFLOW_DISPATCH_SECRET` | Shared secret for the `x-siteflow-dispatch-secret` header (**secret**) |
| `SITEFLOW_TEMPLATE_ID`  | Umbler template ID for `siteflow_continuar_conversa`    |
| `DRY_RUN`               | Leave **unset** in production — `1` only simulates sends |

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
