/**
 * Executes the actual Express router, principal verifier, service, and Mongoose
 * query casting/update validators. Only the MongoDB collection boundary is an
 * in-memory adapter; these tests do not claim a running MongoDB deployment.
 * Install the existing server dependencies as well as root test dependencies.
 */
import { createRequire } from "node:module";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Prompt from "../../server/src/models/Prompt";
import Appeal from "../../server/src/models/Appeal";
import router from "../../server/src/routes/fingerprintRoutes";
import { SIMILARITY_OVERRIDE_AUDIENCE } from "../../server/src/controllers/fingerprintController";
import {
  signAdminPrincipalToken,
  revokeAdminPrincipalToken,
  clearAdminPrincipalRevocations,
} from "../../server/src/auth/adminPrincipal";

const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const express = requireServer("express");
const request = requireServer("supertest");
const app = express().use(express.json()).use("/api", router);
const secret = "local-test-only-principal-secret-242-override";
const actor = "Maintainer:CaseSensitive";
const promptObjectId = "665000000000000000000001";
const appealObjectId = "665000000000000000000002";
const fixedDate = new Date("2026-09-20T12:00:00.000Z");
const body = { promptId: "242", newDecision: "allow", reason: "Reviewed the original source" };

// Match the subset of Mongo filters used by the actual service. Mongoose still
// casts each query and validates each update before calling this adapter.
function copy(value: any): any {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value);
  if (typeof value.toHexString === "function") return value.toHexString();
  if (typeof value.toObject === "function") return copy(value.toObject());
  if (Array.isArray(value)) return value.map(copy);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
}

function valuesAt(value: any, path: string[]): any[] {
  if (!path.length) return [value];
  if (Array.isArray(value)) return value.flatMap(child => valuesAt(child, path));
  return valuesAt(value?.[path[0]], path.slice(1));
}

function equal(a: any, b: any): boolean {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (a?.toHexString || b?.toHexString) return String(a) === String(b);
  return a === b;
}

function matches(doc: any, filter: any): boolean {
  return !!doc && Object.entries(filter).every(([path, condition]: [string, any]) => {
    const values = valuesAt(doc, path.split("."));
    if (condition && typeof condition === "object" && !(condition instanceof Date) && !condition.toHexString) {
      return Object.entries(condition).every(([op, expected]: [string, any]) => {
        if (op === "$exists") return values.some(value => value !== undefined) === expected;
        if (op === "$eq") return values.some(value => equal(value, expected));
        if (op === "$ne") return values.every(value => !equal(value, expected));
        if (op === "$elemMatch") return values.some(value => Array.isArray(value) && value.some(child => matches(child, expected)));
        throw new Error(`Unsupported test adapter operator ${op}`);
      });
    }
    return values.some(value => equal(value, condition));
  });
}

function applyUpdate(doc: any, update: any) {
  Object.assign(doc, copy(update.$set ?? {}));
  for (const [key, value] of Object.entries(update.$push ?? {})) {
    (doc[key] ??= []).push(copy(value));
  }
}

let prompt: any;
let appeal: any;
let failPrompt: boolean;
let failAppeal: boolean;
let ambiguousAppealWrite: boolean;
let beforePromptWrite: (() => void) | undefined;
let beforeAppealWrite: (() => void) | undefined;
let promptFind: any;
let promptWrite: any;
let appealFind: any;
let appealWrite: any;

function token(options: Record<string, any> = {}) {
  return signAdminPrincipalToken({ sub: actor, roles: ["admin"], secret, aud: SIMILARITY_OVERRIDE_AUDIENCE, ...options });
}

function post(payload: any = body, credential: string | null = token()) {
  const operation = request(app).post("/api/fingerprint/override");
  if (credential !== null) operation.set("Authorization", `Bearer ${credential}`);
  return operation.send(payload);
}

