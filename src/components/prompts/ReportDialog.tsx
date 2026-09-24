import { useState } from "react";
import {
  AlertCircle,
  X,
  Loader2,
  CheckCircle,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ReportClient,
  REPORT_REASONS,
  EVIDENCE_KIND_LABELS,
  EVIDENCE_KINDS,
  type ReportReason,
  type EvidenceRef,
} from "@/lib/reports/reportClient";

export interface ReportDialogProps {
  promptId: string;
  isOpen: boolean;
  onClose: () => void;
  userAddress?: string;
}

type DialogStage = "form" | "submitting" | "success";

const emptyEvidence = (): EvidenceRef => ({
  kind: "content_hash",
  ref: "",
  note: "",
});

export function ReportDialog({
  promptId,
  isOpen,
  onClose,
  userAddress,
}: ReportDialogProps) {
  const [stage, setStage] = useState<DialogStage>("form");
  const [selectedReason, setSelectedReason] = useState<ReportReason | "">(
    "",
  );
  const [description, setDescription] = useState("");
  const [evidenceItems, setEvidenceItems] = useState<EvidenceRef[]>([]);
  const [reporterPrivate, setReporterPrivate] = useState(true);
  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setStage("form");
    setSelectedReason("");
    setDescription("");
    setEvidenceItems([]);
    setReporterPrivate(true);
    setError("");
  };

  const handleSubmit = async () => {
    setError("");

    if (!selectedReason) {
      setError("Please select a reason");
      return;
    }

    if (!userAddress) {
      setError("Please connect your wallet");
      return;
    }

    setIsSubmitting(true);
    setStage("submitting");

    try {
      const evidence = evidenceItems
        .map((item) => ({
          kind: item.kind,
          ref: item.ref.trim(),
          note: item.note?.trim() || undefined,
        }))
        .filter((item) => item.ref.length > 0);

      await ReportClient.submitReport(
        promptId,
        userAddress,
        selectedReason as ReportReason,
        description,
        evidence,
        reporterPrivate,
      );

      setStage("success");
      setTimeout(() => {
        onClose();
        resetForm();
      }, 2000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to submit report",
      );
      setStage("form");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full text-slate-400 hover:text-white transition-colors"
          aria-label="Close report dialog"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="p-6 sm:p-8">
          {stage === "form" && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                  <h2 className="text-xl font-bold text-white">Report Prompt</h2>
                </div>
                <p className="text-sm text-slate-400">
                  Report stolen, harmful, broken, or malicious prompts. Attach
                  evidence references only — never paste private keys, emails,
                  or full prompt bodies.
                </p>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  What's the issue?
                </label>
                <div className="space-y-2">
                  {Object.entries(REPORT_REASONS).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedReason(key as ReportReason)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                        selectedReason === key
                          ? "border-emerald-500/50 bg-emerald-500/10"
                          : "border-white/10 bg-white/5 hover:bg-white/[0.08]"
                      }`}
                    >
                      <div
                        className={`h-4 w-4 rounded border-2 flex items-center justify-center ${
                          selectedReason === key
                            ? "border-emerald-500 bg-emerald-500"
                            : "border-white/20"
                        }`}
                      >
                        {selectedReason === key && (
                          <div className="h-2 w-2 bg-white rounded-full" />
                        )}
                      </div>
                      <span className="text-sm text-white flex-1">{label}</span>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="report-description"
                  className="text-xs font-semibold uppercase tracking-wider text-slate-400"
                >
                  Additional details (optional)
                </label>
                <textarea
                  id="report-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Please provide any additional information..."
                  maxLength={500}
                  className="w-full h-24 px-4 py-3 rounded-lg border border-white/10 bg-white/5 text-white placeholder:text-slate-500 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
                <p className="text-xs text-slate-500 text-right">
                  {description.length}/500
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Evidence references (optional)
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={evidenceItems.length >= 5}
                    onClick={() =>
                      setEvidenceItems((prev) => [...prev, emptyEvidence()])
                    }
                    className="h-7 text-xs"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  Allowed: content/screenshot hashes, IPFS CIDs, https URLs, tx
                  hashes. Max 5 items.
                </p>
                {evidenceItems.map((item, index) => (
                  <div
                    key={index}
                    className="space-y-2 p-3 rounded-lg border border-white/10 bg-white/5"
                  >
                    <div className="flex gap-2">
                      <select
                        value={item.kind}
                        onChange={(e) => {
                          const kind = e.target
                            .value as EvidenceRef["kind"];
                          setEvidenceItems((prev) =>
                            prev.map((row, i) =>
                              i === index ? { ...row, kind } : row,
                            ),
                          );
                        }}
                        className="flex-1 px-2 py-1.5 rounded border border-white/10 bg-slate-950 text-sm text-white"
                      >
                        {EVIDENCE_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {EVIDENCE_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label="Remove evidence"
                        onClick={() =>
                          setEvidenceItems((prev) =>
                            prev.filter((_, i) => i !== index),
                          )
                        }
                        className="p-2 text-slate-400 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <input
                      value={item.ref}
                      onChange={(e) =>
                        setEvidenceItems((prev) =>
                          prev.map((row, i) =>
                            i === index
                              ? { ...row, ref: e.target.value }
                              : row,
                          ),
                        )
                      }
                      placeholder="Hash, CID, https URL, or tx hash"
                      className="w-full px-3 py-2 rounded border border-white/10 bg-slate-950 text-sm text-white placeholder:text-slate-500"
                    />
                    <input
                      value={item.note || ""}
                      onChange={(e) =>
                        setEvidenceItems((prev) =>
                          prev.map((row, i) =>
                            i === index
                              ? { ...row, note: e.target.value }
                              : row,
                          ),
                        )
                      }
                      placeholder="Short note (optional, max 200)"
                      maxLength={200}
                      className="w-full px-3 py-2 rounded border border-white/10 bg-slate-950 text-sm text-white placeholder:text-slate-500"
                    />
                  </div>
                ))}
              </div>

              <label className="flex items-start gap-3 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reporterPrivate}
                  onChange={(e) => setReporterPrivate(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  Keep my wallet pseudonymous outside admin triage (recommended)
                </span>
              </label>

              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                  {error}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={onClose}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!selectedReason || isSubmitting}
                  className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                >
                  Submit Report
                </Button>
              </div>
            </div>
          )}

          {stage === "submitting" && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4 text-center">
              <div className="relative">
                <Loader2 className="h-12 w-12 text-amber-500 animate-spin" />
                <div className="absolute inset-0 blur-xl bg-amber-500/20" />
              </div>
              <p className="text-white font-semibold">Submitting report...</p>
              <p className="text-sm text-slate-400">
                Please wait while we process your report
              </p>
            </div>
          )}

          {stage === "success" && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4 text-center animate-in fade-in zoom-in">
              <div className="p-3 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle className="h-8 w-8 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Report Received</h3>
                <p className="text-sm text-slate-400 mt-1">
                  Thank you for helping us maintain quality. Our team will review
                  this promptly.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
