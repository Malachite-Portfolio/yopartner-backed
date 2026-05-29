import { Router } from "express";
import { CompanionStatus, ServiceType, SessionStatus, TransactionStatus, TransactionType, VerificationStatus } from "@prisma/client";
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

const markLiveSchema = z.object({
  mediaReady: z.boolean().optional(),
});

const giftCatalog = {
  "gift-001": { key: "gift-001", name: "Rose Bloom", emoji: "\u{1F339}", amount: 10 },
  "gift-002": { key: "gift-002", name: "Coffee Cheers", emoji: "\u{2615}", amount: 25 },
  "gift-003": { key: "gift-003", name: "Starlight Spark", emoji: "\u{2B50}", amount: 50 },
  "gift-004": { key: "gift-004", name: "Heart Beat", emoji: "\u{1F496}", amount: 100 },
  "gift-005": { key: "gift-005", name: "Warm Hug", emoji: "\u{1F339}", amount: 150 },
  "gift-006": { key: "gift-006", name: "Lucky Charm", emoji: "\u{2615}", amount: 250 },
  "gift-007": { key: "gift-007", name: "Sweet Wave", emoji: "\u{2B50}", amount: 10 },
  "gift-008": { key: "gift-008", name: "Blush Burst", emoji: "\u{1F496}", amount: 25 },
  "gift-009": { key: "gift-009", name: "Moon Wink", emoji: "\u{1F339}", amount: 50 },
  "gift-010": { key: "gift-010", name: "Sunshine Pop", emoji: "\u{2615}", amount: 100 },
  "gift-011": { key: "gift-011", name: "Wish Lantern", emoji: "\u{2B50}", amount: 150 },
  "gift-012": { key: "gift-012", name: "Golden Smile", emoji: "\u{1F496}", amount: 250 },
  "gift-013": { key: "gift-013", name: "Happy Pulse", emoji: "\u{1F339}", amount: 10 },
  "gift-014": { key: "gift-014", name: "Candy Star", emoji: "\u{2615}", amount: 25 },
  "gift-015": { key: "gift-015", name: "Dream Kiss", emoji: "\u{2B50}", amount: 50 },
  "gift-016": { key: "gift-016", name: "Royal Aura", emoji: "\u{1F451}", amount: 500 },
  "gift-017": { key: "gift-017", name: "Crystal Crown", emoji: "\u{1F48E}", amount: 1000 },
  "gift-018": { key: "gift-018", name: "Mystic Flash", emoji: "\u{1F451}", amount: 500 },
  "gift-019": { key: "gift-019", name: "Sky Glitter", emoji: "\u{1F48E}", amount: 1000 },
  "gift-020": { key: "gift-020", name: "Shimmer Path", emoji: "\u{1F451}", amount: 500 },
  "gift-021": { key: "gift-021", name: "Moon Palace", emoji: "\u{1F48E}", amount: 1000 },
  "gift-022": { key: "gift-022", name: "Velvet Night", emoji: "\u{1F451}", amount: 500 },
  "gift-023": { key: "gift-023", name: "Neon Crown", emoji: "\u{1F48E}", amount: 1000 },
  "gift-024": { key: "gift-024", name: "Star Parade", emoji: "\u{1F451}", amount: 500 },
  "gift-025": { key: "gift-025", name: "Diamond Rain", emoji: "\u{1F48E}", amount: 1000 },
  "gift-026": { key: "gift-026", name: "Sapphire Jet", emoji: "\u{1F48E}", amount: 2000 },
  "gift-027": { key: "gift-027", name: "Platinum Storm", emoji: "\u{1F451}", amount: 5000 },
  "gift-028": { key: "gift-028", name: "Royal Blizzard", emoji: "\u{1F48E}", amount: 2000 },
  "gift-029": { key: "gift-029", name: "Eternal Shine", emoji: "\u{1F451}", amount: 5000 },
  "gift-030": { key: "gift-030", name: "Galaxy Drift", emoji: "\u{1F48E}", amount: 2000 },
  "gift-031": { key: "gift-031", name: "Ocean Legend", emoji: "\u{1F451}", amount: 5000 },
  "gift-032": { key: "gift-032", name: "Phoenix Pulse", emoji: "\u{1F48E}", amount: 2000 },
  "gift-033": { key: "gift-033", name: "Kiss Gift", emoji: "\u{1F48E}", amount: 10000 },
  "gift-034": { key: "gift-034", name: "Love Ring", emoji: "\u{1F48E}", amount: 12000 },
  "gift-035": { key: "gift-035", name: "Luxury Purse", emoji: "\u{1F48E}", amount: 15000 },
  "gift-036": { key: "gift-036", name: "Luxury Watch", emoji: "\u{1F48E}", amount: 18000 },
  "gift-037": { key: "gift-037", name: "Marry", emoji: "\u{1F48E}", amount: 20000 },
} as const;

