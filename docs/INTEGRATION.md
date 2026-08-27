# Zapflow Dispatcher API — Integration Guide

This guide is for the developer integrating **Rafael's website** with the
Zapflow dispatcher API. It explains what the API does, how to call it, the exact
payload shape, and the important caveats you must respect.

## 1. Purpose

The Zapflow dispatcher API sends **approved WhatsApp template messages** through
**Umbler Talk** to a list of contacts in a single campaign request.

You POST a campaign (a template plus a list of contacts) and the API forwards one
template message per contact to Umbler. It is a thin, server-to-server dispatch
layer — there is no frontend, database, queue, or chatbot logic behind it.

> **Important:** the API only reports whether Umbler **accepted** each request.
> It does **not** report WhatsApp delivery or read status. See section 11.

## 2. Production base URL

```
https://zapflow2-dispatcher.vercel.app
```

All endpoints below are relative to this base URL.

## 3. Health endpoint

```
GET /health
```

Returns HTTP `200` with:

```json
{ "ok": true }
```

Use this to confirm the service is up. It requires no authentication.

## 4. Dispatch endpoint

```
POST /api/dispatch
```

Sends one approved template message per contact. This is a **real send** — only
call it with real contacts when you actually intend to message them.

## 5. Required headers

| Header              | Value                  |
| ------------------- | ---------------------- |
| `Content-Type`      | `application/json`     |
| `x-dispatch-secret` | `<secret>`             |

`x-dispatch-secret` must match the server's `DISPATCH_SECRET`. A missing or
wrong value returns `401`.

## 6. Security rule — keep the secret server-side

The request **must** be made from the website's **backend**: an API route, a
server action, a server-side function, or another trusted backend service.

**The `DISPATCH_SECRET` must never be exposed in browser JavaScript or any
frontend code.** Anyone who obtains the secret can trigger real WhatsApp sends.
Do not embed it in client bundles, inline scripts, `NEXT_PUBLIC_*` variables, or
anything shipped to the browser. Keep it in a server-only environment variable.

## 7. Payload structure

`POST /api/dispatch` expects a JSON object:

| Field           | Type       | Required | Description                                              |
| --------------- | ---------- | -------- | -------------------------------------------------------- |
| `campaign_id`   | string     | yes      | Your unique identifier for this campaign run.            |
| `campaign_name` | string     | yes      | Human-readable campaign name.                            |
| `template_id`   | string     | yes      | ID of an **approved** template (see section 12).         |
| `contacts`      | array      | yes      | Non-empty list of contact objects (see below).           |

Each object in `contacts`:

| Field        | Type   | Required | Description                                          |
| ------------ | ------ | -------- | ---------------------------------------------------- |
| `contact_id` | string | yes      | Your unique identifier for the contact.              |
| `name`       | string | yes      | Contact name. Used as a template parameter.          |
| `phone`      | string | yes      | Brazilian phone number. Normalized to E.164 form.    |
| `reason`     | string | yes      | Reason / message context. Used as a template param.  |

Notes:

- All fields are required and must be non-empty strings.
- `phone` is normalized to `+<digits>` E.164 form (e.g. `(21) 97190-6175` →
  `+5521971906175`). A contact with an invalid phone is marked failed and
  skipped — Umbler is not called for it.

## 8. Complete example payload

```json
{
  "campaign_id": "site-lead-2026-07-13-0001",
  "campaign_name": "Website leads — July batch",
  "template_id": "aYSx9KNRwPC0hnHe",
  "contacts": [
    {
      "contact_id": "lead-1001",
      "name": "Ana Souza",
      "phone": "+5521999990001",
      "reason": "solicitou um orçamento pelo site"
    },
    {
      "contact_id": "lead-1002",
      "name": "Bruno Lima",
      "phone": "+5521999990002",
      "reason": "pediu mais informações sobre os planos"
    }
  ]
}
```

> The phone numbers and contacts above are fictional examples.

## 9. Successful response

HTTP `200`:

```json
{
  "success": true,
  "campaign_id": "site-lead-2026-07-13-0001",
  "campaign_name": "Website leads — July batch",
  "template_id": "aYSx9KNRwPC0hnHe",
  "template_label": "zapflow_primeiro_contato_v1",
  "total": 2,
  "accepted": 2,
  "failed": 0,
  "delivery_status": "pending",
  "results": [
    {
      "contact_id": "lead-1001",
      "name": "Ana Souza",
      "phone": "+5521999990001",
      "accepted": true,
      "status": 200,
      "message_state": "Processing",
      "provider_message_id": "abc123",
      "chat_id": "chat123",
      "error": null,
      "provider_attempted": true,
      "failure_stage": "none"
    },
    {
      "contact_id": "lead-1002",
      "name": "Bruno Lima",
      "phone": "+5521999990002",
      "accepted": true,
      "status": 200,
      "message_state": "Processing",
      "provider_message_id": "def456",
      "chat_id": "chat456",
      "error": null,
      "provider_attempted": true,
      "failure_stage": "none"
    }
  ]
}
```

Top-level fields:

- `success` — `true` when every contact was accepted (`failed === 0`).
- `total` — number of contacts in the request.
- `accepted` — number of contacts whose request Umbler accepted.
- `failed` — number of contacts that were not accepted.
- `delivery_status` — always `"pending"`. Acceptance is not delivery (section 11).
- `results` — per-contact outcome. Each item includes `accepted`, the provider
  `status`, `message_state`, `provider_message_id`, `chat_id`, `error`, and the
  failure metadata `provider_attempted` / `failure_stage` described in §17.7.
  A contact skipped for an invalid phone carries `"provider_attempted": false`
  — Umbler was never called for it.

