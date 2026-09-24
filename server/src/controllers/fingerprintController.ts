import { Request, Response } from "express";
import {
  createContentCommitment,
  verifyContentCommitment,
  createSimhashFingerprint,
  simhashSimilarity,
  hammingDistance,
  normalizePrompt,
  normalizeMultilingual,
  normalizeCodePrompt,
  verifyFingerprintAlgorithm,
  SUPPORTED_ALGORITHMS,
  FINGERPRINT_ALGORITHM_VERSION,
} from "../services/fingerprint";
import Prompt from "../models/Prompt";
import {
  scanForSimilarity,
  checkPublishSimilarity,
  applyMaintainerOverride,
  withOverride,
  flagToDecision,
  type PublicationDecision,
  type PublishSimilarityResult,
} from "../services/similarityDetection";
import Appeal from "../models/Appeal";


export async function computeFingerprint(req: Request, res: Response) {
  try {
    const { text, algorithmVersion } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const version = algorithmVersion ?? FINGERPRINT_ALGORITHM_VERSION;
    const result = createContentCommitment(text, version);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function verifyFingerprint(req: Request, res: Response) {
  try {
    const { text, commitment, algorithmVersion } = req.body;
    if (!text || !commitment) {
      return res.status(400).json({ error: "text and commitment are required" });
    }
    const valid = verifyContentCommitment(text, commitment, algorithmVersion);
    return res.json({ valid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function computeSimhash(req: Request, res: Response) {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const fingerprint = createSimhashFingerprint(text);
    return res.json({ fingerprint: fingerprint.toString(16), bits: 64 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function compareSimhash(req: Request, res: Response) {
  try {
    const { fingerprintA, fingerprintB } = req.body;
    if (!fingerprintA || !fingerprintB) {
      return res.status(400).json({ error: "fingerprintA and fingerprintB are required" });
    }
    const a = BigInt(`0x${fingerprintA}`);
    const b = BigInt(`0x${fingerprintB}`);
    const distance = hammingDistance(a, b);
    const similarity = simhashSimilarity(a, b);
    return res.json({ hammingDistance: distance, similarity });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(400).json({ error: "Invalid fingerprint format" });
  }
}

export async function scanSimilarity(req: Request, res: Response) {
  try {
    const { promptId, text } = req.body;
    if (!promptId || !text) {
      return res.status(400).json({ error: "promptId and text are required" });
    }
    const result = await scanForSimilarity(promptId, text);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function normalizeText(req: Request, res: Response) {
  try {
    const { text, mode } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    let normalized: string;
    switch (mode) {
      case "code":
        normalized = normalizeCodePrompt(text);
        break;
      case "multilingual":
        normalized = normalizeMultilingual(text);
        break;
      default:
        normalized = normalizePrompt(text);
    }
    return res.json({ normalized });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function listAlgorithms(_req: Request, res: Response) {
  return res.json({ algorithms: SUPPORTED_ALGORITHMS, currentVersion: FINGERPRINT_ALGORITHM_VERSION });
}

export async function checkPublishSimilarityHandler(req: Request, res: Response) {
  try {
    const { title, content, text, excludeOnChainId } = req.body ?? {};
    const body = typeof content === "string" ? content : typeof text === "string" ? text : "";
    const titleStr = typeof title === "string" ? title : "";
    const combined = `${titleStr} ${body}`.trim();
    if (!combined) {
      return res.status(400).json({ error: "title and/or content (or text) is required" });
    }
    const result = await checkPublishSimilarity(combined, {
      excludeOnChainId:
        typeof excludeOnChainId === "string" ? excludeOnChainId : undefined,
    });
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function overrideSimilarityDecision(req: Request, res: Response) {
  try {
    const {
      promptId,
      actorAddress,
      newDecision,
      reason,
      appealId,
      score,
      similarTo,
      previousDecision,
    } = req.body ?? {};

    if (!promptId || !actorAddress || !newDecision || !reason) {
      return res.status(400).json({
        error: "promptId, actorAddress, newDecision, and reason are required",
      });
    }

    const validDecisions: PublicationDecision[] = ["allow", "review", "block"];
    if (!validDecisions.includes(newDecision)) {
      return res.status(400).json({
        error: `newDecision must be one of: ${validDecisions.join(", ")}`,
      });
    }

    const prompt = await Prompt.findOne({ onChainId: String(promptId) }).lean();
    const currentFlag = (prompt as any)?.similarityFlag ?? "highly_similar";
    const resolvedPrevious: PublicationDecision =
      previousDecision && validDecisions.includes(previousDecision)
        ? previousDecision
        : flagToDecision(currentFlag);

    const override = applyMaintainerOverride({
      promptId: String(promptId),
      actorAddress: String(actorAddress),
      previousDecision: resolvedPrevious,
      newDecision,
      reason: String(reason),
      score:
        typeof score === "number"
          ? score
          : typeof (prompt as any)?.similarityScore === "number"
            ? (prompt as any).similarityScore
            : 0,
      similarTo:
        similarTo ?? (prompt as any)?.similarTo ?? null,
      previousVersion: 1,
    });

    const flag =
      newDecision === "block"
        ? "highly_similar"
        : newDecision === "review"
          ? "suspicious"
          : "clean";

    await Prompt.findOneAndUpdate(
      { onChainId: String(promptId) },
      {
        $set: {
          similarityFlag: flag,
          similarTo: newDecision === "allow" ? null : (prompt as any)?.similarTo ?? null,
          similarityCheckedAt: new Date(),
        },
      },
    );

    if (appealId) {
      await Appeal.findByIdAndUpdate(appealId, {
        $push: { previousDecisions: override },
        $set: {
          status: newDecision === "allow" ? "rejected" : "upheld",
          resolvedAt: new Date(),
          decisionVersion: override.decisionVersion,
          reasonCode: "similarity_override",
        },
      });
    }

    const base: PublishSimilarityResult = {
      flag: currentFlag,
      score: override.score,
      similarTo: override.similarTo,
      decision: resolvedPrevious,
      feedback: {
        decision: resolvedPrevious,
        title: "",
        summary: "",
        actions: [],
        scorePercent: Math.round(override.score * 100),
        similarTo: override.similarTo,
      },
    };

    return res.json({
      override,
      result: withOverride(base, override),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status = message.includes("required") || message.includes("must change") ? 400 : 500;
    return res.status(status).json({ error: message });
  }
}
