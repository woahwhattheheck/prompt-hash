/**
 * Express webhook adapter smoke tests (#184).
 *
 * Domain logic is covered by src/lib/domain/crossAdapterContract.test.ts.
 * Here we only assert the thin controller wires requests into the domain.
 */

const sendDomainResult = jest.fn((_res: any, result: any) => {
  _res.status(result.status).json(result.body);
  return _res;
});

const registerWebhookSubscription = jest.fn();
const getWebhookSubscription = jest.fn();
const deleteWebhookSubscription = jest.fn();
const ensureWebhookDb = jest.fn();
const createWebhookDomainDeps = jest.fn(() => ({ mocked: true }));

jest.mock("../../../src/lib/domain/domainResult", () => ({
  sendDomainResult,
}));

jest.mock("../../../src/lib/domain/webhookDomain", () => ({
  registerWebhookSubscription,
  getWebhookSubscription,
  deleteWebhookSubscription,
}));

jest.mock("../../../src/lib/domain/webhookDeps", () => ({
  ensureWebhookDb,
  createWebhookDomainDeps,
}));

import { RegisterWebhook, GetWebhook, DeleteWebhook } from "./webhookControllers";

const mockReq = (opts: any) =>
  ({
    body: opts.body || {},
    query: opts.query || {},
    headers: opts.headers || {},
  }) as any;

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockImplementation((code: number) => {
    res._status = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((payload: any) => {
    res._json = payload;
    return res;
  });
  return res;
};

describe("webhookControllers thin adapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createWebhookDomainDeps.mockReturnValue({ mocked: true });
  });

  it("RegisterWebhook forwards to domain and sends result", async () => {
    registerWebhookSubscription.mockResolvedValue({
      status: 401,
      body: { error: "Unauthorized: signed ownership proof required." },
    });
    const req = mockReq({ body: { url: "https://example.com/hook" } });
    const res = mockRes();
    await RegisterWebhook(req, res as any);
    expect(ensureWebhookDb).toHaveBeenCalled();
    expect(registerWebhookSubscription).toHaveBeenCalled();
    expect(sendDomainResult).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ status: 401 }),
    );
  });

  it("RegisterWebhook returns domain success", async () => {
    registerWebhookSubscription.mockResolvedValue({
      status: 201,
      body: { message: "Webhook registered.", id: "1", secret: "s" },
    });
    const req = mockReq({
      body: {
        url: "https://example.com/hook",
        walletAddress: "GABC",
        signedMessage: "sig",
        timestamp: 1,
      },
    });
    const res = mockRes();
    await RegisterWebhook(req, res as any);
    expect(sendDomainResult).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ status: 201 }),
    );
  });

  it("GetWebhook forwards to domain", async () => {
    getWebhookSubscription.mockResolvedValue({
      status: 401,
      body: { error: "Unauthorized: signed ownership proof required." },
    });
    const req = mockReq({ query: {} });
    const res = mockRes();
    await GetWebhook(req, res as any);
    expect(getWebhookSubscription).toHaveBeenCalled();
    expect(sendDomainResult).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ status: 401 }),
    );
  });

  it("DeleteWebhook forwards to domain", async () => {
    deleteWebhookSubscription.mockResolvedValue({
      status: 200,
      body: { message: "Webhook removed." },
    });
    const req = mockReq({
      body: { walletAddress: "GABC", signedMessage: "sig", timestamp: 1 },
    });
    const res = mockRes();
    await DeleteWebhook(req, res as any);
    expect(deleteWebhookSubscription).toHaveBeenCalled();
    expect(sendDomainResult).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ status: 200 }),
    );
  });
});