Each contact is processed independently — one failure does not stop the rest, so
a response can be a partial success (`success: false`, some `accepted`).

## 10. Error responses

**400 — validation error** (missing/invalid field):

```json
{ "success": false, "error": "contact at index 0 is missing \"phone\"." }
```

Other validation messages include `campaign_id is required.`,
`campaign_name is required.`, `template_id is required.`, and
`contacts must be a non-empty array.`

**401 — unauthorized** (missing or wrong `x-dispatch-secret`):

```json
{ "success": false, "error": "Unauthorized." }
```

**400 — unsupported template** (`template_id` not in the allowlist):

```json
{ "success": false, "error": "Template is not approved for this local dispatcher." }
```

**400 — too many contacts** (more than the configured `MAX_CONTACTS`):

```json
{ "success": false, "error": "Too many contacts: 25 (max 20)." }
```

## 11. "accepted" does not mean delivered

`accepted` means **Umbler accepted the request** (a successful HTTP response,
typically `message_state: "Processing"`). It does **not** mean the WhatsApp
message was **delivered** or **read**.

In real tests, a message can stay pending for a few minutes before reaching the
recipient — and delivery can still fail afterward (e.g. the number has no
WhatsApp). Do not tell your users a message was delivered based on this API.
`delivery_status` is always `"pending"` for this reason.

## 12. Approved templates only

Only templates present in the dispatcher's **approved template allowlist** can be
used. Any other `template_id` returns `400` with
`"Template is not approved for this local dispatcher."`

Currently approved:

| `template_id`      | `template_label`               | Parameters       |
| ------------------ | ------------------------------ | ---------------- |
| `aYSx9KNRwPC0hnHe` | `zapflow_primeiro_contato_v1`  | `name`, `reason` |

The template parameters are filled from each contact's `name` and `reason`. To
add a new template, it must be registered in the dispatcher — coordinate with the
API maintainer before relying on a new one.

## 13. Contact limit (MAX_CONTACTS)

Each request is limited to at most `MAX_CONTACTS` contacts. Exceeding the limit
returns `400` (`"Too many contacts: N (max M)."`).

`MAX_CONTACTS` is configured **externally**, as an environment variable in the
deployment (default `20` if unset). The exact production value is set outside the
code, so do not assume a fixed number — design your batching so it can adapt, and
split large lists into multiple requests (each with its **own** `campaign_id`).

## 14. Duplicate campaign protection is NOT implemented

The API does **not** deduplicate by `campaign_id`. Posting the same
`campaign_id` twice will send the messages **again**.

Therefore, the website must **not** automatically retry the same `campaign_id`.
If a request times out or errors, do not blindly re-POST — you risk double
sends. Confirm the outcome (or design an idempotency layer on your side) before
retrying, and use a fresh `campaign_id` for genuinely new batches.

## 15. Backend integration example (TypeScript + fetch)

Run this from a **server-side** context only (API route / server action /
backend service), never from the browser.

