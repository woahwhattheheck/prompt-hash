import { screen, waitFor } from "@testing-library/react";
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
});
