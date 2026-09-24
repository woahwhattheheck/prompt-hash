/**
 * Tests for webhook delivery-log privacy helpers (issue #176).
 * Covers: basic-auth URLs, query tokens, IPv6/private hosts, long errors,
 * encryption rotation, and TTL cleanup.
 */

import { randomBytes } from "crypto";
import {
  buildDeliveryLogEndpointFields,
  computeDeliveryLogExpiresAt,
  decryptDestination,
  DEFAULT_DELIVERY_LOG_TTL_DAYS,
  encryptDestination,
  MAX_ERROR_TEXT_LENGTH,
  normalizeDeliveryError,
  normalizeHttpError,
  publicDeliveryLogEndpoint,
  purgeExpiredDeliveryLogs,
  redactEndpointUrl,
  sanitizeErrorText,
} from "../services/webhookLogPrivacy";

const ENC_KEY = "WEBHOOK_DESTINATION_ENCRYPTION_KEY";
const ENC_VER = "WEBHOOK_DESTINATION_ENCRYPTION_KEY_VERSION";
const ENC_PREV = "WEBHOOK_DESTINATION_ENCRYPTION_KEY_PREVIOUS";
const ENC_PREV_VER = "WEBHOOK_DESTINATION_ENCRYPTION_KEY_PREVIOUS_VERSION";
const TTL_DAYS = "WEBHOOK_DELIVERY_LOG_TTL_DAYS";

function clearEnv() {
  delete process.env[ENC_KEY];
  delete process.env[ENC_VER];
  delete process.env[ENC_PREV];
  delete process.env[ENC_PREV_VER];
  delete process.env[TTL_DAYS];
}

describe("redactEndpointUrl", () => {
  it("strips basic-auth credentials", () => {
    const redacted = redactEndpointUrl(
      "https://user:s3cret@hooks.example.com/webhook/path",
    );
    expect(redacted).toBe("https://hooks.example.com/webhook/path");
    expect(redacted).not.toContain("user");
    expect(redacted).not.toContain("s3cret");
  });

  it("redacts sensitive query tokens while keeping harmless params", () => {
    const redacted = redactEndpointUrl(
      "https://hooks.example.com/hook?token=abc123&ref=campaign&api_key=supersecret",
    );
    expect(redacted).toContain("token=%5BREDACTED%5D");
    expect(redacted).toContain("api_key=%5BREDACTED%5D");
    expect(redacted).toContain("ref=campaign");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("supersecret");
  });

  it("preserves bracketed IPv6 hosts and ports", () => {
    const redacted = redactEndpointUrl(
      "https://[2001:db8::1]:8443/hooks?access_token=xyz",
    );
    expect(redacted).toContain("[2001:db8::1]");
    expect(redacted).toContain(":8443");
    expect(redacted).toContain("/hooks");
    expect(redacted).not.toContain("xyz");
  });

  it("preserves private/loopback hostnames without leaking credentials", () => {
    const redacted = redactEndpointUrl(
      "http://admin:pw@10.0.0.5/internal?password=hunter2",
    );
    expect(redacted).toBe("http://10.0.0.5/internal?password=%5BREDACTED%5D");
    expect(redacted).not.toContain("admin");
    expect(redacted).not.toContain("pw");
    expect(redacted).not.toContain("hunter2");
  });

  it("returns a stable placeholder for malformed URLs (no credential echo)", () => {
    expect(redactEndpointUrl("not a url user:pass@host")).toBe("[invalid-url]");
    expect(redactEndpointUrl("")).toBe("[invalid-url]");
  });
});

describe("buildDeliveryLogEndpointFields", () => {
  afterEach(() => clearEnv());

  it("stores redacted identity in both url and endpointIdentity; skips encrypt without key", () => {
    clearEnv();
    const fields = buildDeliveryLogEndpointFields(
      "https://alice:bob@hooks.example.com/x?token=t",
    );
    expect(fields.url).toBe(fields.endpointIdentity);
    expect(fields.endpointIdentity).toBe(
      "https://hooks.example.com/x?token=%5BREDACTED%5D",
    );
    expect(fields.encryptedDestination).toBeNull();
    expect(fields.encryptionKeyVersion).toBeNull();
  });

  it("encrypts destination when key is configured", () => {
    process.env[ENC_KEY] = randomBytes(32).toString("hex");
    process.env[ENC_VER] = "1";
    const raw = "https://alice:bob@hooks.example.com/x?token=t";
    const fields = buildDeliveryLogEndpointFields(raw);
    expect(fields.encryptedDestination).toMatch(
      /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/,
    );
    expect(fields.encryptionKeyVersion).toBe(1);
    expect(fields.encryptedDestination).not.toContain("alice");
    expect(fields.encryptedDestination).not.toContain("token=t");
    expect(decryptDestination(fields.encryptedDestination!, 1)).toBe(raw);
  });
});