const giftKeys = Object.keys(giftCatalog) as [keyof typeof giftCatalog, ...(keyof typeof giftCatalog)[]];

const giftMessagePrefix = "__YOP_GIFT__:";

const sendGiftSchema = z.object({
  giftKey: z.enum(giftKeys),
});

const giftMessagePayloadSchema = z.object({
  giftKey: z.string().min(1).max(64),
  giftName: z.string().min(1),
  giftEmoji: z.string().min(1),
  amount: z.number().int().positive(),
});

export const sessionsRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];
const PARTNER_PRESENCE_STALE_MS = 90 * 1000;
const MIN_CHAT_WALLET_BALANCE = 50;

function buildGiftMessageBody(gift: {
  key: keyof typeof giftCatalog;
  name: string;
  emoji: string;
  amount: number;
}) {
  return `${giftMessagePrefix}${JSON.stringify({
    giftKey: gift.key,
    giftName: gift.name,
    giftEmoji: gift.emoji,
    amount: gift.amount,
  })}`;
}

function parseGiftMessageBody(body: string) {
  if (!body.startsWith(giftMessagePrefix)) return null;

  try {
    const rawPayload = JSON.parse(body.slice(giftMessagePrefix.length));
    const payload = giftMessagePayloadSchema.parse(rawPayload);
    return {
      key: payload.giftKey,
      name: payload.giftName,
      emoji: payload.giftEmoji,
      amount: payload.amount,
    };
  } catch {
    return null;
  }
}

