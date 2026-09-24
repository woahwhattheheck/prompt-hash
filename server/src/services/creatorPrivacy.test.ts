/**
 * Creator privacy — projections, draft leakage regression, audit (#142).
 */

import {
  mapPromptsPrivate,
  mapPromptsPublic,
  recordCreatorPrivacyAudit,
  toPrivatePromptProjection,
  toPublicPromptProjection,
} from "./creatorPrivacy";

describe("public vs private projections", () => {
  const draft = {
    _id: "d1",
    title: "Draft Title",
    content: "SECRET DRAFT PLAINTEXT",
    description: "desc",
    image: "img",
    category: "Other",
    tags: ["a"],
    price: 1,
    rating: 3,
    listingStatus: "draft",
    isActive: true,
    currentVersionIndex: 1,
    owner: { username: "alice", walletAddress: "gabc" },
    onChainReference: "ref",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  };

  const published = {
    ...draft,
    _id: "p1",
    title: "Published",
    listingStatus: "published",
    content: "published body",
  };

  it("public projection never includes content / draft plaintext", () => {
    const pub = toPublicPromptProjection(draft);
    expect(pub.content).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("SECRET DRAFT PLAINTEXT");
    expect(pub.title).toBe("Draft Title");
    expect(pub.owner).toEqual({
      username: "alice",
      walletAddress: "gabc",
    });
  });

  it("private projection includes content for authenticated creator", () => {
    const priv = toPrivatePromptProjection(draft);
    expect(priv.content).toBe("SECRET DRAFT PLAINTEXT");
    expect(priv.onChainReference).toBe("ref");
  });

  it("mapPromptsPublic drops drafts (draft leakage regression)", () => {
    const mapped = mapPromptsPublic([draft, published] as any[]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].id).toBe("p1");
    expect(JSON.stringify(mapped)).not.toContain("SECRET DRAFT PLAINTEXT");
    expect(mapped[0].content).toBeUndefined();
  });

  it("mapPromptsPrivate keeps drafts with content", () => {
    const mapped = mapPromptsPrivate([draft] as any[]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].content).toBe("SECRET DRAFT PLAINTEXT");
  });
});

describe("recordCreatorPrivacyAudit", () => {
  it("emits hashed wallet fields and never raw addresses in warn path", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    recordCreatorPrivacyAudit({
      event: "creator_private_read_denied",
      result: "blocked",
      walletAddress: "GCREATORAAAAAAAA",
      targetWallet: "GVICTIMAAAAAAAAA",
      reason: "wallet_mismatch",
    });
    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.walletHash).toEqual(expect.any(String));
    expect(payload.targetWalletHash).toEqual(expect.any(String));
    expect(JSON.stringify(payload)).not.toContain("GCREATOR");
    expect(JSON.stringify(payload)).not.toContain("GVICTIM");
    spy.mockRestore();
  });
});