describe("destination encryption rotation", () => {
  afterEach(() => clearEnv());

  it("decrypts ciphertext produced under a previous key version after rotation", () => {
    const keyV1 = randomBytes(32).toString("hex");
    const keyV2 = randomBytes(32).toString("hex");
    const raw = "https://user:pass@hooks.example.com/rotate?api_key=old";

    process.env[ENC_KEY] = keyV1;
    process.env[ENC_VER] = "1";
    const encrypted = encryptDestination(raw);
    expect(encrypted).not.toBeNull();
    expect(encrypted!.keyVersion).toBe(1);

    process.env[ENC_KEY] = keyV2;
    process.env[ENC_VER] = "2";
    process.env[ENC_PREV] = keyV1;
    process.env[ENC_PREV_VER] = "1";

    expect(decryptDestination(encrypted!.ciphertext, 1)).toBe(raw);

    const reencrypted = encryptDestination(raw);
    expect(reencrypted!.keyVersion).toBe(2);
    expect(decryptDestination(reencrypted!.ciphertext, 2)).toBe(raw);
  });
});

describe("error normalization", () => {
  it("maps HTTP statuses to closed codes and HTTP N messages", () => {
    expect(normalizeHttpError(404)).toEqual({
      errorCode: "http_client_error",
      lastError: "HTTP 404",
    });
    expect(normalizeHttpError(500)).toEqual({
      errorCode: "http_server_error",
      lastError: "HTTP 500",
    });
    expect(normalizeHttpError(429)).toEqual({
      errorCode: "http_rate_limited",
      lastError: "HTTP 429",
    });
  });

  it("maps timeout / SSRF / DNS / network errors without leaking raw detail", () => {
    expect(normalizeDeliveryError(new Error("request timed out after 10000ms"))).toEqual({
      errorCode: "timeout",
      lastError: "Delivery timed out",
    });
    expect(
      normalizeDeliveryError(new Error("SSRF Validation Failed: private IP")),
    ).toEqual({
      errorCode: "ssrf_blocked",
      lastError: "Destination blocked by SSRF policy",
    });
    expect(normalizeDeliveryError(new Error("getaddrinfo ENOTFOUND evil.local"))).toEqual({
      errorCode: "dns_failed",
      lastError: "DNS resolution failed",
    });
    expect(
      normalizeDeliveryError(new Error("connect ECONNREFUSED 10.0.0.1:443")),
    ).toEqual({
      errorCode: "network_error",
      lastError: "Network error",
    });
  });

  it("caps and sanitizes long unknown errors (no IPs/URLs)", () => {
    const long = `upstream blew up at https://evil.example/path via 203.0.113.50 ${"x".repeat(500)}`;
    const normalized = normalizeDeliveryError(new Error(long));
    expect(normalized.errorCode).toBe("unknown");
    expect(normalized.lastError.length).toBeLessThanOrEqual(MAX_ERROR_TEXT_LENGTH);
    expect(normalized.lastError).not.toContain("evil.example");
    expect(normalized.lastError).not.toContain("203.0.113.50");
    expect(normalized.lastError).toContain("[redacted-url]");
    expect(normalized.lastError).toContain("[redacted-ip]");
  });

  it("sanitizeErrorText redacts IPv6 literals", () => {
    const out = sanitizeErrorText("upstream 2001:db8::dead:beef refused");
    expect(out).not.toMatch(/2001:db8/i);
    expect(out).toContain("[redacted-ip]");
  });
});

describe("TTL / retention", () => {
  afterEach(() => clearEnv());

  it("defaults expiresAt to ~30 days from now", () => {
    delete process.env[TTL_DAYS];
    const from = new Date("2026-01-01T00:00:00.000Z");
    const expires = computeDeliveryLogExpiresAt(from);
    const expected = new Date(
      from.getTime() + DEFAULT_DELIVERY_LOG_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(expires.toISOString()).toBe(expected.toISOString());
  });

  it("honors WEBHOOK_DELIVERY_LOG_TTL_DAYS override", () => {
    process.env[TTL_DAYS] = "7";
    const from = new Date("2026-01-01T00:00:00.000Z");
    const expires = computeDeliveryLogExpiresAt(from);
    expect(expires.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("purgeExpiredDeliveryLogs deletes only expired rows", async () => {
    const model = {
      deleteMany: jest.fn(async (_filter: object) => ({ deletedCount: 2 })),
    };
    const now = new Date("2026-06-01T00:00:00.000Z");
    const count = await purgeExpiredDeliveryLogs(model, now);
    expect(count).toBe(2);
    expect(model.deleteMany).toHaveBeenCalledWith({ expiresAt: { $lte: now } });
  });
});

describe("publicDeliveryLogEndpoint", () => {
  it("never exposes credential-bearing URLs", () => {
    const pub = publicDeliveryLogEndpoint({
      deliveryId: "del-1",
      url: "https://user:pass@hooks.example.com/h?token=abc",
      lastError: "connect ECONNREFUSED 10.1.2.3:443",
    });
    expect(pub.deliveryId).toBe("del-1");
    expect(pub.endpointIdentity).not.toContain("user");
    expect(pub.endpointIdentity).not.toContain("pass");
    expect(pub.endpointIdentity).not.toContain("abc");
    expect(pub.lastError).not.toContain("10.1.2.3");
  });
});
