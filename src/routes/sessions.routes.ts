import { Router } from "express";
import { CompanionStatus, ServiceType, SessionStatus, VerificationStatus } from "@prisma/client";
import { RtcRole, RtcTokenBuilder } from "agora-token";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { env } from "../config/env";

const createSessionSchema = z.object({
  bookingId: z.string().optional(),
  companionId: z.string().min(1),
  serviceType: z.enum(["chat", "audio", "video"]),
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(1000),
});

export const sessionsRouter = Router();

function hashToPositiveInt(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483640) + 1;
}

function buildAgoraUid(sessionId: string, userId: string) {
  return hashToPositiveInt(`${sessionId}:${userId}`);
}

function buildAgoraUidForActor(sessionId: string, authUserId: string, companionOwnerUserId: string | null, requestUserId: string) {
  const actorScope = authUserId === requestUserId ? "member" : authUserId === companionOwnerUserId ? "partner" : "actor";
  const hash = hashToPositiveInt(`${sessionId}:${authUserId}:${actorScope}`) % 90000000;
  if (actorScope === "member") return 100000000 + hash;
  if (actorScope === "partner") return 200000000 + hash;
  return 300000000 + hash;
}

function buildChannelName(sessionId: string) {
  return `session-${sessionId}`;
}

function isSessionTerminal(status: SessionStatus) {
  return (
    status === SessionStatus.DECLINED ||
    status === SessionStatus.CANCELLED ||
    status === SessionStatus.ENDED ||
    status === SessionStatus.EXPIRED ||
    status === SessionStatus.COMPLETED ||
    status === SessionStatus.FAILED ||
    status === SessionStatus.FLAGGED
  );
}

function maskPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return value;
  return `+91******${digits.slice(-4)}`;
}

function toMessageResponse(
  message: {
    id: string;
    sessionId: string;
    senderUserId: string;
    body: string;
    createdAt: Date;
    senderUser?: unknown;
  },
  session: {
    userId: string;
    companion?: { userId: string } | null;
  },
  authUserId: string,
) {
  const senderRole =
    message.senderUserId === session.userId
      ? "USER"
      : message.senderUserId === session.companion?.userId
        ? "PARTNER"
        : "UNKNOWN";

  return {
    id: message.id,
    sessionId: message.sessionId,
    senderId: message.senderUserId,
    senderUserId: message.senderUserId,
    senderRole,
    text: message.body,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    isMine: message.senderUserId === authUserId,
    senderUser: message.senderUser,
  };
}

function toSessionResponse(session: {
  id: string;
  sessionCode: string;
  bookingId: string | null;
  userId: string;
  companionId: string;
  serviceType: ServiceType;
  status: SessionStatus;
  acceptedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endedByUserId: string | null;
  lastHeartbeatAt: Date | null;
  durationSeconds: number;
  amount: number;
  platformFee: number;
  companionEarning: number;
  safetyFlag: boolean;
  safetyNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: unknown;
  companion?: unknown;
  booking?: unknown;
}, authUserId: string) {
  return {
    id: session.id,
    sessionCode: session.sessionCode,
    bookingId: session.bookingId,
    userId: session.userId,
    companionId: session.companionId,
    serviceType: session.serviceType,
    type: session.serviceType,
    status: session.status,
    channelName: buildChannelName(session.id),
    acceptedAt: session.acceptedAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endedByUserId: session.endedByUserId,
    lastHeartbeatAt: session.lastHeartbeatAt,
    durationSeconds: session.durationSeconds,
    amount: session.amount,
    platformFee: session.platformFee,
    companionEarning: session.companionEarning,
    safetyFlag: session.safetyFlag,
    safetyNote: session.safetyNote,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    user: session.user
      ? {
          id: (session.user as { id: string }).id,
          name: (session.user as { name?: string | null }).name ?? "Member",
          phoneMasked: maskPhoneNumber((session.user as { phoneNumber: string }).phoneNumber),
        }
      : null,
    companion: session.companion
      ? {
          id: (session.companion as { id: string }).id,
          name:
            (session.companion as { displayName?: string | null }).displayName ??
            "Companion",
        }
      : null,
    agoraToken: null,
    agoraUid: buildAgoraUid(session.id, authUserId),
  };
}

async function findSessionForActor(sessionId: string, authUserId: string) {
  return prisma.session.findFirst({
    where: {
      id: sessionId,
      OR: [
        { userId: authUserId },
        { companion: { is: { userId: authUserId } } },
      ],
    },
    include: {
      user: true,
      companion: true,
      booking: true,
    },
  });
}

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
    res.json({
      sessions: sessions.map((session) => toSessionResponse(session, authUser.id)),
    });
  }),
);

sessionsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");

    res.json({
      session: toSessionResponse(session, authUser.id),
    });
  }),
);