function expectNoWrite() {
  expect(promptWrite).not.toHaveBeenCalled();
  expect(appealWrite).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("ADMIN_PRINCIPAL_SECRET", secret);
  clearAdminPrincipalRevocations();
  failPrompt = failAppeal = ambiguousAppealWrite = false;
  beforePromptWrite = beforeAppealWrite = undefined;
  prompt = {
    _id: promptObjectId, onChainId: "242",
    similarityFlag: "highly_similar", similarityScore: 0.97, similarTo: "source-17",
    similarityCheckedAt: fixedDate, similarityScanStatus: "completed", similarityScanJobId: null,
    similarityDecisionVersion: 6, similarityOverrides: [], updatedAt: fixedDate,
  };
  appeal = {
    _id: appealObjectId, promptId: "242", decisionVersion: 3,
    status: "appealed", previousDecisions: [], updatedAt: fixedDate,
  };
  promptFind = vi.spyOn(Prompt.collection, "findOne").mockImplementation(async (filter: any) => matches(prompt, filter) ? copy(prompt) : null);
  promptWrite = vi.spyOn(Prompt.collection, "findOneAndUpdate").mockImplementation(async (filter: any, update: any) => {
    beforePromptWrite?.();
    if (failPrompt) throw new Error("Injected storage failure");
    if (!matches(prompt, filter)) return null;
    applyUpdate(prompt, update);
    return copy(prompt);
  });
  appealFind = vi.spyOn(Appeal.collection, "findOne").mockImplementation(async (filter: any) => matches(appeal, filter) ? copy(appeal) : null);
  appealWrite = vi.spyOn(Appeal.collection, "findOneAndUpdate").mockImplementation(async (filter: any, update: any) => {
    beforeAppealWrite?.();
    if (failAppeal) throw new Error("Injected appeal storage failure");
    if (!matches(appeal, filter)) return null;
    applyUpdate(appeal, update);
    if (ambiguousAppealWrite) throw new Error("Injected lost acknowledgement");
    return copy(appeal);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdminPrincipalRevocations();
});

describe("authenticated similarity override route", () => {
  it("rejects missing credentials before prompt or appeal lookup", async () => {
    const response = await post({ ...body, actorAddress: "admin", roles: ["admin"], appealId: appealObjectId }, null);
    expect(response.status).toBe(401);
    expect(promptFind).not.toHaveBeenCalled();
    expect(appealFind).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ["bad signature", () => token({ secret: "another-test-only-secret-with-32-characters" })],
    ["malformed credential", () => "not-a-signed-token"],
    ["expired credential", () => token({ now: Date.now() - 10000, ttlMs: 1000 })],
    ["wrong audience", () => token({ aud: "prompt-hash:report-review" })],
    ["missing audience", () => token({ aud: undefined })],
  ])("rejects %s without accessing storage", async (_label, credential) => {
    const response = await post(body, credential());
    expect(response.status).toBe(401);
    expect(promptFind).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("rejects a revoked verified credential", async () => {
    const credential = token({ jti: "revoked-local-test" });
    revokeAdminPrincipalToken("revoked-local-test");
    expect((await post(body, credential)).status).toBe(401);
    expect(promptFind).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("does not elevate a report reviewer using request-body roles", async () => {
    expect((await post({ ...body, roles: ["admin"] }, token({ roles: ["report_reviewer"] }))).status).toBe(403);
    expect(promptFind).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("uses the exact verified subject and stored evidence despite spoofed body fields", async () => {
    const response = await post({ ...body, actorAddress: "attacker", previousDecision: "review", score: 0,
      similarTo: "forged", previousVersion: 999, decisionVersion: 999, sub: "another-actor" });
    expect(response.status).toBe(200);
    expect(response.body.override).toMatchObject({ actorAddress: actor, previousDecision: "block",
      newDecision: "allow", score: 0.97, similarTo: "source-17", decisionVersion: 7 });
    expect(prompt.similarityFlag).toBe("clean");
    expect(prompt.similarityOverrides).toHaveLength(1);
    expect(prompt.similarityOverrides[0]).toEqual(response.body.override);
    expect(promptWrite).toHaveBeenCalledTimes(1);
    expect(appealWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["clean", "review", "suspicious"],
    ["suspicious", "block", "highly_similar"],
    ["highly_similar", "allow", "clean"],
  ])("persists the %s to %s decision with its audit", async (before, decision, after) => {
    prompt.similarityFlag = before;
    const response = await post({ ...body, newDecision: decision });
    expect(response.status).toBe(200);
    expect(response.body.result.decision).toBe(decision);
    expect(prompt.similarityFlag).toBe(after);
    expect(prompt.similarityOverrides[0].newDecision).toBe(decision);
  });

  it.each([
    { ...body, reason: "   " }, { ...body, newDecision: "publish" },
    { ...body, promptId: {} }, { ...body, appealId: "not-an-object-id" },
  ])("rejects malformed operation input before lookup", async payload => {
    expect((await post(payload)).status).toBe(400);
    expect(promptFind).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("returns missing prompt without inventing a blocked prior decision", async () => {
    prompt = null;
    expect((await post(body)).status).toBe(404);
    expectNoWrite();
  });

  it("requires stored scan evidence even when the caller supplies it", async () => {
    prompt.similarityScore = null;
    prompt.similarityCheckedAt = null;
    expect((await post({ ...body, score: 0.99, previousDecision: "block" })).status).toBe(409);
    expectNoWrite();
  });

  it("rejects a no-op decision without adding audit records", async () => {
    expect((await post({ ...body, newDecision: "block" })).status).toBe(400);
    expectNoWrite();
  });

  it("binds a linked appeal to the same stored prompt before writing", async () => {
    appeal.promptId = "different-prompt";
    expect((await post({ ...body, appealId: appealObjectId })).status).toBe(404);
    expectNoWrite();
  });

  it("advances the stored version and retains all previous audit entries", async () => {
    expect((await post()).status).toBe(200);
    const first = copy(prompt.similarityOverrides[0]);
    expect((await post({ ...body, newDecision: "review", reason: "Additional evidence" })).status).toBe(200);
    expect(prompt.similarityDecisionVersion).toBe(8);
    expect(prompt.similarityOverrides).toHaveLength(2);
    expect(prompt.similarityOverrides[0]).toEqual(first);
    expect(prompt.similarityOverrides[1].previousDecision).toBe("allow");
  });

  it("adds a version and audit to legacy documents without an out-of-band migration", async () => {
    delete prompt.similarityDecisionVersion;
    delete prompt.similarityOverrides;
    expect((await post()).status).toBe(200);
    expect(prompt.similarityDecisionVersion).toBe(2);
    expect(prompt.similarityOverrides).toHaveLength(1);
  });

  it("rejects a competing override between the read and guarded write", async () => {
    beforePromptWrite = () => { prompt.similarityDecisionVersion = 7; prompt.similarityFlag = "suspicious"; };
    expect((await post()).status).toBe(409);
    expect(prompt.similarityFlag).toBe("suspicious");
    expect(prompt.similarityOverrides).toHaveLength(0);
  });

  it.each([
    ["similarityCheckedAt", new Date("2026-09-21T12:00:00.000Z")],
    ["similarityScanJobId", "665000000000000000000099"],
    ["similarityScanStatus", "processing"],
  ])("rejects changed scan identity %s even at the same score and override version", async (field, value) => {
    beforePromptWrite = () => { prompt[field as string] = value; };
    expect((await post()).status).toBe(409);
    expect(prompt.similarityFlag).toBe("highly_similar");
    expect(prompt.similarityOverrides).toHaveLength(0);
  });

  it("does not change the decision or optional appeal if the required audit write fails", async () => {
    failPrompt = true;
    expect((await post({ ...body, appealId: appealObjectId })).status).toBe(500);
    expect(prompt.similarityFlag).toBe("highly_similar");
    expect(prompt.similarityDecisionVersion).toBe(6);
    expect(prompt.similarityOverrides).toHaveLength(0);
    expect(appealWrite).not.toHaveBeenCalled();
  });

  it("runs Mongoose update validation before accepting invalid audit data", async () => {
    await expect(Prompt.findOneAndUpdate({ _id: promptObjectId }, {
      $set: { similarityFlag: "clean" },
      $push: { similarityOverrides: { promptId: "242", actorAddress: actor, previousDecision: "block",
        newDecision: "allow", reason: "Invalid evidence", score: 5, at: fixedDate.toISOString(), decisionVersion: 7 } },
    }, { returnDocument: "after", runValidators: true }).lean()).rejects.toThrow();
    expectNoWrite();
    expect(prompt.similarityFlag).toBe("highly_similar");
  });
});

describe("optional appeal projection", () => {
  it("mirrors the verified audit without reducing a newer stored appeal version", async () => {
    appeal.decisionVersion = 9;
    appeal.previousDecisions.push({ decisionVersion: 8, reason: "Earlier appeal review" });
    const response = await post({ ...body, appealId: appealObjectId });
    expect(response.status).toBe(200);
    expect(response.body.appealSync.status).toBe("synced");
    expect(prompt.similarityDecisionVersion).toBe(10);
    expect(appeal.decisionVersion).toBe(10);
    expect(appeal.previousDecisions).toHaveLength(2);
    expect(appeal.previousDecisions[1].actorAddress).toBe(actor);
    expect(appeal.status).toBe("rejected");
  });

  it("reports a transient mirror failure and repairs it on an exact replay without another Prompt write", async () => {
    const payload = { ...body, appealId: appealObjectId };
    failAppeal = true;
    const first = await post(payload);
    expect(first.status).toBe(200);
    expect(first.body.appealSync.status).toBe("pending");
    expect(prompt.similarityFlag).toBe("clean");
    expect(prompt.similarityOverrides).toHaveLength(1);
    expect(appeal.status).toBe("appealed");
    failAppeal = false;
    const second = await post(payload);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.appealSync.status).toBe("synced");
    expect((await post(payload)).body.appealSync.status).toBe("synced");
    expect(promptWrite).toHaveBeenCalledTimes(1);
    expect(prompt.similarityOverrides).toHaveLength(1);
    expect(appeal.previousDecisions).toHaveLength(1);
  });

  it("recognizes a previously committed mirror after its acknowledgement was lost", async () => {
    const payload = { ...body, appealId: appealObjectId };
    ambiguousAppealWrite = true;
    expect((await post(payload)).body.appealSync.status).toBe("pending");
    ambiguousAppealWrite = false;
    expect((await post(payload)).body.appealSync.status).toBe("synced");
    expect(promptWrite).toHaveBeenCalledTimes(1);
    expect(appeal.previousDecisions).toHaveLength(1);
  });

  it("reports a concurrent appeal review without overwriting it, including on retry", async () => {
    const payload = { ...body, appealId: appealObjectId };
    beforeAppealWrite = () => { appeal.decisionVersion = 8; appeal.status = "reviewed"; };
    const first = await post(payload);
    expect(first.status).toBe(200);
    expect(first.body.appealSync.status).toBe("conflict");
    expect(appeal.status).toBe("reviewed");
    expect(appeal.previousDecisions).toHaveLength(0);
    beforeAppealWrite = undefined;
    expect((await post(payload)).body.appealSync.status).toBe("conflict");
    expect(promptWrite).toHaveBeenCalledTimes(1);
  });

  it.each(["actor", "reason", "scan"])("does not repair a mirror when the committed %s binding differs", async kind => {
    const payload = { ...body, appealId: appealObjectId };
    failAppeal = true;
    expect((await post(payload)).body.appealSync.status).toBe("pending");
    failAppeal = false;
    if (kind === "scan") prompt.similarityCheckedAt = new Date(Date.now() + 10000);
    const response = await post(kind === "reason" ? { ...payload, reason: "Different reason" } : payload,
      kind === "actor" ? token({ sub: actor.toLowerCase() }) : token());
    expect(response.status).toBe(400);
    expect(promptWrite).toHaveBeenCalledTimes(1);
    expect(appeal.previousDecisions).toHaveLength(0);
  });
});
