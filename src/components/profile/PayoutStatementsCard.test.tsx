import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders } from "@/test/render";
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
