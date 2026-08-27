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
      "error": null,
      "provider_attempted": true,
      "failure_stage": "none"
    }
  ]
}
```

> `accepted` means Umbler accepted the request — **not** that WhatsApp delivered
> or read the message. `delivery_status` is always `"pending"`.

> `provider_attempted` / `failure_stage` say whether Umbler was actually
> called. Only a literal `"provider_attempted": false` proves it was not —
> see `docs/INTEGRATION.md` §17.7.

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

Request body (legacy — `template` omitted, exactly as before):

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
| `client_brand`        | required **only when `template` is omitted** — template param `{{2}}` of the legacy default |
| `conversation_id`     | required, non-empty string                                |
| `lead_id`             | required, non-empty string                                |
| `visitor_first_name`  | always required — used as the Umbler contact name for every template |
| `phone`               | required; normalized with the same Brazilian rules as `/api/dispatch` |
| `consent`             | required and validated, **unless** the resolved template's `requiresConsent` is `false` (only `siteflow_nova_solicitacao_interna` today) |
| `consent.granted`     | must be exactly `true` when consent is required           |
| `consent.granted_at`  | required ISO-8601 date string, when consent is required   |
| `consent.source`      | required, non-empty string, when consent is required       |
| `template`            | optional. One of the closed set of logical keys below. Omitted = the legacy default (`continuar_conversa`) |
| `params`              | required **when `template` is present**: an array of non-empty strings, in the template's declared order, with the exact length the template expects. Ignored when `template` is omitted (legacy params are always computed from `visitor_first_name` + `client_brand`) |

**Templates.** A closed set — `src/siteflow.ts`, `SITEFLOW_TEMPLATES` — the
only thing `template` may name. A caller can never send a raw provider
template ID.

| `template` key           | Logical (Meta/Umbler) name          | Params, in order                    | Consent required | Provider ID env var                        |
| ------------------------- | ------------------------------------ | ------------------------------------ | ------------------ | -------------------------------------------- |
| `continuar_conversa` (default) | `siteflow_continuar_conversa`        | `[visitor_first_name, client_brand]` | yes                 | `SITEFLOW_TEMPLATE_ID`                        |
| `confirmacao_contato`      | `siteflow_confirmacao_contato`       | `[visitor_first_name]`               | yes                 | `SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID`    |
| `notificacao_interna`      | `siteflow_nova_solicitacao_interna`  | `[visitor_name, visitor_phone]`      | **no**              | `SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID`    |
| `camp_primeiro_contato`    | `camp_primeiro_contato`              | `[first_name, contextual_message]`   | yes                 | `SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID`  |
| `camp_reativacao_comercial`| `camp_reativacao_comercial`          | `[first_name, contextual_reason]`    | yes                 | `SITEFLOW_TEMPLATE_CAMP_REATIVACAO_COMERCIAL_ID` |
| `camp_convite_comercial`   | `camp_convite_comercial`             | `[first_name, contextual_invitation]`| yes                 | `SITEFLOW_TEMPLATE_CAMP_CONVITE_COMERCIAL_ID` |
| `compartilhar_link_contextual` | `compartilhar_link_contextual`   | `[first_name, contextual_reason, link]` | yes              | `SITEFLOW_TEMPLATE_COMPARTILHAR_LINK_CONTEXTUAL_ID` |

The last four are the approved **campaign** templates: registered, not
activated. Each stays unsendable until its own env var is set and each requires
explicit granted consent, exactly like any other visitor-facing template. Use
`POST /api/siteflow/preflight` below to check whether one is dispatchable.

`continuar_conversa` also carries the static "Receber resumo" quick-reply
button; `notificacao_interna` carries the static "Ver resumo do contato"
quick-reply button. Neither needs any payload handling here — both live in
the template approved on Meta/Umbler.

`notificacao_interna` is the one exception to the consent gate: it is never
sent to the visitor (the caller resolves its own destination number — e.g. a
fixed internal number — server-side; this endpoint never picks it), so there
is no visitor consent to check. No consent is ever synthesized for it;
`consent`, if sent, is simply ignored.

A per-template provider ID that is unset only disables **that** template —
`503 { "error": "SiteFlow template \"<logical name>\" is not configured." }`
— the other two keep working.

**Dynamic campaign-template path (`provider_template_id`).** An alternative
to the closed registry above, for campaign templates SiteFlow manages in its
own persistent catalog. Sending `provider_template_id` — instead of, or in
addition to, one of the `template` keys above — switches the request onto
this path entirely:

```json
{
  "client_id": "client-example",
  "conversation_id": "conversation-example",
  "lead_id": "lead-example",
  "visitor_first_name": "Ana",
  "phone": "+5511900000000",
  "template": "camp_catalogo_dinamico_v3",
  "provider_template_id": "aYSx9KNRwPC0hnHe",
  "requires_consent": true,
  "params": ["Ana", "mensagem contextual personalizada"],
  "consent": {
    "granted": true,
    "granted_at": "2026-07-28T14:00:00Z",
    "source": "siteflow-web"
  }
}
```

| Field                  | Rule                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `template`              | still required — a free-text logical/internal identity for audit and logging only. Not checked against `SITEFLOW_TEMPLATES` |
| `provider_template_id`  | required. The raw Umbler/Meta provider ID, resolved **server-side by SiteFlow** from its own frozen catalog revision. Validated by the same strict validator used by `/api/siteflow/preflight` (`src/siteflow-template-id.ts`) — reject empty, whitespace-only, malformed, or unreasonably long values |
| `requires_consent`      | required, and must be an explicit `true`/`false` — derived server-side by SiteFlow from the frozen template's policy. Missing or non-boolean is rejected before any provider attempt |
| `params`                | required: an array of non-empty strings, preserved in the exact order sent — **no fixed-arity check** against any registry |

Consent then follows `requires_consent` exactly like the static path follows
`requiresConsent`: `true` requires valid `consent` evidence (fails closed if
missing/invalid), `false` never requires and never fabricates it.

The browser and any LLM in the loop never see or send a provider template
ID — only SiteFlow's server does, over this same authenticated
server-to-server secret. The dynamic path never reads a per-template env
var (there is nothing to configure server-side for it) and never performs
the closed registry's fixed-arity check. Static visitor templates above are
completely unaffected — this path only activates when
`provider_template_id` is present in the request.

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
  "error": null,
  "provider_attempted": false,
  "failure_stage": "none"
}
```

