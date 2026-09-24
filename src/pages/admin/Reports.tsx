import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertCircle, Loader2, CheckCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ReportClient,
  type PromptReport,
  type ReportStatus,
} from "@/lib/reports/reportClient";

export default function AdminReportsPage() {
  const queryClient = useQueryClient();
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [actionError, setActionError] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReportStatus | "">("pending");

  const { data: reports = [], isLoading, error } = useQuery({
    queryKey: ["admin-reports", selectedPromptId, statusFilter],
    queryFn: async () => {
      const adminToken = localStorage.getItem("adminToken");
      if (!adminToken) return [];
      return ReportClient.getPromptReports(
        selectedPromptId || undefined,
        statusFilter || undefined,
      );
    },
  });

  const selectedReport = reports.find(
    (r) => String(r.id || r._id) === selectedReportId,
  );

  const updateStatus = useMutation({
    mutationFn: async (status: ReportStatus) => {
      if (!selectedReportId) throw new Error("Select a report first");
      const actor =
        localStorage.getItem("adminWallet") ||
        localStorage.getItem("adminToken") ||
        "admin";
      return ReportClient.updateReportStatus(selectedReportId, status, actor, {
        adminNotes,
        notes: adminNotes || undefined,
      });
    },
    onSuccess: () => {
      setActionError("");
      queryClient.invalidateQueries({ queryKey: ["admin-reports"] });
    },
    onError: (err: Error) => {
      setActionError(err.message || "Failed to update status");
    },
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      case "investigating":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      case "resolved":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "dismissed":
        return "bg-slate-500/10 text-slate-400 border-slate-500/20";
      default:
        return "bg-white/5 text-slate-300 border-white/10";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending":
        return <Clock className="h-4 w-4" />;
      case "resolved":
      case "dismissed":
        return <CheckCircle className="h-4 w-4" />;
      default:
        return <AlertCircle className="h-4 w-4" />;
    }
  };

  const reportKey = (report: PromptReport) => String(report.id || report._id);

  return (
    <div className="min-h-screen bg-[#020617] text-white p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Prompt Reports</h1>
        <p className="text-slate-400 mb-8">
          Review abuse reports, inspect evidence references, and update
          moderation status
        </p>

        {!localStorage.getItem("adminToken") && (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 mb-8">
            <p className="text-sm">Admin authentication required to view reports.</p>
          </div>
        )}

        <div className="flex flex-wrap gap-3 mb-6">
          <input
            value={selectedPromptId}
            onChange={(e) => setSelectedPromptId(e.target.value.trim())}
            placeholder="Filter by promptId (optional)"
            className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white"
          />
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as ReportStatus | "")
            }
            className="px-3 py-2 rounded-lg border border-white/10 bg-slate-950 text-sm text-white"
          >
            <option value="">All statuses</option>
            <option value="pending">pending</option>
            <option value="investigating">investigating</option>
            <option value="resolved">resolved</option>
            <option value="dismissed">dismissed</option>
          </select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-xl font-semibold mb-4">Reports Queue</h2>

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : error ? (
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                Failed to load reports
              </div>
            ) : reports.length === 0 ? (
              <div className="text-center py-12">
                <CheckCircle className="h-12 w-12 text-emerald-500 mx-auto mb-4" />
                <p className="text-slate-400">No reports to review</p>
              </div>
            ) : (
              reports.map((report) => {
                const id = reportKey(report);
                return (
                  <div
                    key={id}
                    className={`p-4 rounded-lg border bg-white/5 hover:bg-white/[0.08] transition-all cursor-pointer ${
                      selectedReportId === id
                        ? "border-emerald-500/40"
                        : "border-white/10"
                    }`}
                    onClick={() => setSelectedReportId(id)}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          Prompt #{report.promptId}
                        </p>
                        <p className="text-xs text-slate-500">
                          {new Date(report.createdAt).toLocaleDateString()} ·{" "}
                          {report.reporterAddress}
                        </p>
                      </div>
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium border flex items-center gap-1 ${getStatusColor(
                          report.status || "pending",
                        )}`}
                      >
                        {getStatusIcon(report.status || "pending")}
                        {report.status || "pending"}
                      </span>
                    </div>
                    <div className="mb-2">
                      <p className="text-xs text-slate-400 mb-1">Reason</p>
                      <p className="text-sm text-slate-300">{report.reason}</p>
                    </div>
                    {report.description && (
                      <div className="mb-2">
                        <p className="text-xs text-slate-400 mb-1">Description</p>
                        <p className="text-xs text-slate-300 line-clamp-2">
                          {report.description}
                        </p>
                      </div>
                    )}
                    {report.evidence && report.evidence.length > 0 && (
                      <div>
                        <p className="text-xs text-slate-400 mb-1">
                          Evidence ({report.evidence.length})
                        </p>
                        <ul className="space-y-1">
                          {report.evidence.map((ev, i) => (
                            <li
                              key={`${ev.kind}-${i}`}
                              className="text-xs text-slate-300 font-mono truncate"
                            >
                              [{ev.kind}] {ev.ref}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-6 p-6 rounded-lg border border-white/10 bg-white/5">
              <h3 className="text-lg font-semibold mb-4">Review Actions</h3>

              {selectedReport ? (
                <div className="space-y-4">
                  <div className="text-xs text-slate-400 space-y-1">
                    <p>
                      Status:{" "}
                      <span className="text-white">
                        {selectedReport.status || "pending"}
                      </span>
                    </p>
                    <p>
                      History entries:{" "}
                      {selectedReport.statusHistory?.length || 0}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-2">
                      Admin Notes
                    </label>
                    <textarea
                      value={adminNotes}
                      onChange={(e) => setAdminNotes(e.target.value)}
                      placeholder="Add notes about this report..."
                      className="w-full h-24 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white text-sm resize-none"
                    />
                  </div>

                  {actionError && (
                    <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                      {actionError}
                    </div>
                  )}

                  <div className="space-y-2">
                    <Button
                      className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate("investigating")}
                    >
                      Mark Investigating
                    </Button>
                    <Button
                      className="w-full bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-semibold"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate("resolved")}
                    >
                      Mark Resolved
                    </Button>
                    <Button
                      className="w-full bg-slate-600 hover:bg-slate-700 text-white font-semibold"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate("dismissed")}
                    >
                      Dismiss Report
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate("pending")}
                    >
                      Reopen as Pending
                    </Button>
                  </div>

                  <p className="text-xs text-slate-500 text-center">
                    Transitions are validated server-side and appended to the
                    audit history.
                  </p>
                </div>
              ) : (
                <p className="text-slate-400 text-sm">
                  Select a report to review actions
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
