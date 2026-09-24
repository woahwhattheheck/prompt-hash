# Security Model and Threat Architecture

This document outlines the security assumptions, potential attack vectors, and mitigation strategies for the PromptHash Stellar ecosystem.

## Security Architecture

The system relies on a hybrid architecture combining on-chain state (Soroban) with off-chain gated delivery (Unlock Service).

### Trust Boundaries
1.  **Client (Browser)**: Responsible for initial encryption and wallet interaction. Trusted to not leak the plaintext before it's encrypted.
2.  **Soroban Contract**: Trusted source of truth for "who owns what". Enforces XLM payments and immutable entitlement records.
3.  **Unlock Service**: Responsible for key unwrapping and decryption. Trusted to verify on-chain state before releasing content.

---

## Threat Model

### 1. Service-in-the-Middle (Replay Attacks)
**Scenario:** An attacker intercepts a signed challenge and attempts to use it later to unlock content.
**Mitigation:**
- **Nonces**: Every challenge includes a unique `nonce` (UUID) that the server tracks (or signs into the token).
- **TTL (Time-to-Live)**: Challenge tokens are short-lived (e.g., 5 minutes). Even if intercepted, the window of opportunity is small.
- **Server Signature**: The challenge token is signed by the server's secret, preventing attackers from forging their own valid challenges.

### 2. Double-Spend / Lack of Entitlement
**Scenario:** A user attempts to unlock content without paying, or after a transaction was reverted.
**Mitigation:**
- **On-Chain Verification**: The Unlock Service MUST query the Soroban contract's `has_access` method before performing any decryption. This ensures that the buyer's address is permanently recorded as having purchase rights.
- **Finality**: The service should wait for transaction finality (successful ledger inclusion) before acknowledging a purchase.

### 3. Server Compromise
**Scenario:** An attacker gains access to the Unlock Service's private key.
**Mitigation:**
- **Encrypted-at-Rest**: Content stored on-chain is encrypted with AES keys that are wrapped. Even with the service private key, the attacker still needs to fetch the encrypted payload from the blockchain.
- **Separation of Concerns**: The service does not store a master key for all prompts; it only holds the key used for wrapping.

### 4. Malicious Creator (Content Mismatch)
**Scenario:** A creator sells a "Gold Prompt" but puts garbage in the encrypted payload.
**Mitigation:**
- **Content Hash**: The contract stores a SHA-256 hash of the intended plaintext. When the buyer unlocks, the service re-hashes the result. If it doesn't match, the buyer has proof of fraud.
- **Reputation**: (Future) Community ratings and escrow systems can mitigate this further.

---

## Creator privacy (off-chain index)

Owned prompts, drafts, and version writes are gated by a **signed creator
session** (HMAC claims + Stellar Ed25519 signature). See
[creator-privacy.md](./creator-privacy.md). Public listing endpoints must never
serialize draft plaintext or private version content; version history remains
metadata-only.

## Access Control Logic

The `has_access` logic in the contract is the primary gatekeeper:
```rust
fn has_access(env: Env, user: Address, prompt_id: u128) -> Result<bool, Error> {
    let prompt = Storage::require_prompt(&env, prompt_id)?;
    Ok(prompt.creator == user || Storage::has_purchase(&env, prompt_id, &user))
}
```
This ensures that ONLY the original creator or a verified buyer can ever trigger the unlock flow successfully.

---

## Frontend Security Headers

The frontend ships with baseline browser security headers to reduce XSS, clickjacking, and data leakage risks.

### Headers (Production via Vercel)

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | See policy below | Restricts resource loading to trusted origins |
| `X-Frame-Options` | `DENY` | Prevents clickjacking via iframe embedding |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | Disables unnecessary browser features |
| `X-XSS-Protection` | `0` | Disables legacy XSS filter (CSP is the modern mitigation) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Forces HTTPS for 2 years |

### Content-Security-Policy (Production)

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: https://gateway.pinata.cloud https://*.sentry.io;
font-src 'self' https://fonts.gstatic.com;
connect-src 'self' https://soroban-*.stellar.org https://soroban-rpc.mainnet.stellar.org
             https://horizon-*.stellar.org https://horizon.stellar.org
             https://rpc-futurenet.stellar.org
             https://friendbot*.stellar.org https://friendbot.stellar.org
             https://gateway.pinata.cloud https://api.pinata.cloud
             https://*.sentry.io https://secret-ai-gateway.onrender.com
             wss://*.sentry.io;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
