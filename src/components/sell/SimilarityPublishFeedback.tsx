import { AlertCircle, CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { PublishSimilarityResult } from "@/lib/prompts/similarityPublish";

interface SimilarityPublishFeedbackProps {
  result: PublishSimilarityResult | null;
  checking?: boolean;
}

export function SimilarityPublishFeedback({
  result,
  checking = false,
}: SimilarityPublishFeedbackProps) {
  if (checking) {
    return (
      <div
        className="rounded-2xl border border-slate-400/20 bg-slate-500/10 px-4 py-3 text-sm text-slate-200"
        role="status"
        aria-live="polite"
      >
        Running similarity check against existing listings…
      </div>
    );
  }

  if (!result) return null;

  const { decision, feedback } = result;

  const styles =
    decision === "block"
      ? {
          border: "border-red-400/20",
          bg: "bg-red-500/10",
          title: "text-red-200",
          body: "text-red-100/90",
          icon: <XCircle className="h-5 w-5 text-red-400 shrink-0" />,
        }
      : decision === "review"
        ? {
            border: "border-amber-400/20",
            bg: "bg-amber-500/10",
            title: "text-amber-100",
            body: "text-amber-50/90",
            icon: <AlertCircle className="h-5 w-5 text-amber-400 shrink-0" />,
          }
        : {
            border: "border-emerald-400/20",
            bg: "bg-emerald-500/10",
            title: "text-emerald-100",
            body: "text-emerald-50/90",
            icon: <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />,
          };

  return (
    <div
      className={`rounded-2xl border ${styles.border} ${styles.bg} px-4 py-4 space-y-2`}
      role="region"
      aria-label="Similarity publish feedback"
    >
      <div className="flex items-start gap-2">
        {styles.icon}
        <div className="space-y-1">
          <p className={`text-sm font-semibold ${styles.title}`}>{feedback.title}</p>
          <p className={`text-sm ${styles.body}`}>{feedback.summary}</p>
          {result.overridden ? (
            <p className="text-xs text-slate-300 flex items-center gap-1 pt-1">
              <ShieldAlert className="h-3.5 w-3.5" />
              Maintainer override applied — prior decision retained in the audit trail.
            </p>
          ) : null}
        </div>
      </div>
      {feedback.actions.length > 0 ? (
        <ul className="list-disc pl-7 space-y-1 text-sm text-slate-200/90">
          {feedback.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
