/**
 * Client helpers for the publish-time similarity gate (Issue #242).
 */

export type PublicationDecision = "allow" | "review" | "block";

export interface CreatorFeedback {
  decision: PublicationDecision;
  title: string;
  summary: string;
  actions: string[];
  scorePercent: number;
  similarTo: string | null;
}

export interface PublishSimilarityResult {
  flag: "clean" | "suspicious" | "highly_similar";
  score: number;
  similarTo: string | null;
  decision: PublicationDecision;
  feedback: CreatorFeedback;
  overridden?: boolean;
}

export async function checkPublishSimilarity(input: {
  title: string;
  content: string;
  excludeOnChainId?: string;
}): Promise<PublishSimilarityResult> {
  const response = await fetch("/api/fingerprint/publish-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      excludeOnChainId: input.excludeOnChainId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text || `Similarity check failed (${response.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = String(parsed.error);
    } catch {
      // keep message
    }
    throw new Error(message);
  }

  return response.json() as Promise<PublishSimilarityResult>;
}
