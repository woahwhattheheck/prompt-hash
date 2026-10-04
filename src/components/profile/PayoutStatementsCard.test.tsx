// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render as renderWithProviders, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PayoutStatementsCard } from "./PayoutStatementsCard";

const wallet = "GCREATORTESTWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("PayoutStatementsCard", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/export")) {
          return new Response("statementId,stmt_1\n", {
            status: 200,
            headers: { "Content-Type": "text/csv" },
          });
        }
        if (url.includes("from=")) {
          return Response.json({
            statement: {
              statementId: "stmt_preview",
              sellerWallet: wallet.toLowerCase(),
              payoutAddress: wallet.toLowerCase(),
              period: {
                start: "2026-01-01T00:00:00.000Z",
                end: "2026-01-31T23:59:59.999Z",
              },
              feeBps: 500,
              grossStroops: 100_000_000,
              platformFeeStroops: 5_000_000,
              refundSellerDebitStroops: 0,
              clawbackStroops: 0,
              previousBalanceCarryoverStroops: 0,
              netSettlementStroops: 95_000_000,
              payableStroops: 95_000_000,
              closingBalanceCarryoverStroops: 0,
              status: "pending",
              generatedAt: "2026-02-01T00:00:00.000Z",
            },
          });
        }
        return Response.json({
          statements: [
            {
              statementId: "stmt_saved",
              sellerWallet: wallet.toLowerCase(),
              payoutAddress: wallet.toLowerCase(),
              period: {
                start: "2025-12-01T00:00:00.000Z",
                end: "2025-12-31T23:59:59.999Z",
              },
              feeBps: 500,
              grossStroops: 50_000_000,
              platformFeeStroops: 2_500_000,
              refundSellerDebitStroops: 0,
              clawbackStroops: 0,
              previousBalanceCarryoverStroops: 0,
              netSettlementStroops: 47_500_000,
              payableStroops: 47_500_000,
              closingBalanceCarryoverStroops: 0,
              status: "failed",
              failureReason: "Destination account not funded",
              generatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists saved statements with pending/failed status badges", async () => {
    renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);

    await waitFor(() => {
      expect(screen.getByTestId("payout-statements-card")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("stmt_saved")).toBeInTheDocument();
    });
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(
      screen.getByText("Destination account not funded"),
    ).toBeInTheDocument();
  });

  it("previews a period reconciliation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /preview period/i })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /preview period/i }));

    await waitFor(() => {
      expect(screen.getByText("stmt_preview")).toBeInTheDocument();
    });
    expect(screen.getByText(/period preview/i)).toBeInTheDocument();
    expect(screen.getAllByText(/fees \(500 bps\)/i).length).toBeGreaterThanOrEqual(1);
  });

  it.each(["From", "To"])("invalidates the period preview when %s changes", async (label) => {
    const user = userEvent.setup();
    renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    await screen.findByText("stmt_saved");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-31" } });
    await user.click(screen.getByRole("button", { name: /preview period/i }));
    await screen.findByText("stmt_preview");

    fireEvent.change(screen.getByLabelText(label), { target: { value: "2026-01-15" } });

    expect(screen.queryByText("stmt_preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save statement/i })).not.toBeInTheDocument();
    expect(screen.getByText("stmt_saved")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("locks period edits during refresh and does not revive a preview after failure", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    await screen.findByText("stmt_saved");
    await user.click(screen.getByRole("button", { name: /preview period/i }));
    await screen.findByText("stmt_preview");

    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await user.click(screen.getByRole("button", { name: /preview period/i }));
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(screen.getByLabelText("To")).toBeDisabled();
    expect(screen.queryByText("stmt_preview")).not.toBeInTheDocument();

    await act(async () => {
      resolve(Response.json({ error: "Preview unavailable" }, { status: 503 }));
    });
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeEnabled();
    expect(screen.getByLabelText("To")).toBeEnabled();
    expect(screen.queryByRole("button", { name: /save statement/i })).not.toBeInTheDocument();
    expect(screen.getByText("stmt_saved")).toBeInTheDocument();
  });

  it.each([
    {
      name: "maximum safe gross",
      grossStroops: 9_007_199_254_740_991,
      platformFeeStroops: 450_359_962_737_049,
      previousBalanceCarryoverStroops: 0,
      netSettlementStroops: 8_556_839_292_003_942,
      grossText: "900719925.4740991",
      netText: "855683929.2003942",
      carryoverText: null,
    },
    {
      name: "large gross with a three-stroop fraction",
      grossStroops: 9_007_199_250_000_003,
      platformFeeStroops: 450_359_962_500_000,
      previousBalanceCarryoverStroops: 0,
      netSettlementStroops: 8_556_839_287_500_003,
      grossText: "900719925.0000003",
      netText: "855683928.7500003",
      carryoverText: null,
    },
    {
      name: "minimum safe carryover",
      grossStroops: 0,
      platformFeeStroops: 0,
      previousBalanceCarryoverStroops: -9_007_199_254_740_991,
      netSettlementStroops: -9_007_199_254_740_991,
      grossText: "0",
      netText: "-900719925.4740991",
      carryoverText: "-900719925.4740991",
    },
    {
      name: "negative carryover with a three-stroop fraction",
      grossStroops: 0,
      platformFeeStroops: 0,
      previousBalanceCarryoverStroops: -9_007_199_250_000_003,
      netSettlementStroops: -9_007_199_250_000_003,
      grossText: "0",
      netText: "-900719925.0000003",
      carryoverText: "-900719925.0000003",
    },
  ])("displays exact XLM for $name", async (testCase) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        statements: [
          {
            statementId: "stmt_exact",
            sellerWallet: wallet.toLowerCase(),
            payoutAddress: wallet.toLowerCase(),
            period: {
              start: "2026-01-01T00:00:00.000Z",
              end: "2026-01-31T23:59:59.999Z",
            },
            feeBps: 500,
            grossStroops: testCase.grossStroops,
            platformFeeStroops: testCase.platformFeeStroops,
            refundSellerDebitStroops: 0,
            clawbackStroops: 0,
            previousBalanceCarryoverStroops:
              testCase.previousBalanceCarryoverStroops,
            netSettlementStroops: testCase.netSettlementStroops,
            payableStroops: Math.max(testCase.netSettlementStroops, 0),
            closingBalanceCarryoverStroops: Math.min(
              testCase.netSettlementStroops,
              0,
            ),
            status: "pending",
            generatedAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );
    renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);

    const row = within(await screen.findByTestId("payout-statement-row"));
    expect(row.getByText("Gross").parentElement).toHaveTextContent(
      `${testCase.grossText} XLM`,
    );
    expect(row.getByText("Net").parentElement).toHaveTextContent(
      `${testCase.netText} XLM`,
    );
    if (testCase.carryoverText !== null) {
      expect(row.getByText(/carryover to next period:/i)).toHaveTextContent(
        `Carryover to next period: ${testCase.carryoverText} XLM`,
      );
    } else {
      expect(row.queryByText(/carryover to next period:/i)).toBeNull();
    }
  });
});


describe("PayoutStatementsCard wallet isolation", () => {
  const otherWallet = "GOTHERTESTWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

  function statement(statementId: string, sellerWallet: string) {
    return {
      statementId, sellerWallet, payoutAddress: sellerWallet,
      period: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.999Z" },
      feeBps: 500, grossStroops: 100_000_000, platformFeeStroops: 5_000_000,
      refundSellerDebitStroops: 0, clawbackStroops: 0,
      previousBalanceCarryoverStroops: 0, netSettlementStroops: 95_000_000,
      payableStroops: 95_000_000, closingBalanceCarryoverStroops: 0,
      status: "pending", generatedAt: "2026-02-01T00:00:00.000Z",
    };
  }

  function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("clears the previous wallet's saved rows and preview immediately", async () => {
    const next = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(otherWallet)) return next.promise;
      return url.includes("from=")
        ? Response.json({ statement: statement("preview_a", wallet) })
        : Response.json({ statements: [statement("saved_a", wallet)] });
    }));
    const user = userEvent.setup();
    const view = renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    await screen.findByText("saved_a");
    await user.click(screen.getByRole("button", { name: /preview period/i }));
    await screen.findByText("preview_a");
    view.rerender(<PayoutStatementsCard walletAddress={otherWallet} />);
    expect(screen.queryByText("saved_a")).not.toBeInTheDocument();
    expect(screen.queryByText("preview_a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save statement/i })).not.toBeInTheDocument();
    await act(async () => {
      next.resolve(Response.json({ statements: [statement("saved_b", otherWallet)] }));
    });
    await screen.findByText("saved_b");
  });

  it("ignores a saved-list response from a previous wallet generation", async () => {
    const previous = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return String(input).includes(otherWallet)
        ? Response.json({ statements: [statement("saved_b", otherWallet)] })
        : previous.promise;
    }));
    const view = renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    view.rerender(<PayoutStatementsCard walletAddress={otherWallet} />);
    await screen.findByText("saved_b");
    await act(async () => {
      previous.resolve(Response.json({ statements: [statement("late_saved_a", wallet)] }));
    });
    expect(screen.getByText("saved_b")).toBeInTheDocument();
    expect(screen.queryByText("late_saved_a")).not.toBeInTheDocument();
  });

  it("ignores a preview response that finishes after a wallet switch", async () => {
    const previous = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return String(input).includes("from=")
        ? previous.promise
        : Response.json({ statements: [] });
    }));
    const user = userEvent.setup();
    const view = renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /preview period/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /preview period/i }));
    view.rerender(<PayoutStatementsCard walletAddress={otherWallet} />);
    await act(async () => {
      previous.resolve(Response.json({ statement: statement("late_preview_a", wallet) }));
    });
    expect(screen.queryByText("late_preview_a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save statement/i })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("clears financial data on disconnect without requesting an empty wallet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ statements: [statement("saved_a", wallet)] })));
    const view = renderWithProviders(<PayoutStatementsCard walletAddress={wallet} />);
    await screen.findByText("saved_a");
    const requestsBefore = vi.mocked(fetch).mock.calls.length;
    view.rerender(<PayoutStatementsCard walletAddress="" />);
    expect(screen.queryByText("saved_a")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preview period/i })).toBeDisabled();
    expect(vi.mocked(fetch).mock.calls.length).toBe(requestsBefore);
  });
});
