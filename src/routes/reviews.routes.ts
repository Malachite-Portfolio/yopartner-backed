import { Prisma, SessionStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/http";

const createReviewSchema = z.object({
  sessionId: z.string().min(1),
  companionId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  feedback: z.string().trim().min(20).max(2000),
});

const REVIEWABLE_SESSION_STATUSES: SessionStatus[] = [
  SessionStatus.ENDED,
  SessionStatus.COMPLETED,
];

export const reviewsRouter = Router();

reviewsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = createReviewSchema.parse(req.body);

    try {
      const review = await prisma.$transaction(async (tx) => {
        const session = await tx.session.findFirst({
          where: {
            id: body.sessionId,
            userId: authUser.id,
            companionId: body.companionId,
          },
          select: {
            id: true,
            status: true,
          },
        });

        if (!session) {
          throw new HttpError(404, "Session not found.");
        }

        if (!REVIEWABLE_SESSION_STATUSES.includes(session.status)) {
          throw new HttpError(400, "You can review only an ended session.");
        }

        const existingReview = await tx.review.findFirst({
          where: {
            userId: authUser.id,
            sessionId: session.id,
          },
          select: { id: true },
        });

        if (existingReview) {
          throw new HttpError(409, "You have already reviewed this session.");
        }

        const created = await tx.review.create({
          data: {
            userId: authUser.id,
            companionId: body.companionId,
            sessionId: session.id,
            rating: body.rating,
            comment: body.feedback,
          },
          select: {
            id: true,
            sessionId: true,
            companionId: true,
            rating: true,
            comment: true,
            createdAt: true,
          },
        });

        const aggregate = await tx.review.aggregate({
          where: {
            companionId: body.companionId,
            isHidden: false,
            isFlagged: false,
          },
          _avg: { rating: true },
        });

        if (aggregate._avg.rating != null) {
          await tx.companion.update({
            where: { id: body.companionId },
            data: { rating: Number(aggregate._avg.rating.toFixed(1)) },
          });
        }

        return created;
      });

      res.status(201).json({ review });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new HttpError(409, "You have already reviewed this session.");
      }
      throw error;
    }
  }),
);
