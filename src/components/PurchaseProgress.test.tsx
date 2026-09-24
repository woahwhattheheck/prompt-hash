import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseProgress from "./PurchaseProgress";

const runPurchaseFlow = vi.fn();

vi.mock("@/lib/marketplace/marketplaceTx", () => ({
  runPurchaseFlow: (...args: unknown[]) => runPurchaseFlow(...args),
}));

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ address: "GBUYERTESTADDRESS" }),
}));

describe("PurchaseProgress (#154)", () => {
  beforeEach(() => {
    runPurchaseFlow.mockReset();
  });

  it("shows success only after authoritative flow success", async () => {
    runPurchaseFlow.mockImplementation(async (opts: { onEvent?: Function }) => {
      opts.onEvent?.({
        phase: "success",
        status: "success",
        message: "Access Granted! Your prompt is now unlocked.",
        txHash: "tx_demo_success_00000001",
      });
      return { success: true, txHash: "tx_demo_success_00000001" };
    });

    render(<PurchaseProgress />);
    expect(await screen.findByText("Access Granted")).toBeTruthy();
  });

  it("shows failure from authoritative flow error", async () => {
    runPurchaseFlow.mockImplementation(async (opts: { onEvent?: Function }) => {
      opts.onEvent?.({
        phase: "error",
        status: "error",
        message: "Transaction Failed: User rejected signature.",
      });
      throw new Error("user_rejected");
    });

    render(<PurchaseProgress />);

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/User rejected signature/i);
    });
    expect(
      screen.getByRole("button", { name: /Retry Purchase/i }),
    ).toBeTruthy();
  });

  it("retry re-invokes the purchase flow (reload-safe)", async () => {
    let calls = 0;
    runPurchaseFlow.mockImplementation(async (opts: { onEvent?: Function }) => {
      calls += 1;
      if (calls === 1) {
        opts.onEvent?.({
          phase: "error",
          status: "error",
          message: "Transaction Failed: network error or timeout.",
        });
        throw new Error("network_error");
      }
      opts.onEvent?.({
        phase: "success",
        status: "success",
        message: "Access Granted! Your prompt is now unlocked.",
        txHash: "tx_demo_success_00000001",
      });
      return { success: true, txHash: "tx_demo_success_00000001" };
    });

    render(<PurchaseProgress />);

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/network error or timeout/i);
    });

    await userEvent.click(
      screen.getByRole("button", { name: /Retry Purchase/i }),
    );

    expect(await screen.findByText("Access Granted")).toBeTruthy();
    expect(calls).toBe(2);
  });
});