Errors: `400` (invalid payload, unknown `template`, wrong `params` length, or
invalid phone), `401` (bad secret), `403` (`Consent was not granted.` —
never for `notificacao_interna`), `503` (secret or that template's env var
not configured), `500` (unexpected dispatcher error, sanitized).

**Failure metadata.** Every response of this endpoint and of
`/api/siteflow/message` also carries `provider_attempted` and `failure_stage`.
They answer one question — was Umbler actually called? Only a literal
`"provider_attempted": false` proves it was not; `true`, an unexpected value
or an absent field all mean the message may already be on its way. A dry run
is `false` / `none` because nothing is sent. Never read "the dispatcher
returned an error" as "the provider was not called": a timeout, a connection
reset, a `5xx` and a malformed body are all reported as attempted. The
dispatcher has no retry mechanism. Full contract in `docs/INTEGRATION.md`
§17.7.

Example call — safe, because `DRY_RUN=1` stops before any provider call:

```bash
curl -X POST http://localhost:3000/api/siteflow/dispatch \
  -H "Content-Type: application/json" \
  -H "x-siteflow-dispatch-secret: $SITEFLOW_DISPATCH_SECRET" \
  --data '{"client_id":"client-example","client_brand":"Marca Exemplo","conversation_id":"conversation-example","lead_id":"lead-example","visitor_first_name":"Ana","phone":"+5511900000000","consent":{"granted":true,"granted_at":"2026-07-28T14:00:00Z","source":"siteflow-web"}}'
```