function isCompanionPresenceOnline(companion: { isOnline: boolean; updatedAt: Date }) {
  if (!companion.isOnline) return false;
  return Date.now() - companion.updatedAt.getTime() <= PARTNER_PRESENCE_STALE_MS;
}

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
  const gift = parseGiftMessageBody(message.body);
  const isGiftMessage = Boolean(gift);
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
    messageType: isGiftMessage ? "GIFT" : "TEXT",
    text: gift ? `${gift.emoji} ${gift.name}` : message.body,
    body: gift ? `${gift.emoji} ${gift.name}` : message.body,
    gift: gift
      ? {
          giftKey: gift.key,
          giftName: gift.name,
          giftEmoji: gift.emoji,
          amount: gift.amount,
        }
      : null,
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
  liveStartedAt: Date | null;
  userMediaReadyAt: Date | null;
  partnerMediaReadyAt: Date | null;
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
    liveStartedAt: session.liveStartedAt,
    userMediaReadyAt: session.userMediaReadyAt,
    partnerMediaReadyAt: session.partnerMediaReadyAt,
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
  "/:id/gifts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");
    if (session.serviceType !== ServiceType.CHAT || session.status !== SessionStatus.LIVE) {
      throw new HttpError(400, "Gifts can only be sent in active chat sessions.");
    }
    if (session.userId !== authUser.id) {
      throw new HttpError(403, "Only users can send gifts in this session.");
    }

    const payload = sendGiftSchema.parse(req.body);
    const gift = giftCatalog[payload.giftKey];
    if (!gift) throw new HttpError(400, "Invalid gift selection.");

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.walletAccount.upsert({
        where: { userId: authUser.id },
        update: {},
        create: { userId: authUser.id },
      });

      const debited = await tx.walletAccount.updateMany({
        where: {
          id: wallet.id,
          balance: { gte: gift.amount },
        },
        data: {
          balance: { decrement: gift.amount },
        },
      });

      if (debited.count === 0) {
        return { insufficientBalance: true as const };
      }

      const updatedWallet = await tx.walletAccount.findUnique({
        where: { id: wallet.id },
        select: { balance: true },
      });
      if (!updatedWallet) throw new HttpError(404, "Wallet account not found.");

      await tx.walletTransaction.create({
        data: {
          transactionCode: createCode("TXN"),
          walletAccountId: wallet.id,
          type: TransactionType.GIFT,
          amount: -gift.amount,
          status: TransactionStatus.SUCCESS,
          gateway: "WALLET",
          referenceId: session.id,
          reason: `Gift ${gift.name} sent in session ${session.sessionCode}`,
        },
      });

      const createdMessage = await tx.chatMessage.create({
        data: {
          sessionId: session.id,
          senderUserId: authUser.id,
          body: buildGiftMessageBody({
            key: gift.key,
            name: gift.name,
            emoji: gift.emoji,
            amount: gift.amount,
          }),
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

      return {
        insufficientBalance: false as const,
        walletBalance: updatedWallet.balance,
        message: createdMessage,
      };
    });

    if (result.insufficientBalance) {
      res.status(402).json({
        error: "INSUFFICIENT_WALLET_BALANCE",
        message: "Minimum wallet balance is not enough for this gift.",
      });
      return;
    }

    res.status(201).json({
      walletBalance: result.walletBalance,
      gift: {
        giftKey: gift.key,
        giftName: gift.name,
        giftEmoji: gift.emoji,
        amount: gift.amount,
      },
      message: toMessageResponse(result.message, session, authUser.id),
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
    const staleThreshold = new Date(Date.now() - STALE_ACTIVE_SESSION_MS);
    const activeChatBetweenPair = await prisma.session.findFirst({
      where: {
        userId: authUser.id,
        companionId: companion.id,
        serviceType: ServiceType.CHAT,
        status: SessionStatus.LIVE,
        endedAt: null,
        updatedAt: { gte: staleThreshold },
      },
      select: { id: true },
    });
    const hasActiveChatEscalationContext = Boolean(activeChatBetweenPair);
    if (!isCompanionPresenceOnline(companion) && !hasActiveChatEscalationContext) {
      throw new HttpError(409, "Partner is currently offline.");
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

    const existingActiveForUser = await prisma.session.findFirst({
      where: {
        userId: authUser.id,
        companionId: companion.id,
        serviceType,
        status: { in: ACTIVE_SESSION_STATUSES },
        endedAt: null,
      },
      orderBy: { createdAt: "desc" },
      include: { user: true, companion: true, booking: true },
    });
    if (existingActiveForUser) {
      res.status(200).json({
        session: toSessionResponse(existingActiveForUser, authUser.id),
      });
      return;
    }

    if (serviceType === ServiceType.CHAT) {
      const wallet = await prisma.walletAccount.upsert({
        where: { userId: authUser.id },
        update: {},
        create: { userId: authUser.id },
      });

      if (wallet.balance < MIN_CHAT_WALLET_BALANCE) {
        res.status(402).json({
          error: "INSUFFICIENT_WALLET_BALANCE",
          message: "Minimum ₹50 wallet balance is required to start a chat.",
        });
        return;
      }
    }

    await prisma.session.updateMany({
      where: {
        companionId: companion.id,
        status: { in: ACTIVE_SESSION_STATUSES },
        endedAt: null,
        updatedAt: { lt: staleThreshold },
      },
      data: {
        status: SessionStatus.EXPIRED,
        endedAt: new Date(),
      },
    });

    const companionBusySession = await prisma.session.findFirst({
      where: {
        companionId: companion.id,
        status: { in: ACTIVE_SESSION_STATUSES },
        endedAt: null,
        updatedAt: { gte: staleThreshold },
        ...(hasActiveChatEscalationContext ? { NOT: { userId: authUser.id } } : {}),
      },
      select: { id: true },
    });
    if (companionBusySession) {
      throw new HttpError(409, "Partner is currently busy.");
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
  "/:id/mark-live",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = markLiveSchema.parse(req.body ?? {});
    if (!payload.mediaReady) {
      const existing = await findSessionForActor(String(req.params.id), authUser.id);
      if (!existing) throw new HttpError(404, "Session not found.");
      res.json({ session: toSessionResponse(existing, authUser.id) });
      return;
    }

    const session = await findSessionForActor(String(req.params.id), authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");
    if (session.serviceType === ServiceType.CHAT) {
      throw new HttpError(400, "mark-live is only available for audio/video sessions.");
    }
    if (isSessionTerminal(session.status)) {
      res.json({ session: toSessionResponse(session, authUser.id) });
      return;
    }

    const companionUserId = session.companion?.userId;
    const actorRole =
      authUser.id === session.userId ? "user" : companionUserId && authUser.id === companionUserId ? "partner" : null;
    if (!actorRole) throw new HttpError(403, "You are not allowed to update this session.");

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.session.findUnique({
        where: { id: session.id },
        select: {
          id: true,
          userMediaReadyAt: true,
          partnerMediaReadyAt: true,
          liveStartedAt: true,
          acceptedAt: true,
          startedAt: true,
          status: true,
        },
      });
      if (!current) throw new HttpError(404, "Session not found.");

      const nextUserReadyAt = actorRole === "user" ? current.userMediaReadyAt ?? now : current.userMediaReadyAt;
      const nextPartnerReadyAt = actorRole === "partner" ? current.partnerMediaReadyAt ?? now : current.partnerMediaReadyAt;
      const shouldGoLive = !current.liveStartedAt && Boolean(nextUserReadyAt && nextPartnerReadyAt);

      return tx.session.update({
        where: { id: session.id },
        data: {
          userMediaReadyAt: nextUserReadyAt,
          partnerMediaReadyAt: nextPartnerReadyAt,
          acceptedAt: current.acceptedAt ?? now,
          liveStartedAt: shouldGoLive ? now : current.liveStartedAt,
          startedAt: shouldGoLive ? current.startedAt ?? now : current.startedAt,
          status: shouldGoLive ? SessionStatus.LIVE : current.status,
          lastHeartbeatAt: now,
        },
        include: {
          user: true,
          companion: true,
          booking: true,
        },
      });
    });

    res.json({ session: toSessionResponse(updated, authUser.id) });
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
