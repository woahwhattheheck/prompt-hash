import { Request, Response } from "express";
import { createHash } from "crypto";
import Appeal from "../models/Appeal";
import Prompt from "../models/Prompt";

export async function createAppeal(req: Request, res: Response) {
  try {
    const { promptId, reporterAddress, creatorAddress, similarityScore, contentCommitment, fingerprintHash, evidenceHash } = req.body;
    if (!promptId || !reporterAddress || !creatorAddress || similarityScore === undefined || !contentCommitment || !fingerprintHash) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const computedEvidenceHash = evidenceHash
      ? evidenceHash
      : createHash("sha256")
          .update(`${promptId}:${contentCommitment}:${reporterAddress}`)
          .digest("hex");
    const appeal = await Appeal.create({
      promptId,
      reporterAddress,
      creatorAddress,
      similarityScore,
      contentCommitment,
      fingerprintHash,
      evidenceHash: computedEvidenceHash,
      status: "flagged",
    });
    return res.status(201).json(appeal);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function getAppeal(req: Request, res: Response) {
  try {
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) {
      return res.status(404).json({ error: "Appeal not found" });
    }
    return res.json(appeal);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function listAppeals(req: Request, res: Response) {
  try {
    const { status, promptId, page = "1", limit = "20" } = req.query;
    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (promptId) query.promptId = promptId;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const [appeals, total] = await Promise.all([
      Appeal.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Appeal.countDocuments(query),
    ]);
    return res.json({
      data: appeals,
      total,
      page: pageNum,
      pageSize: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function updateAppealStatus(req: Request, res: Response) {
  try {
    const { status, creatorResponse, reasonCode, reviewerDecision } = req.body;
    const validStatuses = ["flagged", "notified", "responded", "reviewed", "upheld", "rejected", "appealed"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }
    const update: Record<string, unknown> = {};
    const mutation: Record<string, Record<string, unknown>> = { $set: update };
    if (status) update.status = status;
    if (creatorResponse) {
      update.creatorResponse = creatorResponse;
      update.respondedAt = new Date();
      if (!status) update.status = "responded";
    }
    if (reasonCode) update.reasonCode = reasonCode;
    if (reviewerDecision) {
      mutation.$push = { reviewerDecisions: { ...reviewerDecision, decidedAt: new Date() } };
      update.status = status || "reviewed";
      update.reviewedAt = new Date();
    }
    switch (status) {
      case "notified":
        update.notifiedAt = new Date();
        break;
      case "reviewed":
        update.reviewedAt = new Date();
        break;
      case "upheld":
      case "rejected":
        update.resolvedAt = new Date();
        break;
      case "appealed":
        update.appealedAt = new Date();
        break;
    }
    const appeal = await Appeal.findByIdAndUpdate(
      req.params.id,
      mutation,
      { new: true, runValidators: true },
    );
    if (!appeal) {
      return res.status(404).json({ error: "Appeal not found" });
    }
    return res.json(appeal);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function getAppealStats(_req: Request, res: Response) {
  try {
    const stats = await Appeal.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);
    const total = await Appeal.countDocuments();
    return res.json({ total, byStatus: stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

