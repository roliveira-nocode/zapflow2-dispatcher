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
      "error": null
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
      "error": null
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
  `status`, `message_state`, `provider_message_id`, `chat_id`, and `error`.

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
| `client_brand`       | string  | yes      | Template param `{{2}}`                              |
| `conversation_id`    | string  | yes      | SiteFlow conversation identifier                    |
| `lead_id`            | string  | yes      | SiteFlow lead identifier                            |
| `visitor_first_name` | string  | yes      | Template param `{{1}}`                              |
| `phone`              | string  | yes      | Brazilian number; normalized exactly as in §7       |
| `consent.granted`    | boolean | yes      | Must be exactly `true`, otherwise `403`             |
| `consent.granted_at` | string  | yes      | ISO-8601 timestamp of the consent                   |
| `consent.source`     | string  | yes      | Where consent was collected, e.g. `siteflow-web`    |

### 17.3 Template

Logical name: **`siteflow_continuar_conversa`**.

| Placeholder | Value                |
| ----------- | -------------------- |
| `{{1}}`     | `visitor_first_name` |
| `{{2}}`     | `client_brand`       |

It also carries the static quick-reply button **"Receber resumo"**. Params are
always sent in the order `[visitor_first_name, client_brand]`.

The provider template ID is read from the server-only variable
`SITEFLOW_TEMPLATE_ID`. It is never hardcoded in source, never accepted from the
request, and never returned in a response — only the logical name is echoed back.

### 17.4 Dry-run mode

When the server has `DRY_RUN=1` (or `true`), the endpoint validates the request
in full and then **simulates** the send:

- Umbler is never called and no WhatsApp message is sent;
- `SITEFLOW_TEMPLATE_ID` is not required;
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
  "error": null
}
```

`phone` is returned **masked**, and the full number is never written to the
server logs. As in §11, `accepted` only means the request was accepted — never
that WhatsApp delivered or read the message; `delivery_status` is always
`"pending"`. A provider rejection on a real send returns HTTP `200` with
`"success": false`, `"accepted": false` and a populated `error`.

### 17.6 Error responses

| Status | `error`                                     | Cause                                            |
| ------ | ------------------------------------------- | ------------------------------------------------ |
| `400`  | `"<field> is required."`                    | Missing or empty required field                   |
| `400`  | `"consent.granted must be a boolean."`      | Wrong type for `consent.granted`                  |
| `400`  | `"consent.granted_at must be an ISO-8601 date string."` | Unparseable timestamp              |
| `400`  | `"Invalid phone number."`                   | Phone failed Brazilian normalization              |
| `401`  | `"Unauthorized."`                           | Missing or wrong `x-siteflow-dispatch-secret`     |
| `403`  | `"Consent was not granted."`                | `consent.granted` is not exactly `true`           |
| `503`  | `"SiteFlow dispatch is not configured."`    | `SITEFLOW_DISPATCH_SECRET` unset on the server    |
| `503`  | `"SiteFlow template is not configured."`    | Real send attempted with `SITEFLOW_TEMPLATE_ID` unset |

All errors use the same envelope as §10: `{ "success": false, "error": "..." }`.

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
  "error": null
}
```

`phone` is returned **masked**, and the full number and the message text are
never written to the server logs. As in §11, `accepted` only means Umbler
**accepted/queued** the request — never that WhatsApp delivered or read the
message; `delivery_status` is always `"pending"`. A provider rejection on a
real send returns HTTP `200` with `"success": false`, `"accepted": false` and
a populated `error`.

### 18.5 Error responses

| Status | `error`                                     | Cause                                            |
| ------ | -------------------------------------------- | ------------------------------------------------ |
| `400`  | `"<field> is required."`                     | Missing or empty required field                   |
| `400`  | `"text must be at most 4000 characters."`    | `text` longer than the limit                      |
| `400`  | `"Invalid phone number."`                    | Phone failed Brazilian normalization              |
| `401`  | `"Unauthorized."`                            | Missing or wrong `x-siteflow-dispatch-secret`     |
| `503`  | `"SiteFlow dispatch is not configured."`     | `SITEFLOW_DISPATCH_SECRET` unset on the server    |

All errors use the same envelope as §10: `{ "success": false, "error": "..." }`.

### 18.6 Provider call

Internally this calls Umbler's free-text endpoint (`POST
.../api/v1/messages/simplified/`), sending `toPhone`, `fromPhone`,
`organizationId` and `message` — the same `fromPhone`/`organizationId`
constants and the same Bearer-token mechanism as the template endpoint. As
with `/api/dispatch` and `/api/siteflow/dispatch`, this is a **real send**
outside dry-run — only call it with a real recipient when you actually intend
to message them.
