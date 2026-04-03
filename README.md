# Personal Automation + MCP Server

A headless, single-owner Gumroad automation service with an MCP-compatible endpoint at `/mcp`.

This keeps the original automation backend role intact:

- webhook ingestion
- product and sales sync jobs
- license verification
- daily summaries
- simple admin endpoints protected by an admin token
- file-backed persistence

And adds a thin MCP layer so ChatGPT or any MCP client can talk to the service directly.

## Current capabilities

This version provides:

- `GET/POST/DELETE /mcp`
- MCP tools for reading summaries, products, sales, jobs, events, and state
- MCP tools for triggering sync jobs and license verification
- optional static bearer protection for the MCP endpoint with `MCP_BEARER_TOKEN`
- queued Gumroad Ping ingestion with stable deduplication
- background webhook processing with event status tracking (`pending`, `processed`, `failed`)
- normalized Gumroad Ping sale storage (`/admin/events/gumroad-sales`)

## Endpoints

### Core HTTP

- `GET /`
- `GET /healthz`
- `POST /webhooks/gumroad/ping`
- `GET/POST/DELETE /mcp`

### Admin API

All `/admin/*` routes require either:

- `Authorization: Bearer <ADMIN_TOKEN>`
- or `x-admin-token: <ADMIN_TOKEN>`

Routes:

- `GET /admin/state`
- `GET /admin/profile`
- `GET /admin/products`
- `GET /admin/sales?limit=50&after=2026-04-01T00:00:00Z`
- `GET /admin/summary?days=7`
- `GET /admin/events?limit=50`
- `GET /admin/events/gumroad-sales?limit=50`
- `GET /admin/jobs?limit=20`
- `GET /admin/licenses?limit=20`
- `POST /admin/jobs/sync-products`
- `POST /admin/jobs/sync-sales`
- `POST /admin/jobs/daily-summary`
- `POST /admin/jobs/process-webhooks`
- `POST /admin/licenses/verify`
- `POST /admin/writes/preview`
- `POST /admin/writes/confirm`
- `POST /admin/checkout-links/generate`
- `GET /admin/write-actions?limit=50`
- `GET /admin/products/:productId/variants` *(canonical read endpoint)*
- `GET /admin/products/:productId/offer-codes` *(canonical read endpoint)*
- `GET /admin/products/variants?productId=<id>` *(deprecated alias; responds with `Deprecation: true` and `Sunset: Wed, 31 Dec 2026 23:59:59 GMT`)*
- `GET /admin/products/offer-codes?productId=<id>` *(deprecated alias; responds with `Deprecation: true` and `Sunset: Wed, 31 Dec 2026 23:59:59 GMT`)*
- `POST /admin/products/preview_enable`
- `POST /admin/products/preview_disable`
- `POST /admin/products/:productId/variants/refresh`
- `POST /admin/products/:productId/offer-codes/refresh`
- `POST /admin/custom-fields/preview_create`
- `POST /admin/custom-fields/preview_edit`
- `POST /admin/custom-fields/preview_delete`
- `POST /admin/variants/categories/preview_create`
- `POST /admin/variants/categories/preview_edit`
- `POST /admin/variants/categories/preview_delete`
- `POST /admin/variants/preview_create`
- `POST /admin/variants/preview_edit`
- `POST /admin/variants/preview_delete`
- `POST /admin/offer-codes/preview_create`
- `POST /admin/offer-codes/preview_delete`
- `POST /admin/offer-codes/preview_disable`

## MCP tools

The shim exposes these tools:

- `get_health`
- `get_state`
- `get_profile`
- `list_products`
- `list_sales`
- `get_summary`
- `list_events`
- `list_jobs`
- `run_sync_products`
- `run_sync_sales`
- `run_daily_summary`
- `verify_license`
- Product creation is UI-first: create base products in Gumroad UI, then use admin write previews + confirm for API-manageable features (status, variants, offer codes, custom fields).

## Install

```bash
npm install
cp .env.example .env
```

Fill in at least:

```env
ADMIN_TOKEN=change-me
GUMROAD_ACCESS_TOKEN=replace-with-your-personal-gumroad-access-token
```

Optional but recommended if you will expose `/mcp` through ngrok or another public tunnel:

```env
MCP_BEARER_TOKEN=set-a-separate-token-for-your-mcp-client
```

Then build and run:

```bash
npm run build
npm run dev
```

### Optional environment variables

```env
GUMROAD_WEBHOOK_SECRET=...
GUMROAD_WEBHOOK_VERIFICATION_MODE=auto   # auto | header-hmac | body-secret
PROCESS_WEBHOOK_EVENTS_INTERVAL_MS=30000
ENABLE_INTERVAL_JOBS=true
```

If interval jobs are disabled, you can run webhook processing manually with:

```bash
npm run job:process-webhooks
```

## ChatGPT / MCP connection

Your MCP endpoint is:

```text
http://localhost:80/mcp
```

If you use ngrok:

```bash
ngrok http 80
```

Then the public MCP endpoint becomes:

```text
https://YOUR-NGROK-URL.ngrok-free.app/mcp
```

### MCP auth behavior

- if `MCP_BEARER_TOKEN` is blank, `/mcp` is open
- if `MCP_BEARER_TOKEN` is set, `/mcp` requires:

```text
Authorization: Bearer <MCP_BEARER_TOKEN>
```

This is intentionally simple. It is a **minimal shim**, not a full OAuth app.

## Webhook notes

Webhook verification is pluggable because Gumroad setups vary. Configure `GUMROAD_WEBHOOK_VERIFICATION_MODE` as `auto` (default), `header-hmac`, or `body-secret`.

The handler supports:

- HMAC verification from `x-gumroad-signature` when present
- fallback shared-secret matching from body fields like `secret`, `token`, `ping_secret`, or `password`

Webhook ingestion stores events first and processes them asynchronously in the background processor (`process-webhooks`) so failures are visible and retryable. Events are marked `pending`, `processed`, or `failed` with timestamps/attempt counters.

Normalized Gumroad Ping sale records are persisted and include fields such as `sale_id`, `sale_timestamp`, `order_number`, `seller_id`, `product_id`, `product_name`, `email`, `price`, `recurrence`, `variants`, `license_key`, `quantity`, and `refunded`.

If your Gumroad Ping setup uses a different verification convention, adjust `verifyWebhookRequest()` in `src/utils/http.ts`.

### Webhook test examples

Valid payload:

```bash
curl -X POST http://localhost:80/webhooks/gumroad/ping \
  -H "Content-Type: application/json" \
  -d @docs/fixtures/gumroad-webhook-sale.json
```

Malformed payload (should return `400` and record a failed event):

```bash
curl -X POST http://localhost:80/webhooks/gumroad/ping \
  -H "Content-Type: application/json" \
  --data-binary @docs/fixtures/gumroad-webhook-malformed.txt
```

Process queued events:

```bash
curl -X POST http://localhost:80/admin/jobs/process-webhooks \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"batchSize":25}'
```

Inspect normalized Gumroad Ping sales:

```bash
curl http://localhost:80/admin/events/gumroad-sales?limit=50 \
  -H "Authorization: Bearer change-me"
```

## Example admin calls

### Sync products

```bash
curl -X POST http://localhost:80/admin/jobs/sync-products \
  -H "Authorization: Bearer change-me"
```

### Sync recent sales

```bash
curl -X POST http://localhost:80/admin/jobs/sync-sales \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"after":"2026-04-01T00:00:00Z","limit":100}'
```

### Verify a license

```bash
curl -X POST http://localhost:80/admin/licenses/verify \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"productId":"abc123","licenseKey":"XXXX-XXXX-XXXX"}'
```

### Generate checkout links (promotion + fulfillment)

Create direct checkout URLs with prefilled purchase options:

```bash
curl -X POST http://localhost:80/admin/checkout-links/generate \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "abc123",
    "options": {
      "wanted": true,
      "email": "buyer@example.com",
      "price": 1999,
      "quantity": 2,
      "variant": "tier_pro",
      "frequency": "yearly",
      "referrer": "spring_campaign",
      "discountCode": "SPRING20"
    }
  }'
```

You can also pass `product` directly when the product is not in cache, or pass only `productUrl`:

```json
{
  "product": {
    "id": "abc123",
    "name": "My Membership",
    "permalink": "https://gumroad.com/l/my-membership"
  },
  "options": {
    "frequency": "monthly",
    "variant": "starter"
  }
}
```

```json
{
  "productUrl": "https://gumroad.com/l/my-membership",
  "options": {
    "discountCode": "SPRING20"
  }
}
```

The API response includes both machine-readable data and a copy-paste ready URL string:

```json
{
  "ok": true,
  "checkout": {
    "baseUrl": "https://gumroad.com",
    "path": "/l/my-membership/SPRING20",
    "query": {
      "wanted": "true",
      "email": "buyer@example.com",
      "price": "1999",
      "quantity": "2",
      "variant": "tier_pro",
      "frequency": "yearly",
      "referrer": "spring_campaign"
    },
    "url": "https://gumroad.com/l/my-membership/SPRING20?wanted=true&email=buyer%40example.com&price=1999&quantity=2&variant=tier_pro&frequency=yearly&referrer=spring_campaign",
    "copyPaste": "https://gumroad.com/l/my-membership/SPRING20?wanted=true&email=buyer%40example.com&price=1999&quantity=2&variant=tier_pro&frequency=yearly&referrer=spring_campaign"
  },
  "output": {
    "text": "https://gumroad.com/l/my-membership/SPRING20?wanted=true&email=buyer%40example.com&price=1999&quantity=2&variant=tier_pro&frequency=yearly&referrer=spring_campaign"
  }
}
```

Sample URL patterns supported by `buildCheckoutUrl(product, options)`:

- direct checkout: `https://gumroad.com/l/my-product`
- with membership frequency: `https://gumroad.com/l/my-membership?frequency=monthly`
- with specific variant/tier: `https://gumroad.com/l/my-product?variant=tier_pro`
- with discount path + wanted mode: `https://gumroad.com/l/my-product/SPRING20?wanted=true`