sessionsRouter.get(
  "/:id/agora-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");
    if (session.serviceType === ServiceType.CHAT) {
      throw new HttpError(400, "Agora token is only available for audio/video sessions.");
    }
    if (!env.NEXT_PUBLIC_AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
      throw new HttpError(503, "Calling is not configured on server. Missing Agora credentials.");
    }

    const uid = buildAgoraUidForActor(session.id, authUser.id, session.companion?.userId ?? null, session.userId);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = RtcTokenBuilder.buildTokenWithUid(
      env.NEXT_PUBLIC_AGORA_APP_ID,
      env.AGORA_APP_CERTIFICATE,
      buildChannelName(session.id),
      uid,
      RtcRole.PUBLISHER,
      expiresAt,
      expiresAt,
    );

    res.json({
      appId: env.NEXT_PUBLIC_AGORA_APP_ID,
      token,
      channelName: buildChannelName(session.id),
      uid,
      expiresAt,
    });
  }),
);

sessionsRouter.get(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      include: {
        senderUser: {
          select: {
            id: true,
            phoneNumber: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      messages: messages.map((message) => toMessageResponse(message, session, authUser.id)),
    });
  }),
);

sessionsRouter.post(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");
    if (session.status !== SessionStatus.LIVE) {
      throw new HttpError(400, "Messages can only be sent in active sessions.");
    }

    const payload = sendMessageSchema.parse(req.body);
    const created = await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        senderUserId: authUser.id,
        body: payload.body,
      },
      include: {
        senderUser: {
          select: {
            id: true,
            phoneNumber: true,
            name: true,
          },
        },
      },
    });

    res.status(201).json({
      message: toMessageResponse(created, session, authUser.id),
    });
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
    if (companion.status !== CompanionStatus.ACTIVE || companion.verificationStatus !== VerificationStatus.VERIFIED) {
      throw new HttpError(403, "Companion is not available for new sessions yet.");
    }

    const serviceType =
      body.serviceType === "chat"
        ? ServiceType.CHAT
        : body.serviceType === "audio"
          ? ServiceType.AUDIO
          : ServiceType.VIDEO;

    if (!companion.servicesOffered.includes(serviceType)) {
      throw new HttpError(400, "This service is not offered by the selected companion.");
    }

    const existingPending = await prisma.session.findFirst({
      where: {
        userId: authUser.id,
        companionId: companion.id,
        serviceType,
        status: SessionStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending) {
      res.status(200).json({
        session: toSessionResponse(existingPending, authUser.id),
      });
      return;
    }

    const session = await prisma.session.create({
      data: {
        sessionCode: createCode("SES"),
        bookingId: body.bookingId,
        userId: authUser.id,
        companionId: body.companionId,
        serviceType,
        status: SessionStatus.PENDING,
        acceptedAt: null,
        startedAt: null,
        endedAt: null,
        endedByUserId: null,
        lastHeartbeatAt: new Date(),
        amount:
          serviceType === ServiceType.CHAT
            ? companion.chatPrice
            : serviceType === ServiceType.AUDIO
              ? companion.audioPrice
              : companion.videoPrice,
      },
    });
    res.status(201).json({
      session: toSessionResponse(session, authUser.id),
    });
  }),
);

sessionsRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");

    if (isSessionTerminal(session.status)) {
      res.json({ session: toSessionResponse(session, authUser.id), message: "Session is no longer cancellable." });
      return;
    }

    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.CANCELLED,
        endedAt: session.endedAt ?? new Date(),
        endedByUserId: authUser.id,
      },
    });

    res.json({
      session: toSessionResponse(updated, authUser.id),
    });
  }),
);

const endSessionHandler = asyncHandler(async (req, res) => {
  const authUser = req.authUser!;
  const session = await findSessionForActor(String(req.params.id), authUser.id);
  if (!session) throw new HttpError(404, "Session not found.");

  if (isSessionTerminal(session.status)) {
    res.json({ session: toSessionResponse(session, authUser.id), message: "Session already ended." });
    return;
  }

  const now = new Date();
  const durationSeconds = session.startedAt
    ? Math.max(1, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000))
    : session.durationSeconds;
  const companionEarning = Math.max(0, Math.floor(session.amount * 0.8));
  const platformFee = session.amount - companionEarning;

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: {
      status: SessionStatus.ENDED,
      endedAt: now,
      endedByUserId: authUser.id,
      durationSeconds,
      companionEarning,
      platformFee,
    },
  });

  res.json({ session: toSessionResponse(updated, authUser.id) });
});

sessionsRouter.post("/:id/end", requireAuth, endSessionHandler);
sessionsRouter.patch("/:id/end", requireAuth, endSessionHandler);

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
        status: SessionStatus.ENDED,
        safetyFlag: true,
        safetyNote: note,
        endedAt: session.endedAt ?? new Date(),
        endedByUserId: authUser.id,
      },
    });
    res.json({ session: toSessionResponse(updated, authUser.id) });
  }),
);
