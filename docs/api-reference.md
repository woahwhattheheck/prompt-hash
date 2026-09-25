# API Reference

This reference covers the marketplace and account endpoints used by the PromptHash frontend and the Express backend.

## Common Response Rules

- Successful requests return JSON.
- Validation failures return `422` with a field-level error map when available.
- Missing resources return `404`.
- Auth or ownership failures return `403`.

### Shared validation error shape

```json
{
  "error": "Invalid listing metadata",
  "fields": {
    "title": "Title is required.",
    "price": "Price must be greater than zero."
  }
}
```

## Marketplace Endpoints

### List prompts

`GET /api/prompts`

Returns published, active marketplace prompts.

Optional query parameters:

- `category`
- `walletAddress`

Example response:

```json
[
  {
    "_id": "6650f1...",
    "image": "https://example.com/cover.png",
    "title": "Launch Strategy Pack",
    "content": "Public preview text ...",
    "owner": {
      "username": "faithorji",
      "walletAddress": "g..."
    },
    "price": 2.5,
    "category": "Marketing",
    "listingStatus": "published",
    "isActive": true,
    "salesCount": 12
  }
]
```

### Create a prompt

`POST /api/prompts`

Creates a creator listing after validating and normalizing the listing metadata.

Request body:

```json
{
  "image": "https://example.com/cover.png",
  "title": "Launch Strategy Pack",
  "content": "Long-form prompt content",
  "walletAddress": "g...",
  "price": 2.5,
  "category": "marketing"
}
```

Example response:

```json
{
  "message": "Prompt created successfully",
  "prompt": {
    "_id": "6650f1...",
    "title": "Launch Strategy Pack",
    "price": 2.5,
    "category": "Marketing"
  }
}
```

### Publish a draft

`POST /api/prompts/:id/publish`

Publishes a draft prompt after validating required fields.

Example error response:

```json
{
  "error": "Prompt is not publishable",
  "fields": {
    "content": "Content is required."
  }
}
```

### Archive a prompt

`POST /api/prompts/:id/archive`

Marks a prompt as archived and removes it from active workflow views.

## Buyer Library Endpoints

### Get owned prompts

`GET /api/prompts/buyer/:walletAddress/owned`

Returns prompts tied to purchases for the buyer wallet.

Example response:

```json
{
  "owned": [
    {
      "purchaseId": "66a1...",
      "prompt": {
        "_id": "6650f1...",
        "title": "Launch Strategy Pack",
        "content": "Public preview text ...",
        "category": "Marketing"
      },
      "txHash": "tx_123",
      "versionIndex": 1,
      "purchasedAt": "2026-05-28T10:15:30.000Z"
    }
  ]
}
```

### Get saved prompts

`GET /api/prompts/buyer/:walletAddress/saved`

Returns the buyer's saved marketplace listings.

Example response:

```json
{
  "saved": [
    {
      "purchaseId": "66a1...",
      "prompt": {
        "_id": "6650f1...",
        "title": "Launch Strategy Pack",
        "content": "Preview text ...",
        "price": 2.5,
        "category": "Marketing",
        "owner": {
          "username": "faithorji"
        }
      },
      "savedAt": "2026-05-28T10:15:30.000Z"
    }
  ]
}
```

### Save a prompt

`POST /api/prompts/buyer/save`

Request body:

```json
{
  "walletAddress": "g...",
  "promptId": "6650f1..."
}
```

Example response:

```json
{ "saved": true, "purchaseId": "66a1..." }
```

### Remove a saved prompt

`POST /api/prompts/buyer/unsave`

Request body:

```json
{
  "walletAddress": "g...",
  "promptId": "6650f1..."
}
```

Example response:

```json
{ "saved": false }
```

## Creator Workspace Endpoints

### Get draft prompts

`GET /api/prompts/creator/:walletAddress/drafts`

Returns draft and ready-to-publish prompts for the connected creator wallet.

### Version updates

`POST /api/prompts/version`

Creates a new version for a prompt owned by the calling wallet.

## Account And Auth Flow

### Challenge token

`POST /api/unlock/challenge`

Issues a short-lived challenge token for wallet verification.

### Unlock prompt

