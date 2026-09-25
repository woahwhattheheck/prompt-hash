/**
 * Seller payout statements card — Issue #245.
 * Lists reconciled statements and offers CSV / JSON export.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Download,
  FileJson,
  FileSpreadsheet,
  Loader2,
  Receipt,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type StatementStatus = "pending" | "settled" | "failed";

export interface PayoutStatementSummary {
  statementId: string;
  sellerWallet: string;
  payoutAddress: string;
  period: { start: string; end: string };
  feeBps: number;
  grossStroops: number;
  platformFeeStroops: number;
  refundSellerDebitStroops: number;
  clawbackStroops: number;
  previousBalanceCarryoverStroops: number;
  netSettlementStroops: number;
  payableStroops: number;
  closingBalanceCarryoverStroops: number;
  status: StatementStatus;
  failureReason?: string;
  generatedAt: string;
}

interface PayoutStatementsCardProps {
  walletAddress: string;
}

const STROOPS_PER_XLM = 10_000_000;

function stroopsToXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7).replace(/\.?0+$/, (m) =>
    m.includes(".") ? "" : m,
  );
}

function statusBadgeClass(status: StatementStatus): string {
  switch (status) {
    case "settled":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    case "failed":
      return "bg-red-500/10 text-red-400 border-red-500/20";
    default:
      return "bg-amber-500/10 text-amber-300 border-amber-500/20";
  }
}

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function defaultMonthRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

export function PayoutStatementsCard({
  walletAddress,
}: PayoutStatementsCardProps) {
  const initialRange = useMemo(() => defaultMonthRange(), []);
  const [from, setFrom] = useState(initialRange.from.slice(0, 10));
  const [to, setTo] = useState(initialRange.to.slice(0, 10));
  const [statements, setStatements] = useState<PayoutStatementSummary[]>([]);
  const [preview, setPreview] = useState<PayoutStatementSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSaved = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/payouts/statements/${encodeURIComponent(walletAddress)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load statements");
      }
      setStatements(data.statements || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load statements");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const runPreview = async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const fromIso = new Date(from + "T00:00:00.000Z").toISOString();
      const toIso = new Date(to + "T23:59:59.999Z").toISOString();
      const qs = new URLSearchParams({ from: fromIso, to: toIso });
      const res = await fetch(
        `/api/payouts/statements/${encodeURIComponent(walletAddress)}?${qs}`,
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to preview statement");
      }
      setPreview(data.statement);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to preview statement",
      );
    } finally {
      setLoading(false);
    }
  };

  const persistPreview = async () => {
    if (!walletAddress || !preview) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payouts/statements/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerWallet: walletAddress,
          periodStart: preview.period.start,
          periodEnd: preview.period.end,
          persist: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save statement");
      }
      setPreview(data.statement);
      await loadSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save statement");
    } finally {
      setLoading(false);
    }
  };

  const exportStatement = async (
    statementId: string,
    format: "csv" | "json",
  ) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/payouts/statements/${encodeURIComponent(walletAddress)}/${encodeURIComponent(statementId)}/export?format=${format}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export failed");
      }
      const text = await res.text();
      downloadBlob(
        `${statementId}.${format}`,
        text,
        format === "csv" ? "text/csv;charset=utf-8" : "application/json",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  };

  const exportPreviewLocal = (format: "csv" | "json") => {
    if (!preview) return;
    if (format === "json") {
      downloadBlob(
        `${preview.statementId}.json`,
        JSON.stringify(preview, null, 2),
        "application/json",
      );
      return;
    }
    // Minimal CSV for unsaved preview
    const rows = [
      "field,value",
      `statementId,${preview.statementId}`,
      `feeBps,${preview.feeBps}`,
      `status,${preview.status}`,
      `grossStroops,${preview.grossStroops}`,
      `platformFeeStroops,${preview.platformFeeStroops}`,
      `refundSellerDebitStroops,${preview.refundSellerDebitStroops}`,
      `netSettlementStroops,${preview.netSettlementStroops}`,
      `payableStroops,${preview.payableStroops}`,
    ];
    downloadBlob(`${preview.statementId}.csv`, rows.join("\n"), "text/csv");
  };

  const renderStatement = (
    s: PayoutStatementSummary,
    opts: { persisted: boolean },
  ) => (
    <div
      key={s.statementId}
      className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3"
      data-testid="payout-statement-row"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-500">{s.statementId}</p>
          <p className="mt-1 text-sm text-slate-300">
            {new Date(s.period.start).toLocaleDateString()} –{" "}
            {new Date(s.period.end).toLocaleDateString()}
          </p>
        </div>
        <Badge className={statusBadgeClass(s.status)}>{s.status}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Gross</p>
          <p className="font-medium text-slate-100">
            {stroopsToXlm(s.grossStroops)} XLM
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Fees ({s.feeBps} bps)
          </p>
          <p className="font-medium text-slate-100">
            {stroopsToXlm(s.platformFeeStroops)} XLM
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Refunds / clawbacks
          </p>
          <p className="font-medium text-slate-100">
            {stroopsToXlm(s.refundSellerDebitStroops)} XLM
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Net</p>
          <p className="font-medium text-emerald-300">
            {stroopsToXlm(s.netSettlementStroops)} XLM
          </p>
        </div>
      </div>

      {s.status === "failed" && s.failureReason && (
        <p className="flex items-start gap-1.5 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {s.failureReason}
        </p>
      )}

      {s.closingBalanceCarryoverStroops < 0 && (
        <p className="text-xs text-amber-200/90">
          Carryover to next period:{" "}
          {stroopsToXlm(s.closingBalanceCarryoverStroops)} XLM
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-white/15 bg-white/[0.04] text-slate-100"
          onClick={() =>
            opts.persisted
              ? void exportStatement(s.statementId, "json")
              : exportPreviewLocal("json")
          }
        >
          <FileJson className="h-3.5 w-3.5" />
          JSON
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-white/15 bg-white/[0.04] text-slate-100"
          onClick={() =>
            opts.persisted
              ? void exportStatement(s.statementId, "csv")
              : exportPreviewLocal("csv")
          }
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          CSV
        </Button>
        {!opts.persisted && (
          <Button
            type="button"
            size="sm"
            className="bg-emerald-400 text-slate-950 hover:bg-emerald-300"
            onClick={() => void persistPreview()}
            disabled={loading}
          >
            <Download className="h-3.5 w-3.5" />
            Save statement
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Card className="border-white/10 bg-white/[0.03]" data-testid="payout-statements-card">
      <CardContent className="p-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Receipt className="h-5 w-5 text-cyan-200" />
            Payout Statements
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Reconcile gross sales, platform fees (DEFAULT_FEE_BPS from the
            Prompt Hash contract), refunds, and net settlement. Export CSV or
            JSON for any period.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="stmt-from" className="text-xs text-slate-400">
              From
            </label>
            <Input
              id="stmt-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border-white/10 bg-white/[0.04] text-slate-100"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="stmt-to" className="text-xs text-slate-400">
              To
            </label>
            <Input
              id="stmt-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border-white/10 bg-white/[0.04] text-slate-100"
            />
          </div>
          <Button
            type="button"
            onClick={() => void runPreview()}
            disabled={loading || !walletAddress}
            className="h-10 bg-cyan-400 text-slate-950 hover:bg-cyan-300"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Preview period"
            )}
          </Button>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}

        {preview && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              Period preview
            </p>
            {renderStatement(preview, { persisted: false })}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Saved statements
          </p>
          {loading && statements.length === 0 && !preview ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : statements.length === 0 ? (
            <p className="text-sm text-slate-500">
              No saved statements yet. Preview a period and save it to build
              your history.
            </p>
          ) : (
            <div className="space-y-3">
              {statements.map((s) => renderStatement(s, { persisted: true }))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default PayoutStatementsCard;
