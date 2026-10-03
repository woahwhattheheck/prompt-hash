import Prompt from "../models/Prompt";
import Appeal from "../models/Appeal";
import {
  applyMaintainerOverride,
  flagToDecision,
  withOverride,
  type PublicationDecision,
  type SimilarityFlag,
  type SimilarityOverrideRecord,
} from "./similarityDetection";

export class SimilarityOverrideError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SimilarityOverrideError";
  }
}

type StoredOverride = SimilarityOverrideRecord & {
  appealId?: string;
  appealPreviousVersion?: number;
  appealPreviousUpdatedAt?: Date;
};

const decisions: PublicationDecision[] = ["allow", "review", "block"];
const flags: SimilarityFlag[] = ["clean", "suspicious", "highly_similar"];

function storedVersion(value: unknown): number {
  // Existing documents predate the version field; new documents default to 1.
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw new SimilarityOverrideError(409, "Stored decision version is invalid");
  }
  return value as number;
}

function observed(value: unknown): unknown {
  if (value === undefined) return { $exists: false };
  if (value === null) return { $eq: null, $exists: true };
  return value;
}

/**
 * The Prompt record is authoritative. An optional Appeal is a projection of
 * that durable record, guarded against concurrent appeal review. Replaying the
 * same committed override can repair a transient mirror failure without adding
 * another decision or audit entry.
 */
async function mirrorAppeal(override: StoredOverride) {
  if (!override.appealId) return undefined;
  try {
    const match = {
      _id: override.appealId,
      promptId: override.promptId,
    };
    const mirrored = await Appeal.findOneAndUpdate(
      {
        ...match,
        decisionVersion: observed(override.appealPreviousVersion),
        updatedAt: observed(override.appealPreviousUpdatedAt),
        "previousDecisions.decisionVersion": { $ne: override.decisionVersion },
      },
      {
        $push: { previousDecisions: override },
        $set: {
          status: override.newDecision === "allow" ? "rejected" : "upheld",
          resolvedAt: new Date(override.at),
          decisionVersion: override.decisionVersion,
          reasonCode: "similarity_override",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).lean();
    if (mirrored) return { id: override.appealId, status: "synced" as const };

    // A retry after an ambiguous write may find the exact audit already there.
    const existing = await Appeal.findOne({
      ...match,
      previousDecisions: { $elemMatch: {
        decisionVersion: override.decisionVersion,
        actorAddress: override.actorAddress,
        at: override.at,
      } },
    }).lean();
    return {
      id: override.appealId,
      status: existing ? "synced" as const : "conflict" as const,
    };
  } catch {
    // Do not claim rollback: the decision and its required audit are committed.
    return { id: override.appealId, status: "pending" as const };
  }
}

export async function overridePromptSimilarity(
  input: { promptId?: unknown; newDecision?: unknown; reason?: unknown; appealId?: unknown },
  verifiedActor: string,
) {
  const { promptId, newDecision, reason, appealId } = input;
  if (
    !((typeof promptId === "string" && promptId.trim()) ||
      (typeof promptId === "number" && Number.isSafeInteger(promptId) && promptId >= 0)) ||
    typeof reason !== "string" || !reason.trim() ||
    typeof newDecision !== "string" || !decisions.includes(newDecision as PublicationDecision)
  ) {
    throw new SimilarityOverrideError(400, "promptId, newDecision (allow, review, block), and reason are required");
  }
  if (appealId !== undefined && (typeof appealId !== "string" || !/^[a-f\d]{24}$/i.test(appealId))) {
    throw new SimilarityOverrideError(400, "appealId must be a valid appeal id");
  }

  const id = String(promptId);
  const prompt = await Prompt.findOne({ onChainId: id }).lean();
  if (!prompt) throw new SimilarityOverrideError(404, "Prompt not found");
  const currentFlag = prompt.similarityFlag as SimilarityFlag;
  if (
    !flags.includes(currentFlag) ||
    typeof prompt.similarityScore !== "number" ||
    !Number.isFinite(prompt.similarityScore) ||
    prompt.similarityScore < 0 || prompt.similarityScore > 1 ||
    !prompt.similarityCheckedAt ||
    !Number.isFinite(new Date(prompt.similarityCheckedAt).getTime())
  ) {
    throw new SimilarityOverrideError(409, "Prompt needs a stored similarity decision before override");
  }
  const version = storedVersion(prompt.similarityDecisionVersion);
  const previousDecision = flagToDecision(currentFlag);
  const linkedId = typeof appealId === "string" ? appealId.toLowerCase() : undefined;
  const appeal = linkedId ? await Appeal.findOne({ _id: linkedId, promptId: id }).lean() : undefined;
  if (linkedId && !appeal) throw new SimilarityOverrideError(404, "Appeal not found for this prompt");

  let override: StoredOverride;
  let replayed = false;
  if (previousDecision === newDecision) {
    const last = prompt.similarityOverrides?.at(-1) as StoredOverride | undefined;
    if (
      !linkedId || !last || last.appealId !== linkedId ||
      last.actorAddress !== verifiedActor || last.reason !== reason.trim() ||
      last.newDecision !== newDecision || last.decisionVersion !== version ||
      new Date(last.at).getTime() !== new Date(prompt.similarityCheckedAt).getTime()
    ) {
      throw new SimilarityOverrideError(400, "Override must change the publication decision");
    }
    override = last;
    replayed = true;
  } else {
    override = {
      ...applyMaintainerOverride({
        promptId: id,
        actorAddress: verifiedActor,
        previousDecision,
        newDecision: newDecision as PublicationDecision,
        reason,
        score: prompt.similarityScore,
        similarTo: prompt.similarTo,
        previousVersion: Math.max(version, appeal ? storedVersion(appeal.decisionVersion) : version),
      }),
      // The shared legacy pure helper normalizes wallet addresses. Verified
      // principal subjects are opaque, case-sensitive identifiers instead.
      actorAddress: verifiedActor,
      ...(linkedId ? {
        appealId: linkedId,
        appealPreviousVersion: appeal.decisionVersion,
        appealPreviousUpdatedAt: appeal.updatedAt,
      } : {}),
    };

    const filter: Record<string, unknown> = { _id: prompt._id, onChainId: id };
    // Scans currently do not advance the override version. Include their state
    // and identity so a scan/review arriving after our read cannot be replaced.
    for (const field of [
      "similarityDecisionVersion", "similarityFlag", "similarityScore", "similarTo",
      "similarityCheckedAt", "similarityScanStatus", "similarityScanJobId", "updatedAt",
    ]) filter[field] = observed(prompt[field]);

    const updated = await Prompt.findOneAndUpdate(filter, {
      $set: {
        similarityFlag: newDecision === "block" ? "highly_similar" : newDecision === "review" ? "suspicious" : "clean",
        similarTo: newDecision === "allow" ? null : prompt.similarTo ?? null,
        similarityCheckedAt: new Date(override.at),
        similarityDecisionVersion: override.decisionVersion,
      },
      $push: { similarityOverrides: override },
    }, { returnDocument: "after", runValidators: true }).lean();
    if (!updated) throw new SimilarityOverrideError(409, "Similarity decision changed; reload before overriding");
  }

  const result = withOverride({
    flag: currentFlag,
    score: override.score,
    similarTo: override.similarTo,
    decision: override.previousDecision,
    feedback: {
      decision: override.previousDecision,
      title: "", summary: "", actions: [],
      scorePercent: Math.round(override.score * 100),
      similarTo: override.similarTo,
    },
  }, override);
  const appealSync = await mirrorAppeal(override);
  return { override, result, replayed, ...(appealSync ? { appealSync } : {}) };
}
