/**
 * Shared verified admin principal — security regression tests (#146).
 */

import { createHmac } from "crypto";
import {
  ADMIN_ROLE,
  REPORT_REVIEWER_ROLE,
  AdminAuthError,
  authorizeAdminPrincipal,
  clearAdminPrincipalRevocations,
  reloadAdminPrincipalRevocationsFromEnv,
  revokeAdminPrincipalToken,
  signAdminPrincipalToken,
  verifyAdminPrincipalToken,
} from "./adminPrincipal";

const SECRET = "test-admin-principal-secret-00000001"; // >= 32 chars
const NOW = 1_700_000_000_000;
const AUD = "prompt-hash:report-review";

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function forge(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

beforeEach(() => {
  process.env.ADMIN_PRINCIPAL_SECRET = SECRET;
  delete process.env.ADMIN_PRINCIPAL_REVOKED_JTIS;
  clearAdminPrincipalRevocations();
});

afterAll(() => {
  delete process.env.ADMIN_PRINCIPAL_SECRET;
  delete process.env.ADMIN_PRINCIPAL_REVOKED_JTIS;
});

describe("adminPrincipal — issuance / verification", () => {
  it("verifies a valid report_reviewer principal", () => {
    const token = signAdminPrincipalToken({
      sub: "reviewer-1",
      roles: [REPORT_REVIEWER_ROLE],
      now: NOW,
      aud: AUD,
    });
    const claims = verifyAdminPrincipalToken(token, {
      now: NOW + 1000,
      expectedAud: AUD,
    });
    expect(claims.sub).toBe("reviewer-1");
    expect(claims.roles).toContain(REPORT_REVIEWER_ROLE);
  });

  it("rejects the former non-empty-token bypass (random bearer)", () => {
    expect(() =>
      authorizeAdminPrincipal(bearer("totally-random-token"), { now: NOW }),
    ).toThrow(AdminAuthError);
    try {
      authorizeAdminPrincipal(bearer("totally-random-token"), { now: NOW });
    } catch (err) {
      expect((err as AdminAuthError).code).toBe("malformed_credentials");
    }
  });

  it("rejects empty / missing / non-bearer credentials", () => {
    expect(() => authorizeAdminPrincipal(undefined, { now: NOW })).toThrow(
      /Missing/,
    );
    expect(() => authorizeAdminPrincipal("", { now: NOW })).toThrow(
      /Malformed/,
    );
    expect(() => authorizeAdminPrincipal("Token abc", { now: NOW })).toThrow(
      /Malformed/,
    );
    expect(() => authorizeAdminPrincipal(bearer(""), { now: NOW })).toThrow(
      /Malformed/,
    );
  });

  it("rejects tokens signed with the wrong secret", () => {
    const token = signAdminPrincipalToken({
      sub: "x",
      roles: [ADMIN_ROLE],
      secret: "other-secret-other-secret-other-00",
      now: NOW,
    });
    expect(() => verifyAdminPrincipalToken(token, { now: NOW })).toThrow(
      /Invalid/,
    );
  });

  it("rejects expired tokens", () => {
    const token = signAdminPrincipalToken({
      sub: "x",
      roles: [REPORT_REVIEWER_ROLE],
      now: NOW,
      ttlMs: 1000,
    });
    try {
      verifyAdminPrincipalToken(token, { now: NOW + 5000 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminAuthError);
      expect((err as AdminAuthError).code).toBe("expired_token");
    }
  });

  it("rejects revoked tokens (in-process + env denylist)", () => {
    const token = signAdminPrincipalToken({
      sub: "x",
      roles: [REPORT_REVIEWER_ROLE],
      jti: "revoked-jti-1",
      now: NOW,
    });
    revokeAdminPrincipalToken("revoked-jti-1");
    expect(() => verifyAdminPrincipalToken(token, { now: NOW })).toThrow(
      /revoked/i,
    );

    clearAdminPrincipalRevocations();
    process.env.ADMIN_PRINCIPAL_REVOKED_JTIS = "env-revoked-a, env-revoked-b";
    reloadAdminPrincipalRevocationsFromEnv();
    const token2 = signAdminPrincipalToken({
      sub: "y",
      roles: [ADMIN_ROLE],
      jti: "env-revoked-a",
      now: NOW,
    });
    expect(() => verifyAdminPrincipalToken(token2, { now: NOW })).toThrow(
      /revoked/i,
    );
  });

  it("rejects wrong-audience tokens when expectedAud is set", () => {
    const token = signAdminPrincipalToken({
      sub: "x",
      roles: [REPORT_REVIEWER_ROLE],
      aud: "other-service",
      now: NOW,
    });
    expect(() =>
      verifyAdminPrincipalToken(token, { now: NOW, expectedAud: AUD }),
    ).toThrow(/Invalid/);
  });

  it("rejects forged payloads that flip roles without a valid signature", () => {
    const token = forge(
      {
        sub: "attacker",
        roles: [ADMIN_ROLE],
        jti: "j",
        iat: NOW,
        exp: NOW + 60_000,
        aud: AUD,
      },
      "attacker-secret-attacker-secret-000",
    );
    expect(() => verifyAdminPrincipalToken(token, { now: NOW })).toThrow(
      /Invalid/,
    );
  });
});

describe("adminPrincipal — role matrix", () => {
  it("allows report_reviewer when that role is required", () => {
    const token = signAdminPrincipalToken({
      sub: "rev",
      roles: [REPORT_REVIEWER_ROLE],
      now: NOW,
      aud: AUD,
    });
    const principal = authorizeAdminPrincipal(bearer(token), {
      now: NOW,
      expectedAud: AUD,
      requiredRoles: [REPORT_REVIEWER_ROLE, ADMIN_ROLE],
    });
    expect(principal.sub).toBe("rev");
  });

  it("allows admin when report-review roles are required", () => {
    const token = signAdminPrincipalToken({
      sub: "ops",
      roles: [ADMIN_ROLE],
      now: NOW,
      aud: AUD,
    });
    const principal = authorizeAdminPrincipal(bearer(token), {
      now: NOW,
      expectedAud: AUD,
      requiredRoles: [REPORT_REVIEWER_ROLE, ADMIN_ROLE],
    });
    expect(principal.roles).toContain(ADMIN_ROLE);
  });

  it("rejects principals that lack the required role", () => {
    const token = signAdminPrincipalToken({
      sub: "analyst",
      roles: ["analytics_viewer"],
      now: NOW,
      aud: AUD,
    });
    try {
      authorizeAdminPrincipal(bearer(token), {
        now: NOW,
        expectedAud: AUD,
        requiredRoles: [REPORT_REVIEWER_ROLE, ADMIN_ROLE],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminAuthError);
      expect((err as AdminAuthError).code).toBe("forbidden");
    }
  });

  it("derives actor identity only from verified claims", () => {
    const token = signAdminPrincipalToken({
      sub: "canonical-actor",
      roles: [REPORT_REVIEWER_ROLE],
      now: NOW,
    });
    const principal = authorizeAdminPrincipal(bearer(token), { now: NOW });
    expect(principal.sub).toBe("canonical-actor");
  });
});