worker-src 'none';
upgrade-insecure-requests
```

#### Allowed Origins Explained

| Directive | Origins | Why |
|-----------|---------|-----|
| `connect-src` | `soroban-*.stellar.org`, `soroban-rpc.mainnet.stellar.org` | Stellar RPC endpoints (testnet/futurenet via wildcard, mainnet explicit) |
| `connect-src` | `horizon-*.stellar.org`, `horizon.stellar.org` | Horizon API endpoints (testnet/futurenet via wildcard, mainnet explicit) |
| `connect-src` | `rpc-futurenet.stellar.org` | Futurenet Soroban RPC (different subdomain pattern than testnet) |
| `connect-src` | `friendbot*.stellar.org`, `friendbot.stellar.org` | Stellar testnet/friendbot faucet |
| `connect-src` | `gateway.pinata.cloud`, `api.pinata.cloud` | IPFS upload (Pinata) and ciphertext retrieval |
| `connect-src` | `*.sentry.io`, `wss://*.sentry.io` | Error monitoring and session replay |
| `connect-src` | `secret-ai-gateway.onrender.com` | Chat/AI API backend |
| `img-src` | `gateway.pinata.cloud` | IPFS-hosted prompt images and avatars |
| `style-src` | `fonts.googleapis.com` | Google Fonts CSS (Inter, Inconsolata) |
| `font-src` | `fonts.gstatic.com` | Google Fonts font files |

#### `unsafe-inline` Justification

- **`style-src 'unsafe-inline'`**: Required because React and Radix UI inject styles at runtime via `element.style` and `CSSStyleSheet.insertRule()`. CSP nonces do not cover these patterns. This is standard for React SPAs.
- **`script-src`**: No `'unsafe-inline'` is used in production. All scripts are external module files served with hashes by Vite. The dev CSP adds `'unsafe-eval'` for Vite HMR and `'unsafe-inline'` for dev tooling.

#### Development vs Production Differences

The Vite dev server injects a more permissive CSP via `scripts/vite-security-headers.mjs`:

- Adds `'unsafe-eval'` and `'unsafe-inline'` to `script-src` (required by Vite HMR)
- Adds `ws:` and `wss:` to `connect-src` (Vite WebSocket for HMR)
- Adds `http://localhost:5173` and `http://localhost:5000` (dev server and API proxy)
- Adds `blob:` to `worker-src` (service worker support in dev)

Production headers are served exclusively through `vercel.json` and additionally include:

- `upgrade-insecure-requests` (auto-upgrades HTTP to HTTPS)
- No `'unsafe-eval'` or `'unsafe-inline'` in `script-src`

### Updating the Policy

When adding a new external service:

1. Identify which CSP directive the service falls under (connect-src for API calls, img-src for images, etc.)
2. Add the service's origin to `vercel.json` headers and `scripts/vite-security-headers.mjs`
3. Run `vitest run src/test/security-headers.test.ts` to verify the test still passes
4. Update this document's policy table
5. Test the affected flow in browser devtools (Network and Console tabs)

---

## Standalone Express API Hardening (#169)

The frontend CSP above governs the Vite/Vercel-served app. The standalone
Express server (`server/src/server.ts`) is a separate deployment and has its
own HTTP hardening, configured in `server/src/middleware/security.ts`:

- **CORS**: Only origins listed in the `ALLOWED_ORIGINS` environment
  variable (comma-separated) may make credentialed cross-origin requests.
  Requests with no `Origin` header (server-to-server calls, curl, mobile
  clients) are unaffected by CORS either way. There is no default-allow
  fallback - an unset `ALLOWED_ORIGINS` means no browser origin is trusted.
- **Defensive headers**: Helmet is applied globally (`X-Content-Type-Options`,
  `X-Frame-Options`, HSTS, `X-Powered-By` removal, etc). Its CSP directive is
  disabled here since this server serves JSON only, not HTML.
- **Trusted proxy**: Set `TRUSTED_PROXY_HOPS` to the exact number of reverse
  proxies/load balancers terminating traffic in front of the server process
  (defaults to `1`, the common single-hop case). This is passed to Express's
  `trust proxy` setting so `req.ip` - used by the rate limiters in
  `middleware/rateLimiter.ts` - reflects the real client address instead of
  an attacker-controlled `X-Forwarded-For` header. Deploying behind an extra
  hop (e.g. a CDN in front of a load balancer) without updating this value
  under-counts trusted hops and allows IP spoofing; over-counting it collapses
  distinct clients onto the same rate-limit bucket.
- **Request body limits**: `express.json()` is scoped per route class rather
  than mounted once globally - a `100kb` default for most JSON APIs, and a
  `2mb` budget for the routes that carry prompt content (`/api/prompts`,
  `/api/versions`), which can legitimately be larger. Oversized bodies are
  rejected with `413` before reaching any handler.

Required deployment configuration (set for every environment - local,
staging, production):

| Variable | Purpose | Example |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API | `https://app.example.com,https://staging.example.com` |
| `TRUSTED_PROXY_HOPS` | Number of trusted reverse-proxy hops in front of the server | `1` |
