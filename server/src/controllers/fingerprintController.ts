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
import {
  scanForSimilarity,
  checkPublishSimilarity,
} from "../services/similarityDetection";
import { ADMIN_ROLE, AdminAuthError, authorizeAdminPrincipal } from "../auth/adminPrincipal";
import { overridePromptSimilarity, SimilarityOverrideError } from "../services/similarityOverride";

export const SIMILARITY_OVERRIDE_AUDIENCE = "prompt-hash:similarity-override";
export const SIMILARITY_SCAN_AUDIENCE = "prompt-hash:similarity-scan";


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
    // This scan rewrites an indexed prompt's moderation evidence. The public
    // draft comparison uses checkPublishSimilarityHandler and does not write.
    authorizeAdminPrincipal(req.get("authorization"), {
      expectedAud: SIMILARITY_SCAN_AUDIENCE,
      requiredRoles: [ADMIN_ROLE],
    });
    const { promptId, text } = req.body ?? {};
    if (typeof promptId !== "string" || !promptId.trim() || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "promptId and text must be non-empty strings" });
    }
    const result = await scanForSimilarity(promptId, text);
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.code === "forbidden" ? 403 : 401).json({ error: err.message, code: err.code });
    }
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
    // Authenticate before validating input or looking up any prompt/appeal.
    const principal = authorizeAdminPrincipal(req.get("authorization"), {
      expectedAud: SIMILARITY_OVERRIDE_AUDIENCE,
      requiredRoles: [ADMIN_ROLE],
    });
    const { promptId, newDecision, reason, appealId } = req.body ?? {};
    const result = await overridePromptSimilarity(
      { promptId, newDecision, reason, appealId },
      principal.sub,
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.code === "forbidden" ? 403 : 401).json({ error: err.message, code: err.code });
    }
    if (err instanceof SimilarityOverrideError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Unable to persist similarity override" });
  }
}