```ts
// server-side only — do not ship DISPATCH_SECRET to the browser
interface DispatchContact {
  contact_id: string;
  name: string;
  phone: string;
  reason: string;
}

interface DispatchResult {
  contact_id: string;
  name: string;
  phone: string;
  accepted: boolean;
  status: number | null;
  message_state: string | null;
  provider_message_id: string | null;
  chat_id: string | null;
  error: string | null;
}

interface DispatchResponse {
  success: boolean;
  campaign_id: string;
  campaign_name: string;
  template_id: string;
  template_label: string;
  total: number;
  accepted: number;
  failed: number;
  delivery_status: "pending";
  results: DispatchResult[];
}

const BASE_URL = "https://zapflow2-dispatcher.vercel.app";

export async function dispatchCampaign(input: {
  campaignId: string;
  campaignName: string;
  templateId: string;
  contacts: DispatchContact[];
}): Promise<DispatchResponse> {
  const secret = process.env.DISPATCH_SECRET;
  if (!secret) {
    throw new Error("DISPATCH_SECRET is not set on the server.");
  }

  const response = await fetch(`${BASE_URL}/api/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-dispatch-secret": secret,
    },
    body: JSON.stringify({
      campaign_id: input.campaignId,
      campaign_name: input.campaignName,
      template_id: input.templateId,
      contacts: input.contacts,
    }),
  });

  const data = (await response.json()) as DispatchResponse | { success: false; error: string };

  if (!response.ok) {
    // 400 / 401 — inspect data.error for the reason. Do NOT auto-retry the
    // same campaign_id (no duplicate protection — see section 14).
    const message = "error" in data ? data.error : `HTTP ${response.status}`;
    throw new Error(`Dispatch failed: ${message}`);
  }

  // "accepted" means Umbler accepted the request — not delivered or read.
  return data as DispatchResponse;
}
```

## 16. Secrets

Never hardcode or commit the real `DISPATCH_SECRET` or the Umbler token. Read the
secret from a server-only environment variable. The Umbler token lives only on
the dispatcher server — the website never needs it.

## 17. SiteFlow endpoint — `POST /api/siteflow/dispatch`

Dedicated **server-to-server** endpoint for the SiteFlow integration. It sends
one template message to one visitor who has explicitly consented, and is
independent of the campaign endpoint in §4: different secret, different payload,
different template. Everything in §1–§16 about `/api/dispatch` still applies to
`/api/dispatch` and is unchanged by this endpoint.

```
POST https://zapflow2-dispatcher.vercel.app/api/siteflow/dispatch
```

### 17.1 Authentication

| Header                        | Value                                     |
| ----------------------------- | ----------------------------------------- |
| `Content-Type`                | `application/json`                        |
| `x-siteflow-dispatch-secret`  | the value of `SITEFLOW_DISPATCH_SECRET`   |

The same rule as §6 applies: the secret is **server-side only**. Call this
endpoint from your backend, never from browser code. A missing or wrong secret
returns `401`; if `SITEFLOW_DISPATCH_SECRET` is not configured on the server the
endpoint returns `503` and nothing else on the server is affected.

### 17.2 Request

Legacy shape — `template` omitted — is unchanged:

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

| Field                | Type    | Required | Notes                                              |
| -------------------- | ------- | -------- | -------------------------------------------------- |
| `client_id`          | string  | yes      | Your client identifier                              |
| `client_brand`       | string  | only when `template` is omitted | Template param `{{2}}` of the legacy default |
| `conversation_id`    | string  | yes      | SiteFlow conversation identifier                    |
| `lead_id`            | string  | yes      | SiteFlow lead identifier                            |
| `visitor_first_name` | string  | yes      | Umbler contact name for every template               |
| `phone`              | string  | yes      | Brazilian number; normalized exactly as in §7 — target of the message, not necessarily the visitor's own number (see `notificacao_interna` below) |
| `consent`            | object  | unless the resolved template's consent rule says otherwise (see §17.3) | |
| `consent.granted`    | boolean | when consent is required | Must be exactly `true`, otherwise `403`             |
| `consent.granted_at` | string  | when consent is required | ISO-8601 timestamp of the consent                   |
| `consent.source`     | string  | when consent is required | Where consent was collected, e.g. `siteflow-web`    |
| `template`           | string  | no       | One of the closed set of logical keys in §17.3, **or** a free-text logical identity on the dynamic path (§17.3.1) |
| `params`             | string[]| only when `template` is present | The template's params, in order. Exact length required on the static path; preserved as-is, no fixed-arity check, on the dynamic path |
| `provider_template_id` | string | no — presence switches the request onto the dynamic path, §17.3.1 | Raw Umbler/Meta provider ID, resolved server-side by SiteFlow |
| `requires_consent`   | boolean | required when `provider_template_id` is present | Explicit consent policy for the dynamic path, §17.3.1 |

### 17.3 Templates

A **closed set** — a caller may only select one of the keys below via
`template`; a raw provider template ID is never accepted from the request.

| `template` key (default marked)  | Logical (Meta/Umbler) name           | Params, in order                     | Consent required | Provider ID env var                          |
| ---------------------------------- | -------------------------------------- | -------------------------------------- | ------------------- | ------------------------------------------------ |
| `continuar_conversa` (**default**) | `siteflow_continuar_conversa`          | `[visitor_first_name, client_brand]`   | yes                  | `SITEFLOW_TEMPLATE_ID`                            |
| `confirmacao_contato`              | `siteflow_confirmacao_contato`         | `[visitor_first_name]`                 | yes                  | `SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID`        |
| `notificacao_interna`              | `siteflow_nova_solicitacao_interna`    | `[visitor_name, visitor_phone]`        | **no**               | `SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID`        |
| `camp_primeiro_contato`            | `camp_primeiro_contato`                | `[first_name, contextual_message]`     | yes                  | `SITEFLOW_TEMPLATE_CAMP_PRIMEIRO_CONTATO_ID`      |
| `camp_reativacao_comercial`        | `camp_reativacao_comercial`            | `[first_name, contextual_reason]`      | yes                  | `SITEFLOW_TEMPLATE_CAMP_REATIVACAO_COMERCIAL_ID`  |
| `camp_convite_comercial`           | `camp_convite_comercial`               | `[first_name, contextual_invitation]`  | yes                  | `SITEFLOW_TEMPLATE_CAMP_CONVITE_COMERCIAL_ID`     |
| `compartilhar_link_contextual`     | `compartilhar_link_contextual`         | `[first_name, contextual_reason, link]`| yes                  | `SITEFLOW_TEMPLATE_COMPARTILHAR_LINK_CONTEXTUAL_ID` |

**The last four are the approved CAMPAIGN templates.** They are registered, not
activated: the dispatcher knows they exist and how many params they take, and
nothing more. Each stays unsendable until its own env var is set, and each
requires explicit granted `consent` exactly like any other visitor-facing
template — `notificacao_interna` remains the one and only consent exception.
Use §20 to check whether one is dispatchable before you rely on it.

`continuar_conversa` carries the static quick-reply button **"Receber
resumo"**; `notificacao_interna` carries the static quick-reply button
**"Ver resumo do contato"**. Neither button changes this payload — both are
part of the template approved on Meta/Umbler, exactly like the confirmed
button behaviour documented for the original template.

**`notificacao_interna` and consent.** This is the one template with
`requiresConsent: false`: it is never sent to the visitor (the caller
resolves its own destination — e.g. a fixed internal number — before
calling this endpoint; the endpoint itself never picks who receives it), so
there is no visitor consent to require. `consent`, if present in the
request, is simply ignored for this template — never inspected, never
synthesized as `true`.

Each template's provider ID is read from **its own** server-only variable
(table above). It is never hardcoded in source, never accepted from the
request, and never returned in a response — only the logical name is echoed
back (`template_name` in the response, §17.5). A template whose env var is
unset is unavailable **on its own** — a `503` naming it — the other two are
unaffected (§17.6).

### 17.3.1 Dynamic campaign-template path

An alternative to the closed registry above, for campaign templates SiteFlow
manages in its own persistent, versioned catalog instead of this
dispatcher's static registry. Sending `provider_template_id` switches a
request onto this path **entirely** — it never performs the static
registry's fixed-arity check and never reads a per-template env var.

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

**Design contract:**

- The browser and any LLM in the loop never see or send a provider template
  ID — only SiteFlow's server does, resolving it itself from its own frozen
  catalog revision before calling this endpoint, over the same authenticated
  server-to-server secret as every other SiteFlow route (§17.1).
- `template` is still required, but is a **safe slug/token** logical/internal
  identity for audit and logging only (echoed back as `template_name`,
  §17.5) — validated with `validateTemplateIdentity`
  (`src/siteflow-template-id.ts`): non-empty, `A-Za-z0-9_-` only, at most 128
  characters. It is interpolated straight into a server log line, so
  newlines, control characters and spaces are rejected outright. It is never
  checked against `SITEFLOW_TEMPLATES` and requires no particular prefix
  (e.g. no `camp_` requirement) — that closed registry, and any naming
  convention on it, belongs to the static path only.
- `provider_template_id` is validated with the **same strict validator** used
  by `POST /api/siteflow/preflight` (`validateProviderTemplateId`,
  `src/siteflow-template-id.ts`) — the identical fixture is rejected by both
  endpoints. It rejects empty, whitespace-only, malformed (characters outside
  `A-Za-z0-9_-`), too short (under 4 characters — matches the CRM precedent
  that informed this architecture), or too long (over 64 characters). A
  valid ID is used **directly** for the provider send — no per-template env
  var is read, and none is required.
- `requires_consent` is required and must be an explicit `true`/`false` —
  derived server-side by SiteFlow from the frozen template's policy, never
  inferred or defaulted here. Missing or non-boolean is rejected with `400`
  before any provider attempt.
- Consent then follows `requires_consent` exactly like the static path
  follows `spec.requiresConsent` (§17.3, §17.2): `true` requires valid
  `consent` evidence and fails closed if it is missing or malformed; `false`
  never requires and never fabricates it — a present `consent` object is
  simply ignored, exactly like `notificacao_interna` above.
- `params` is required to be a **non-empty** array of non-empty strings, and
  is preserved in the **exact order sent**. Unlike the static path, there is
  no registered arity to check it against — any length **≥ 1** is accepted,
  with no fixed upper bound. An empty array (`params: []`) is rejected: the
  approved SiteFlow catalog can never activate a zero-slot template.
- The static visitor templates in §17.3 are completely unaffected — this
  path only activates when `provider_template_id` is present in the request.
- The `SITEFLOW_TEMPLATE_CAMP_*` env vars (§17.3) are **not removed** by this
  path; they remain in effect for any caller still using the static
  `template` keys.

### 17.4 Dry-run mode

When the server has `DRY_RUN=1` (or `true`), the endpoint validates the request
in full and then **simulates** the send:

- Umbler is never called and no WhatsApp message is sent;
- no per-template provider ID env var is required, for any of the three templates in §17.3;
- the template does not need to be approved;
- the response contains `"dry_run": true` and `"message_state": "simulated"`.

`DRY_RUN` applies to this endpoint only — `POST /api/dispatch` ignores it and
always behaves as documented in §4.

### 17.5 Successful response

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

`phone` is returned **masked**, and the full number is never written to the
server logs. As in §11, `accepted` only means the request was accepted — never
that WhatsApp delivered or read the message; `delivery_status` is always
`"pending"`. A provider rejection on a real send returns HTTP `200` with
`"success": false`, `"accepted": false` and a populated `error`.

`provider_attempted` and `failure_stage` are present on **every** response of
this endpoint, successes included — see §17.7. Above they are `false` / `none`
because the example is a dry run: nothing was sent. A real successful send
returns `"provider_attempted": true`.

### 17.6 Error responses

| Status | `error`                                     | `provider_attempted` | `failure_stage`        | Cause                                            |
| ------ | ------------------------------------------- | -------------------- | ---------------------- | ------------------------------------------------ |
| `400`  | `"<field> is required."`                    | `false`              | `request_validation`   | Missing or empty required field                   |
| `400`  | `"consent.granted must be a boolean."`      | `false`              | `request_validation`   | Wrong type for `consent.granted`                  |
| `400`  | `"consent.granted_at must be an ISO-8601 date string."` | `false`  | `request_validation`   | Unparseable timestamp              |
| `400`  | `"template is not one of the known SiteFlow templates."` | `false` | `request_validation`   | `template` is not a key in §17.3    |
| `400`  | `"params is required and must be a non-empty array of non-empty strings."` | `false` | `request_validation` | `template` present but `params` missing/malformed |
| `400`  | `"params must have exactly N value(s) for template \"...\"."` | `false` | `request_validation` | `params.length` does not match that template |
| `400`  | `"Invalid phone number."`                   | `false`              | `request_validation`   | Phone failed Brazilian normalization              |
| `401`  | `"Unauthorized."`                           | `false`              | `request_validation`   | Missing or wrong `x-siteflow-dispatch-secret`     |
| `403`  | `"Consent was not granted."`                | `false`              | `request_validation`   | `consent.granted` is not exactly `true` — never for `notificacao_interna` |
| `503`  | `"SiteFlow dispatch is not configured."`    | `false`              | `configuration`        | `SITEFLOW_DISPATCH_SECRET` unset on the server    |
| `503`  | `"SiteFlow template \"<logical name>\" is not configured."` | `false` | `configuration`        | Real send attempted with that template's env var unset — only that template is affected |
| `500`  | `"Unexpected dispatcher error."`            | `false` **or** `true` | `pre_provider_error` **or** `provider_indeterminate` | An unexpected dispatcher exception. The metadata is the only thing that tells you which side of the provider call it happened on — read §17.7 before deciding anything |

**Dynamic path only** (§17.3.1), in addition to the rows above:

| Status | `error`                                        | `provider_attempted` | `failure_stage`      | Cause                                          |
| ------ | ----------------------------------------------- | --------------------- | ----------------------- | ------------------------------------------------ |
| `400`  | `"template is required."`                        | `false`                | `request_validation`    | `template` missing, empty or whitespace-only     |
| `400`  | `"template has an invalid format."`              | `false`                | `request_validation`    | Contains characters outside `[A-Za-z0-9_-]` — includes newlines, control characters and spaces |
| `400`  | `"template must be at most 128 characters."`     | `false`                | `request_validation`    | Longer than the shared identity validator's limit |
| `400`  | `"requires_consent must be a boolean."`          | `false`                | `request_validation`    | Missing, or not literally `true`/`false`         |
| `400`  | `"provider_template_id is required."`            | `false`                | `request_validation`    | `provider_template_id` missing, empty or whitespace-only |
| `400`  | `"provider_template_id must be at least 4 characters."` | `false`         | `request_validation`    | Shorter than the shared validator's minimum      |
| `400`  | `"provider_template_id must be at most 64 characters."` | `false`         | `request_validation`    | Longer than the shared validator's maximum       |
| `400`  | `"provider_template_id has an invalid format."`  | `false`                | `request_validation`    | Contains characters outside `[A-Za-z0-9_-]`     |
| `400`  | `"params must be a non-empty array of non-empty strings."` | `false`      | `request_validation`    | `params` missing, not an array, empty (`[]`), or containing an empty/non-string entry |

Note: on the dynamic path, `provider_template_id` is **never** a per-template
configuration issue — there is no env var for it — so it can only ever fail
with `400`/`request_validation`, never `503`/`configuration`.

All errors use the same envelope as §10: `{ "success": false, "error": "..." }`.

### 17.7 Failure metadata — `provider_attempted` and `failure_stage`

Every response of `/api/siteflow/dispatch` and `/api/siteflow/message` carries
two extra fields, on successes as well as failures. They exist to answer one
question: **was the WhatsApp provider actually called?**

#### The rule

> Only a literal `"provider_attempted": false` proves that no provider request
> was initiated.

`true`, `null`, an unexpected value, or the field being **absent** (an older
dispatcher deployment) must all be read as *the provider may have been called*.
Fail closed: when in doubt, assume the message may already be on its way.

The inference below is **wrong** and must never be made:

```
the dispatcher returned an error   =>   the provider was not called
```

A request timeout, a connection reset after the request started, a provider
`5xx`, a malformed or HTML response body, and any exception raised once the
provider call is under way all leave the delivery outcome unprovable. Each is
reported as attempted. In particular, `"accepted": false` on its own says
nothing about whether Umbler was reached.

#### `failure_stage`

| Value                    | `provider_attempted` | Meaning                                                                 |
| ------------------------ | -------------------- | ----------------------------------------------------------------------- |
| `none`                   | `true` or `false`    | No failure. `false` only for a dry run — see §17.4                       |
| `request_validation`     | `false`              | Rejected before the provider: secret header, payload, template, params, consent, phone. Caller-fixable |
| `configuration`          | `false`              | Rejected before the provider: a required server-side env var is unset. Operator-fixable |
| `pre_provider_error`     | `false`              | An unexpected dispatcher exception that provably happened before the provider call |
| `provider_rejected`      | `true`               | The provider responded with a definite non-acceptance (HTTP `400`–`499`) |
| `provider_indeterminate` | `true`               | The provider was called and the outcome cannot be proven: HTTP `5xx`, timeout, connection reset, or an exception after the call started |

`status` still carries the exact provider HTTP code, so `failure_stage` does
not restate it.

#### Full mapping

| Situation                                        | `provider_attempted` | `failure_stage`          | HTTP  |
| ------------------------------------------------ | -------------------- | ------------------------ | ----- |
| Request validation failure                        | `false`              | `request_validation`     | `400` |
| Missing or wrong secret header                    | `false`              | `request_validation`     | `401` |
| Consent not granted                               | `false`              | `request_validation`     | `403` |
| `SITEFLOW_DISPATCH_SECRET` unset                  | `false`              | `configuration`          | `503` |
| That template's provider-ID env var unset         | `false`              | `configuration`          | `503` |
| Dry run (§17.4)                                   | `false`              | `none`                   | `200` |
| Provider accepted the request                     | `true`               | `none`                   | `200` |
| Provider rejection / HTTP `4xx`                   | `true`               | `provider_rejected`      | `200` |
| Provider HTTP `5xx`                               | `true`               | `provider_indeterminate` | `200` |
| Timeout / `AbortError`                            | `true`               | `provider_indeterminate` | `200` |
| Connection reset / network error                  | `true`               | `provider_indeterminate` | `200` |
| Malformed or HTML body on a non-2xx               | `true`               | per the status above     | `200` |
| Malformed or HTML body on a `2xx`                 | `true`               | `none`                   | `200` |
| Unexpected exception **before** the provider call | `false`              | `pre_provider_error`     | `500` |
| Unexpected exception **after** the provider call  | `true`               | `provider_indeterminate` | `500` |

A `2xx` whose body could not be parsed is still reported as accepted, exactly
as before this contract existed. Nothing new is claimed about it —
`delivery_status` remains `"pending"` (§11) and `provider_attempted` is `true`.

#### Dry run

A dry run reports `"provider_attempted": false` because nothing was sent —
that value is correct and safe. Always combine it with `dry_run`: a dry-run
success is not a real send.

#### The `500` envelope

An unexpected dispatcher exception now returns a JSON body rather than an HTML
error page:

```json
{
  "success": false,
  "error": "Unexpected dispatcher error.",
  "provider_attempted": true,
  "failure_stage": "provider_indeterminate"
}
```

`error` is always that fixed string — never the raw exception message, the
Umbler token, a provider template ID, or the phone number. The status code is
unchanged (an unhandled exception already produced a `500`).

#### No retries

The dispatcher has no retry mechanism and never re-sends: exactly one provider
request per call, whatever the outcome. It does not deduplicate either — see
§14. This metadata is diagnostic; it does not authorize a retry. Treat every
outcome that is not an explicit `"provider_attempted": false` as potentially
delivered.

## 18. SiteFlow free-text endpoint — `POST /api/siteflow/message`

Dedicated **server-to-server** endpoint that sends ONE free-text WhatsApp
message (not a template) to a single visitor. Used only for the "Receber
resumo" reply, **after** that visitor already received the approved template
via `/api/siteflow/dispatch` (§17). Shares that endpoint's secret and dry-run
behaviour; the payload and the provider call are otherwise independent, and
`/api/siteflow/dispatch` and `/api/dispatch` are unaffected by this endpoint.

```
POST https://zapflow2-dispatcher.vercel.app/api/siteflow/message
```

### 18.1 Authentication

Same header and same secret as §17.1 — `x-siteflow-dispatch-secret` must
match `SITEFLOW_DISPATCH_SECRET`. Missing/wrong secret returns `401`; an
unconfigured server returns `503`.

### 18.2 Request

```json
{
  "client_id": "client-example",
  "conversation_id": "conversation-example",
  "lead_id": "lead-example",
  "to_phone": "+5511900000000",
  "text": "Resumo da sua conversa..."
}
```

| Field             | Type   | Required | Notes                                              |
| ----------------- | ------ | -------- | --------------------------------------------------- |
| `client_id`       | string | yes      | Your client identifier                               |
| `conversation_id` | string | yes      | SiteFlow conversation identifier                     |
| `lead_id`         | string | yes      | SiteFlow lead identifier                             |
| `to_phone`        | string | yes      | Brazilian number; normalized exactly as in §7        |
| `text`            | string | yes      | Free-text message body, max 4000 characters          |

### 18.3 Dry-run mode

Same rule as §17.4: with `DRY_RUN=1` (or `true`) the endpoint validates the
request in full and then simulates the send — Umbler is never called, and the
response contains `"dry_run": true` and `"message_state": "simulated"`.

### 18.4 Successful response

```json
{
  "success": true,
  "dry_run": true,
  "client_id": "client-example",
  "conversation_id": "conversation-example",
  "lead_id": "lead-example",
  "phone": "+5511*******00",
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

`phone` is returned **masked**, and the full number and the message text are
never written to the server logs. As in §11, `accepted` only means Umbler
**accepted/queued** the request — never that WhatsApp delivered or read the
message; `delivery_status` is always `"pending"`. A provider rejection on a
real send returns HTTP `200` with `"success": false`, `"accepted": false` and
a populated `error`.

`provider_attempted` and `failure_stage` follow exactly the same contract as
the template endpoint — see §17.7. They are present on every response of this
endpoint too.

### 18.5 Error responses

| Status | `error`                                     | Cause                                            |
| ------ | -------------------------------------------- | ------------------------------------------------ |
| `400`  | `"<field> is required."`                     | Missing or empty required field                   |
| `400`  | `"text must be at most 4000 characters."`    | `text` longer than the limit                      |
| `400`  | `"Invalid phone number."`                    | Phone failed Brazilian normalization              |
| `401`  | `"Unauthorized."`                            | Missing or wrong `x-siteflow-dispatch-secret`     |
| `503`  | `"SiteFlow dispatch is not configured."`     | `SITEFLOW_DISPATCH_SECRET` unset on the server    |
| `500`  | `"Unexpected dispatcher error."`             | An unexpected dispatcher exception — read `provider_attempted` before assuming nothing was sent (§17.7) |

Every response of this endpoint also carries `provider_attempted` and
`failure_stage`: `false` / `request_validation` for the `400`s and the `401`,
`false` / `configuration` for the `503`, and `true` plus a `provider_*` stage
for anything that reached Umbler. See §17.7.

All errors use the same envelope as §10: `{ "success": false, "error": "..." }`.

### 18.6 Provider call

Internally this calls Umbler's free-text endpoint (`POST
.../api/v1/messages/simplified/`), sending `toPhone`, `fromPhone`,
`organizationId` and `message` — the same `fromPhone`/`organizationId`
constants and the same Bearer-token mechanism as the template endpoint. As
with `/api/dispatch` and `/api/siteflow/dispatch`, this is a **real send**
outside dry-run — only call it with a real recipient when you actually intend
to message them.

## 19. SiteFlow media-readiness endpoint — `POST /api/siteflow/media`

Dedicated **read-only** server-to-server endpoint that reports whether one
exact inbound message's media (e.g. a WhatsApp audio) is ready for download
yet. Built for inbound audio transcription: Umbler's webhook fires while the
media is still processing (`File.Url` is `null`); this endpoint lets SiteFlow
poll the same exact message afterwards. It never sends a message, never
downloads the media bytes, and has no side effects — safe to call repeatedly
for the same `messageId`. Independent of every other endpoint in this guide:
own logic, no provider send call.

```
POST https://zapflow2-dispatcher.vercel.app/api/siteflow/media
```

### 19.1 Authentication

Same header and same secret as §17.1/§18.1 — `x-siteflow-dispatch-secret`
must match `SITEFLOW_DISPATCH_SECRET`. Missing/wrong secret returns `401`; an
unconfigured server returns `503`. `DRY_RUN` does not apply here — there is
no provider send to simulate.

### 19.2 Request

```json
{ "messageId": "an4ZQL9PiM6AvyyT" }
```

| Field       | Type   | Required | Notes                                                          |
| ----------- | ------ | -------- | ---------------------------------------------------------------|
| `messageId` | string | yes      | Exact Umbler provider message ID. The only accepted lookup key — never a phone number, contact name, or "most recent chat". |

The dispatcher always queries its own already-configured Umbler organization
(`ORGANIZATION_ID` in `src/umbler.ts`); the caller cannot pass a different one.

### 19.3 Readiness signal

`MessageState` (e.g. `"Processing"`) is **not** used to decide readiness —
measured against real production traffic, it can stay `"Processing"` long
after `File.Url` is already populated with a working link. The only signal
this endpoint uses is `File.Url !== null`.

### 19.4 Response — media not yet ready

HTTP `200`:

```json
{ "success": true, "state": "processing" }
```

### 19.5 Response — media ready

HTTP `200`:

```json
{
  "success": true,
  "state": "ready",
  "media": {
    "url": "https://utalk-wamedia.s3.amazonaws.com/...mp3",
    "contentType": "audio/mpeg",
    "sizeBytes": 171198
  }
}
```

No other Umbler message/contact/chat field is ever included. The response is
sent with `Cache-Control: no-store` and is never logged or persisted by the
dispatcher — `media.url` is a live, directly downloadable link (no
`Authorization` header needed to fetch it). Its expiration/lifetime has not
been measured or documented anywhere, so make no assumption about it. Treat
`media.url` as sensitive, transient media-location data: consume it
immediately and do not log or persist it.

### 19.6 Error responses

| Status | `error`                                       | Cause                                                     |
| ------ | ---------------------------------------------- | ---------------------------------------------------------- |
| `400`  | `"messageId is required."`                     | Missing/empty `messageId`                                  |
| `400`  | `"messageId must be at most 128 characters."`  | `messageId` too long                                        |
| `400`  | `"messageId has an invalid format."`           | `messageId` contains characters outside `[A-Za-z0-9_-]`     |
| `401`  | `"Unauthorized."`                              | Missing or wrong `x-siteflow-dispatch-secret`               |
| `503`  | `"SiteFlow dispatch is not configured."`       | `SITEFLOW_DISPATCH_SECRET` unset on the server              |
| `502`  | `"Message not found."`                         | Umbler returned 404 for this `messageId`                    |
| `502`  | `"Umbler request timed out."`                  | Umbler did not respond within the bounded timeout           |
| `502`  | `"Umbler media lookup failed."`                | Umbler returned any other non-2xx status                    |
| `502`  | `"Umbler request failed."`                     | A network/runtime error occurred while calling Umbler       |
| `502`  | `"Umbler returned a malformed response."`      | Umbler's response body was not parseable JSON               |
| `502`  | `"Provider returned a non-HTTPS media URL."`   | Fail-closed: `File.Url` was not `https://`                  |
| `502`  | `"Provider returned a malformed media URL."`   | Fail-closed: `File.Url` was not a parseable URL             |

All errors use the same envelope as §10: `{ "success": false, "error": "..." }`.
Every `502` message above is a small fixed string, never provider
response-body text, a raw exception message, the lookup URL, or the Umbler
token — a `502` here always means the failure was on the Umbler side of this
read-only lookup, sanitized before it ever reaches the caller.

## 20. SiteFlow preflight endpoint — `POST /api/siteflow/preflight`

Answers one question, and **sends nothing**:

> Given this logical template key and this many params, is the dispatcher
> configured to send it?

Built for campaign preparation: you need to know a template is dispatchable
*before* a run starts, and the only other way to find out is to attempt a real
send. This endpoint closes that gap without ever reaching the provider. It has
no side effects — calling it a hundred times is identical to calling it once.

```
POST https://zapflow2-dispatcher.vercel.app/api/siteflow/preflight
```

### 20.1 Authentication

Same header and same secret as §17.1/§18.1/§19.1 — `x-siteflow-dispatch-secret`
must match `SITEFLOW_DISPATCH_SECRET`. Missing or wrong returns `401`; an
unconfigured server returns `503`.

### 20.2 Request

```json
{ "template": "camp_primeiro_contato", "params_count": 2 }
```

| Field          | Type   | Required | Notes                                                             |
| -------------- | ------ | -------- | ----------------------------------------------------------------- |
| `template`     | string | yes      | A logical key from §17.3 (static path), or a free-text logical/internal identity (dynamic path, §20.2.1). A raw provider template ID is never accepted here either way |
| `params_count` | number | yes on the static path | A non-negative integer: how many params you intend to send. Not used on the dynamic path — see §20.2.1 |
| `provider_template_id` | string | no — presence switches to the dynamic path | Same field, same shared validator as §17.3.1 |
| `requires_consent` | boolean | required when `provider_template_id` is present | Same field as §17.3.1 |

The **count only** — preflight deliberately does not accept the params
themselves. It has no use for names, personalized copy or links, and accepting
them would suggest it validated their content. It did not.

### 20.2.1 Dynamic campaign-template path

Mirrors §17.3.1: sending `provider_template_id` (and the required
`requires_consent`) switches the request onto the dynamic path, using the
exact same shared provider-ID validator (`validateProviderTemplateId`) AND
the exact same shared template-identity validator
(`validateTemplateIdentity`) as `/api/siteflow/dispatch` — the identical set
of malformed fixtures is rejected by both endpoints, for both fields.

```json
{
  "template": "camp_catalogo_dinamico_v3",
  "provider_template_id": "aYSx9KNRwPC0hnHe",
  "requires_consent": true
}
```

`params_count` is not read on this path — a dynamic template has no
registered arity to compare it against, so there is nothing to check it
against and nothing to report back either (no `expected_params` in the ready
response, §20.5). There is also no per-template env var to check: once the
shape validates, the request is ready.

### 20.3 What it checks, in order

Static path (§17.3):

1. `SITEFLOW_DISPATCH_SECRET` is configured;
2. the request is authenticated;
3. the body shape is valid;
4. `template` is a key of the closed registry in §17.3;
5. `params_count` matches that template's registered arity;
6. that template's provider-ID env var is set.

Dynamic path (§20.2.1) — steps 1-3 are identical, then:

4. `template` (the logical/internal identity) is present and non-empty;
5. `requires_consent` is present and strictly boolean;
6. `provider_template_id` passes the shared strict validator (§17.3.1).

No env var to check — the dynamic path has nothing left to configure
server-side once the shape above validates.

### 20.4 What it does NOT check

Recipient **consent** (that belongs to SiteFlow — see §17.3 and the consent
rules in §17.2), the **content** of your params, the phone number, or any
campaign state. A `ready: true` means "the dispatcher is configured to send
this template with this many params" and nothing more.

On the dynamic path, `ready: true` also does **not** mean the provider
recognizes `provider_template_id` — only that it is well-formed. Preflight
never calls Umbler/Meta to confirm the ID is real; it cannot, by design
(§20.7). A well-formed but non-existent provider ID still reports `ready:
true` here and only fails at the real send.

### 20.5 Response — ready

HTTP `200`:

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

Dynamic path (§20.2.1) — no `expected_params`, since there is no registered
arity to report:

```json
{
  "success": true,
  "ready": true,
  "template": "camp_catalogo_dinamico_v3",
  "provider_attempted": false,
  "failure_stage": "none"
}
```

### 20.6 Response — not ready

```json
{
  "success": false,
  "ready": false,
  "code": "PARAMS_COUNT_MISMATCH",
  "error": "params must have exactly 2 value(s) for template \"camp_primeiro_contato\".",
  "template": "camp_primeiro_contato",
  "expected_params": 2,
  "provider_attempted": false,
  "failure_stage": "request_validation"
}
```

`template` echoes the logical key you sent; `expected_params` is the registry's
authoritative arity, so a mismatch tells you the right number. Both appear only
once the key has resolved. `success` and `ready` are always equal — `success`
keeps the envelope of §10, `ready` is the answer to act on.

| `code` | Status | `error` | `failure_stage` |
| ------ | ------ | ------- | --------------- |
| `DISPATCH_NOT_CONFIGURED` | `503` | `"SiteFlow dispatch is not configured."` | `configuration` |
| `UNAUTHORIZED` | `401` | `"Unauthorized."` | `request_validation` |
| `INVALID_REQUEST` | `400` | `"Body must be a JSON object."` / `"template is required."` / `"params_count must be a non-negative integer."` | `request_validation` |
| `UNKNOWN_TEMPLATE` | `400` | `"template is not one of the known SiteFlow templates."` | `request_validation` |
| `PARAMS_COUNT_MISMATCH` | `400` | `"params must have exactly N value(s) for template \"...\"."` | `request_validation` |
| `TEMPLATE_NOT_CONFIGURED` | `503` | `"SiteFlow template \"<logical name>\" is not configured."` | `configuration` |
| `INVALID_PROVIDER_TEMPLATE_ID` | `400` | Dynamic path only — see §17.3.1's provider-ID error messages | `request_validation` |
| `UNEXPECTED_ERROR` | `500` | `"Unexpected dispatcher error."` | `pre_provider_error` |

`code` is stable and machine-readable — branch on it, not on `error`. It is
present on failures only. On the dynamic path, `INVALID_REQUEST` also covers:
a missing/malformed `template` identity (`"template is required."` /
`"template has an invalid format."` / `"template must be at most 128
characters."` — the same safe slug/token rule as §17.3.1, rejecting
newlines, control characters and spaces) and a missing/non-boolean
`requires_consent` (`"requires_consent must be a boolean."`).
`INVALID_PROVIDER_TEMPLATE_ID` covers `provider_template_id` specifically:
`"provider_template_id is required."`, `"...must be at least 4
characters."`, `"...must be at most 64 characters."`, or `"...has an
invalid format."` — see §17.3.1.

### 20.7 Zero-send guarantee

Preflight never calls the provider, on any path, success or failure. Three
independent layers hold that up:

- the module does not import the provider transport at all, so it has nothing
  to call;
- its handler is built **without** the Umbler API token — unlike every other
  SiteFlow route it is never handed one, so it could not authenticate to the
  provider even if it tried;
- its Slice 4 metadata is only ever constructed from the "not attempted"
  constants.

Consequently **every** preflight response carries `"provider_attempted": false`,
and `failure_stage` is never `provider_rejected` or `provider_indeterminate`.
Per §17.7 that is the one value which proves no provider request was
initiated — for this endpoint it is guaranteed rather than merely observed.

### 20.8 `DRY_RUN` does not apply

Unlike §17.4, `DRY_RUN` is deliberately **ignored** here. The dispatch route
lets `DRY_RUN` skip the provider-ID check; preflight must not, or it would
report `ready: true` for a template that cannot actually be sent. Preflight
always answers "can a **real** send be made".

### 20.9 Secrets

No response ever contains a provider template ID, the Umbler token, the
dispatch secret, or any environment value. Only the logical key and the
expected param count ever come back.
