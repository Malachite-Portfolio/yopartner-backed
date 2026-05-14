import { Router } from "express";
import { SessionStatus, ServiceType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";

const createSessionSchema = z.object({
  bookingId: z.string().optional(),
  companionId: z.string().min(1),
  serviceType: z.enum(["chat", "audio", "video"]),
});

export const sessionsRouter = Router();

sessionsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const sessions = await prisma.session.findMany({
      where: { userId: authUser.id },
      include: { companion: true, booking: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ sessions });
  }),
);

sessionsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = createSessionSchema.parse(req.body);

    const companion = await prisma.companion.findUnique({ where: { id: body.companionId } });
    if (!companion) throw new HttpError(404, "Companion not found.");

    const serviceType =
      body.serviceType === "chat"
        ? ServiceType.CHAT
        : body.serviceType === "audio"
          ? ServiceType.AUDIO
          : ServiceType.VIDEO;

    const session = await prisma.session.create({
      data: {
        sessionCode: createCode("SES"),
        bookingId: body.bookingId,
        userId: authUser.id,
        companionId: body.companionId,
        serviceType,
        status: SessionStatus.LIVE,
        startedAt: new Date(),
        amount:
          serviceType === ServiceType.CHAT
            ? companion.chatPrice
            : serviceType === ServiceType.AUDIO
              ? companion.audioPrice
              : companion.videoPrice,
      },
    });
    res.status(201).json({ session });
  }),
);

sessionsRouter.patch(
  "/:id/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await prisma.session.findFirst({
      where: { id: String(req.params.id), userId: authUser.id },
    });
    if (!session) throw new HttpError(404, "Session not found.");

    const now = new Date();
    const durationSeconds = session.startedAt
      ? Math.max(1, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000))
      : session.durationSeconds;
    const companionEarning = Math.max(0, Math.floor(session.amount * 0.8));
    const platformFee = session.amount - companionEarning;

    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.COMPLETED,
        endedAt: now,
        durationSeconds,
        companionEarning,
        platformFee,
      },
    });

    res.json({ session: updated });
  }),
);

sessionsRouter.patch(
  "/:id/flag",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await prisma.session.findFirst({
      where: { id: String(req.params.id), userId: authUser.id },
    });
    if (!session) throw new HttpError(404, "Session not found.");
    const note = typeof req.body.note === "string" ? req.body.note : "User safety report.";
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.FLAGGED,
        safetyFlag: true,
        safetyNote: note,
      },
    });
    res.json({ session: updated });
  }),
);