`POST /api/unlock/verify`

Verifies the wallet signature and on-chain entitlement before returning decrypted content.

## Notes For Frontend Contributors

- Listing metadata is normalized server-side before persistence.
- Category casing is canonicalized so the frontend can send user-friendly values.
- The buyer dashboard reads from `/api/prompts/buyer/:walletAddress/saved` and `/api/prompts/buyer/:walletAddress/owned` to populate separate library sections.
- Save and unsave actions are intentionally idempotent from the UI perspective.

---

## Webhooks

PromptHash delivers real-time event notifications via webhooks. Each subscription is tied to a creator wallet and receives signed JSON payloads when marketplace events occur.

### Supported Events

| Event | Description |
|-------|-------------|
| `PromptPurchased` | A buyer purchased a license for a prompt |
| `PromptCreated` | A new prompt was created and listed |
| `LicenseTransferred` | A license was transferred between wallets |
| `ReviewSubmitted` | A buyer submitted a review for a prompt |

### Register a webhook

`POST /api/webhooks`

Request body:

```json
{
  "walletAddress": "G...",
  "url": "https://your-server.com/webhooks",
  "events": ["PromptPurchased", "PromptCreated"]
}
```

The `events` array is optional — defaults to `["PromptPurchased"]`. Only events in the supported list are accepted; unknown events are silently filtered.

Example response (201):

```json
{
  "message": "Webhook registered.",
  "id": "6650f1...",
  "secret": "a1b2c3d4..."
}
```

**Important:** The `secret` is returned only on creation. Store it securely — you need it to verify signatures.

### Get webhook subscription

`GET /api/webhooks?walletAddress=G...`

Returns the subscription (secret excluded from response).

### Delete webhook subscription

`DELETE /api/webhooks`

Request body:

```json
{
  "walletAddress": "G..."
}
```

### Webhook payload format

```json
{
  "event": "PromptPurchased",
  "deliveryId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-20T12:00:00.000Z",
  "data": {
    "promptId": "42",
    "buyer": "G...",
    "title": "Launch Strategy Pack"
  }
}
```

### Request headers

| Header | Description |
|--------|-------------|
| `X-PromptHash-Signature` | HMAC-SHA256 signature: `sha256=<hex-digest>` |
| `X-PromptHash-Delivery` | Unique delivery ID (UUID) for idempotency |
| `X-PromptHash-Event` | Event type name |
| `X-PromptHash-Timestamp` | ISO 8601 timestamp of event creation |

### Signature verification

Verify the webhook payload using your stored secret:

```typescript
import { createHmac } from "crypto";

function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
```

Usage in an Express handler:

```typescript
app.post("/webhooks", (req, res) => {
  const signature = req.headers["x-prompthash-signature"];
  const body = JSON.stringify(req.body);

  if (!verifyWebhookSignature(YOUR_SECRET, body, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const deliveryId = req.headers["x-prompthash-delivery"];
  // Use deliveryId for idempotency — skip if already processed

  // Process the event...
  res.status(200).json({ received: true });
});
```

### Idempotency

Each delivery has a unique `deliveryId` (UUID) sent in the `X-PromptHash-Delivery` header. Your handler should:

1. Check if the `deliveryId` has been processed before
2. If yes, return 200 immediately (duplicate delivery)
3. If no, process the event and record the `deliveryId`

This is critical because PromptHash retries failed deliveries, which may result in duplicate HTTP requests.

### Retry behavior

- Failed deliveries (5xx errors, network timeouts, 429 rate limits) are retried up to 3 times
- Retries use exponential backoff: 2s, 4s, 8s
- 4xx errors (except 429) are treated as permanent failures — no retry
- After 10 consecutive failures, the subscription is automatically disabled
- All delivery attempts are logged in the `WebhookDeliveryLog` collection

### Rate limiting

Webhook endpoints should handle bursts gracefully. We recommend:
- Return 200 quickly and process asynchronously
- Use 429 with `Retry-After` header if your system is overloaded

## Adapter consolidation

Serverless and Express adapters for prompt versioning and webhooks share authoritative domain services. See [api-adapter-consolidation.md](./api-adapter-consolidation.md).