### Preview catalog action (required phase 1)

```bash
curl -X POST http://localhost:80/admin/writes/preview \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "action_type":"variant_category_create",
    "product_id":"abc123",
    "name":"Size"
  }'
```

Example response:

```json
{
  "ok": true,
  "action_type": "variant_category_create",
  "confirmation_id": "confirm_write_xxx",
  "payload_hash": "1f...",
  "expires_at": "2026-04-03T12:00:00.000Z",
  "status": "pending",
  "requires_confirmation_phrase": false,
  "preview": "Create variant category \"Size\" for product abc123.",
  "api_request": {
    "method": "POST",
    "path": "/v2/products/abc123/variant_categories",
    "payload": {
      "name": "Size"
    }
  }
}
```

### UI-first product creation

Create the base product in Gumroad UI first. API writes are focused on related catalog operations after the product exists.

### Preview product enable/disable (required phase 1)

```bash
curl -X POST http://localhost:80/admin/products/preview_disable \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "product_id":"abc123"
  }'
```

Example response:

```json
{
  "ok": true,
  "action_type": "product_disable",
  "confirmation_id": "confirm_write_xxx",
  "expires_at": "2026-04-03T12:00:00.000Z",
  "payload_hash": "1f...",
  "status": "pending",
  "requires_confirmation_phrase": false,
  "preview": "Disable product abc123.",
  "api_request": {
    "method": "PATCH",
    "path": "/v2/products/abc123",
    "payload": {
      "published": "false"
    }
  }
}
```

### Confirm catalog action (required phase 2)

```bash
curl -X POST http://localhost:80/admin/writes/confirm \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation_id":"confirm_write_xxx",
    "confirmation_phrase":"CONFIRM CREATE"
  }'
```

Example response:

```json
{
  "ok": true,
  "confirmation_id": "confirm_write_xxx",
  "status": "completed",
  "full_response": {
    "success": true
  }
}
```

## Suggested deployment pattern

- run this as the real backend
- expose `/webhooks/gumroad/ping` publicly
- expose `/mcp` only if you want ChatGPT or another MCP client to use it
- keep `/admin/*` for direct ops and debugging

## Data model

Persistence is file-backed JSON by default at:

```text
./data/personal-db.json
```

Stored data includes:

- products
- sales
- webhook events
- license check history
- job run history
- product-create confirmations (pending/executing/completed/failed/expired)
- write action logs (attempted/completed/failed)

## Product create safety model

- Product create always runs in two phases: preview then confirm.
- All catalog writes (product create, variant category/variant changes, offer-code create/list) run in two phases: preview then confirm.
- Preview stores a pending confirmation record with `confirmation_id`, `payload_hash`, and `expires_at`.
- Confirm moves the record to `executing` before any API call, so reuse of the same `confirmation_id` returns an error and avoids double-submit.
- Every attempted/completed/failed write is persisted in `writeActions`, and confirm stores the full Gumroad API response in the confirmation result.

## Offer code write endpoints

- `offer_code_disable` confirms via `PATCH /v2/products/:productId/offer_codes/:offerCodeId` with `disabled=true`.
- `offer_code_delete` confirms via `DELETE /v2/products/:productId/offer_codes/:offerCodeId`.
- Both actions require `product_id` and `offer_code_id` in preview payloads.
- Preview stores a pending confirmation record with `confirmation_id`, `payload_hash`, and `expires_at`.
- Confirm moves the record to `executing` before any API call, so reuse of the same `confirmation_id` returns an error and avoids double-submit.
- Every attempted/completed/failed write is persisted in `writeActions`, and confirm stores the full Gumroad API response in the confirmation result.

If you want a stronger production backend later, the clean next step is swapping `FileStore` for SQLite or Postgres without changing the Gumroad client or MCP tool surface.


### Generic confirm for all write previews

```bash
curl -X POST http://localhost:80/admin/writes/confirm \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"confirmation_id":"confirm_write_xxx"}'
```

### Variant category preview (create)

```bash
curl -X POST http://localhost:80/admin/variants/categories/preview_create \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"product_id":"prod_123","title":"Size"}'
```

### Variant preview (create)

```bash
curl -X POST http://localhost:80/admin/variants/preview_create \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"product_id":"prod_123","variant_category_id":"vc_123","name":"Large"}'
```

### Offer code preview (create)

```bash
curl -X POST http://localhost:80/admin/offer-codes/preview_create \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"product_id":"prod_123","name":"Summer","code":"SUMMER25","percent_off":25}'
```

### Offer code disable preview

```bash
curl -X POST http://localhost:80/admin/offer-codes/preview_disable \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"product_id":"prod_123","offer_code_id":"oc_123"}'
```

### Offer code delete preview

```bash
curl -X POST http://localhost:80/admin/offer-codes/preview_delete \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"product_id":"prod_123","offer_code_id":"oc_123"}'
```
