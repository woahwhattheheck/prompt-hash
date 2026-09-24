import { Router } from "express";
import {
  computeFingerprint,
  verifyFingerprint,
  computeSimhash,
  compareSimhash,
  scanSimilarity,
  normalizeText,
  listAlgorithms,
  checkPublishSimilarityHandler,
  overrideSimilarityDecision,
} from "../controllers/fingerprintController";

const router = Router();

router.post("/fingerprint", computeFingerprint);
router.post("/fingerprint/verify", verifyFingerprint);
router.post("/fingerprint/simhash", computeSimhash);
router.post("/fingerprint/simhash/compare", compareSimhash);
router.post("/fingerprint/scan", scanSimilarity);
router.post("/fingerprint/publish-check", checkPublishSimilarityHandler);
router.post("/fingerprint/override", overrideSimilarityDecision);
router.post("/fingerprint/normalize", normalizeText);
router.get("/fingerprint/algorithms", listAlgorithms);

export default router;