> The phone number is masked in both logs and responses — the full number is
> never written to the console.

### `POST /api/siteflow/preflight`

Zero-send check: **is the dispatcher configured to send this template with this
many params?** Built for campaign preparation, so you never have to attempt a
real send to find out. No side effects — safe to call as often as you like.

Same secret as `/api/siteflow/dispatch`. Body:

```json
{ "template": "camp_primeiro_contato", "params_count": 2 }
```

The **count only** — preflight never accepts the params themselves; it has no
use for names, copy or links. Ready:

```json
{
  "success": true,
  "ready": true,
  "template": "camp_primeiro_contato",
  "expected_params": 2,
  "provider_attempted": false,
  "failure_stage": "none"
}
```

Not ready adds a stable `code` — one of `DISPATCH_NOT_CONFIGURED`,
`UNAUTHORIZED`, `INVALID_REQUEST`, `UNKNOWN_TEMPLATE`, `PARAMS_COUNT_MISMATCH`,
`TEMPLATE_NOT_CONFIGURED`, `INVALID_PROVIDER_TEMPLATE_ID`, `UNEXPECTED_ERROR`
— plus `expected_params` once the key resolved (static path only). Branch on
`code`, not on `error`.

**Dynamic path.** Send `provider_template_id` and `requires_consent` instead
of `params_count` to preflight-check the same dynamic campaign-template path
`/api/siteflow/dispatch` accepts (see above) — using the exact same shared
provider-ID validator, so a malformed ID is rejected identically by both
endpoints:

```json
{
  "template": "camp_catalogo_dinamico_v3",
  "provider_template_id": "aYSx9KNRwPC0hnHe",
  "requires_consent": true
}
```

Ready:

```json
{
  "success": true,
  "ready": true,
  "template": "camp_catalogo_dinamico_v3",
  "provider_attempted": false,
  "failure_stage": "none"
}
```

No `expected_params` — a dynamic template has no registered arity to report.
`params_count` is not used on this path. A missing or malformed
`provider_template_id` returns `INVALID_PROVIDER_TEMPLATE_ID`; a missing or
non-boolean `requires_consent` returns `INVALID_REQUEST`. Like the static
path, this never reads a per-template env var and never reaches the
provider — `provider_attempted` is always `false`.

```bash
curl -X POST http://localhost:3000/api/siteflow/preflight \
  -H "Content-Type: application/json" \
  -H "x-siteflow-dispatch-secret: $SITEFLOW_DISPATCH_SECRET" \
  --data '{"template":"camp_primeiro_contato","params_count":2}'
```

> **It never calls the provider**, on any path. The module does not import the
> provider transport, and its handler is built without the Umbler token — so
> every response carries `"provider_attempted": false` by construction. It does
> **not** check consent, param content or the phone number, and `DRY_RUN` does
> not apply: preflight always answers "can a *real* send be made". Full contract
> in `docs/INTEGRATION.md` §20.

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
| `SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID` | Umbler template ID for `siteflow_confirmacao_contato` |
| `SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID` | Umbler template ID for `siteflow_nova_solicitacao_interna` |
| `SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID` | Umbler template ID for `camp_primeiro_contato` (campaign) |
| `SITEFLOW_TEMPLATE_CAMP_REATIVACAO_COMERCIAL_ID` | Umbler template ID for `camp_reativacao_comercial` (campaign) |
| `SITEFLOW_TEMPLATE_CAMP_CONVITE_COMERCIAL_ID` | Umbler template ID for `camp_convite_comercial` (campaign) |
| `SITEFLOW_TEMPLATE_COMPARTILHAR_LINK_CONTEXTUAL_ID` | Umbler template ID for `compartilhar_link_contextual` (campaign) |
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
