import { Router } from "express";
import {
  CompanionAvailability,
  CompanionStatus,
  LuckyWheelRewardType,
  PartnerEarningSourceType,
  PartnerEarningStatus,
  Prisma,
  ServiceType,
  SessionStatus,
  TransactionStatus,
  TransactionType,
  UserRewardSource,
  UserRewardStatus,
  VerificationStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { RtcRole, RtcTokenBuilder } from "agora-token";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { env } from "../config/env";
import {
  assertPartnerCanReceiveRequests,
  assertUserCanSendGifts,
  assertUserCanStartSession,
} from "../utils/moderation";
import { CHAT_RATE_PER_MESSAGE, getFixedSessionRate } from "../config/platformPricing";
import { sendIncomingRequestPush, sendPartnerChatMessagePush } from "../services/pushNotifications";
import {
  finalizeStartedSessionRewardReservation,
  normalizeUserRewardReservations,
} from "../services/rewardReservations";
import { isCompanionOnlineForRequests } from "../utils/partnerAvailability";

const createSessionSchema = z.object({
  bookingId: z.string().optional(),
  companionId: z.string().min(1),
  serviceType: z.enum(["chat", "audio", "video"]),
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  clientMessageId: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined),
    z.string().min(1).max(120).optional(),
  ),
});

const markLiveSchema = z.object({
  mediaReady: z.boolean().optional(),
});

type GiftCatalogEntry = {
  key: string;
  name: string;
  emoji: string;
  amount: number;
};

const SVGA_GIFT_COUNT = 37;
const PNG_GIFT_COUNT = 20;
const NORMAL_PNG_PRICES = [5, 10, 15, 25, 35, 40, 45, 50, 60, 75, 90, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const PREMIUM_SVGA_PRICES = [600, 700, 800, 900, 1000, 1200, 1500, 1800, 2000];
const LUXURY_SVGA_PRICES = [2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000];
const EXPENSIVE_SVGA_PRICES = [10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000, 23000, 24000, 25000, 26000, 27000];

function padGiftIndex(index: number) {
  return String(index).padStart(3, "0");
}

function buildGiftCatalog() {
  const svgaPrices = [...PREMIUM_SVGA_PRICES, ...LUXURY_SVGA_PRICES, ...EXPENSIVE_SVGA_PRICES];
  const catalog: Record<string, GiftCatalogEntry> = {};

  for (let i = 1; i <= SVGA_GIFT_COUNT; i += 1) {
    const key = `gift-${padGiftIndex(i)}`;
    catalog[key] = {
      key,
      name: `SVGA Gift ${padGiftIndex(i)}`,
      emoji: "\u{1F48E}",
      amount: svgaPrices[i - 1],
    };
  }

  for (let i = 1; i <= PNG_GIFT_COUNT; i += 1) {
    const key = `png-gift-${padGiftIndex(i)}`;
    catalog[key] = {
      key,
      name: `PNG Gift ${padGiftIndex(i)}`,
      emoji: "\u{1F48E}",
      amount: NORMAL_PNG_PRICES[i - 1],
    };
  }

  return catalog;
}

const giftCatalog: Record<string, GiftCatalogEntry> = buildGiftCatalog();

const giftMessagePrefix = "__YOP_GIFT__:";

const sendGiftSchema = z.object({
  giftKey: z.string().trim().min(1).max(64),
  quantity: z.union([z.literal(1), z.literal(10), z.literal(50), z.literal(100)]).default(1),
});

const giftMessagePayloadSchema = z.object({
  giftKey: z.string().min(1).max(64),
  giftName: z.string().min(1),
  giftEmoji: z.string().min(1),
  amount: z.number().int().positive(),
  quantity: z.number().int().positive().optional(),
  unitAmount: z.number().int().positive().optional(),
});

export const sessionsRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];
const INSUFFICIENT_WALLET_BALANCE_CODE = "INSUFFICIENT_WALLET_BALANCE";
const CHAT_LOW_BALANCE_MESSAGE = "User wallet balance is low. Please add money to continue chatting.";

function roundToTwo(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function splitAmount(grossAmount: number, partnerPercent: number, companyPercent: number) {
  const gross = roundToTwo(Math.max(0, grossAmount));
  const partner = roundToTwo((gross * partnerPercent) / 100);
  const company = roundToTwo(gross - partner);
  return {
    grossAmount: gross,
    partnerAmount: partner,
    companyAmount: company,
    partnerPercent,
    companyPercent,
  };
}

function getSessionRatePerMinute(session: {
  amount: number;
  serviceType: ServiceType;
  companion?: {
    chatPrice?: number | null;
    audioPrice?: number | null;
    videoPrice?: number | null;
  } | null;
}) {
  return getFixedSessionRate(session.serviceType);
}

function getMinimumWalletBalanceForSession(serviceType: ServiceType) {
  return getFixedSessionRate(serviceType);
}

function getMinimumBillingForSessionStart(serviceType: ServiceType): BaseSessionBilling {
  const ratePerMinute = getMinimumWalletBalanceForSession(serviceType);
  return calculateSessionCharge({ amount: ratePerMinute, serviceType }, 1);
}

function calculateSessionCharge(session: {
  amount: number;
  serviceType: ServiceType;
  companion?: {
    chatPrice?: number | null;
    audioPrice?: number | null;
    videoPrice?: number | null;
  } | null;
}, durationSeconds: number) {
  const ratePerMinute = getSessionRatePerMinute(session);
  const billableMinutes = Math.max(1, Math.ceil(Math.max(1, durationSeconds) / 60));
  return {
    ratePerMinute,
    billableMinutes,
    totalCharge: billableMinutes * ratePerMinute,
  };
}

type BaseSessionBilling = ReturnType<typeof calculateSessionCharge>;

function calculateSessionChargeForBillableMinutes(serviceType: ServiceType, billableMinutes: number): BaseSessionBilling {
  const ratePerMinute = getFixedSessionRate(serviceType);
  return {
    ratePerMinute,
    billableMinutes,
    totalCharge: billableMinutes * ratePerMinute,
  };
}

function zeroSessionBilling(serviceType: ServiceType): RewardAdjustedBilling {
  return {
    ...calculateSessionChargeForBillableMinutes(serviceType, 0),
    normalCharge: 0,
    rewardApplication: null,
  };
}

type RewardApplication = {
  rewardId: string;
  type: LuckyWheelRewardType;
  source: UserRewardSource;
  originalValue: number;
  usedValue: number;
  remainingValue: number;
  discountAmount: number;
  label: string;
};

type RewardAdjustedBilling = BaseSessionBilling & {
  normalCharge: number;
  rewardApplication: RewardApplication | null;
};

type SessionRewardMetadata = {
  appliedRewardId: string;
  appliedRewardType: LuckyWheelRewardType;
  appliedRewardSource: UserRewardSource;
  label: string;
  freeSeconds: number | null;
  shouldAutoEndAtFreeLimit: boolean;
};

type SessionBillingLimitMetadata = {
  maxAllowedSeconds: number | null;
  warningAtSeconds: number | null;
  autoEndAt: string | null;
};

function getRewardLabel(type: LuckyWheelRewardType, value: number, source?: UserRewardSource) {
  if (source === UserRewardSource.WELCOME_PROFILE && type === LuckyWheelRewardType.FREE_CHAT_MINUTES) {
    return "First Chat Free - 10 Minutes";
  }
  if (type === LuckyWheelRewardType.FREE_CHAT_MINUTES) return `${value} free chat minute${value === 1 ? "" : "s"}`;
  if (type === LuckyWheelRewardType.FREE_CALL_MINUTES) return `${value} free audio minute${value === 1 ? "" : "s"}`;
  if (type === LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT) return `${value}% video discount`;
  return `INR ${value} talktime`;
}

function matchingRewardType(serviceType: ServiceType) {
  if (serviceType === ServiceType.CHAT) return LuckyWheelRewardType.FREE_CHAT_MINUTES;
  if (serviceType === ServiceType.AUDIO) return LuckyWheelRewardType.FREE_CALL_MINUTES;
  if (serviceType === ServiceType.VIDEO) return LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT;
  return null;
}

async function calculateRewardAdjustedBilling(
  tx: Pick<Prisma.TransactionClient, "session" | "userReward">,
  userId: string,
  serviceType: ServiceType,
  baseBilling: BaseSessionBilling,
  now: Date,
  options?: { reservationReferenceId?: string | null; allowUnreserved?: boolean },
): Promise<RewardAdjustedBilling> {
  const rewardType = matchingRewardType(serviceType);
  if (!rewardType) {
    return { ...baseBilling, normalCharge: baseBilling.totalCharge, rewardApplication: null };
  }

  await tx.userReward.updateMany({
    where: {
      userId,
      status: UserRewardStatus.ACTIVE,
      expiresAt: { lte: now },
    },
    data: { status: UserRewardStatus.EXPIRED },
  });

  const reservationFilters: Prisma.UserRewardWhereInput[] = options?.reservationReferenceId
    ? [
        { redemptionReferenceId: options.reservationReferenceId },
        ...(options.allowUnreserved === false ? [] : [{ redemptionReferenceId: null }]),
      ]
    : [{ redemptionReferenceId: null }];

  const reward = await tx.userReward.findFirst({
    where: {
      userId,
      type: rewardType,
      status: UserRewardStatus.ACTIVE,
      expiresAt: { gt: now },
      remainingValue: { gt: 0 },
      OR: reservationFilters,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!reward) {
    return { ...baseBilling, normalCharge: baseBilling.totalCharge, rewardApplication: null };
  }

  if (reward.source === UserRewardSource.WELCOME_PROFILE) {
    if (serviceType !== ServiceType.CHAT) {
      return { ...baseBilling, normalCharge: baseBilling.totalCharge, rewardApplication: null };
    }

    const priorStartedChatCount = await tx.session.count({
      where: {
        userId,
        serviceType: ServiceType.CHAT,
        ...(options?.reservationReferenceId ? { id: { not: options.reservationReferenceId } } : {}),
        OR: [{ startedAt: { not: null } }, { liveStartedAt: { not: null } }],
      },
    });

    if (priorStartedChatCount > 0) {
      return { ...baseBilling, normalCharge: baseBilling.totalCharge, rewardApplication: null };
    }
  }

  if (reward.type === LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT) {
    const discountAmount = Math.min(
      baseBilling.totalCharge,
      Math.max(0, Math.round((baseBilling.totalCharge * reward.remainingValue) / 100)),
    );
    return {
      ...baseBilling,
      normalCharge: baseBilling.totalCharge,
      totalCharge: Math.max(0, baseBilling.totalCharge - discountAmount),
      rewardApplication: {
        rewardId: reward.id,
        type: reward.type,
        source: reward.source,
        originalValue: reward.value,
        usedValue: reward.remainingValue,
        remainingValue: 0,
        discountAmount,
        label: getRewardLabel(reward.type, reward.value, reward.source),
      },
    };
  }

  const freeMinutes = Math.min(baseBilling.billableMinutes, reward.remainingValue);
  const discountAmount = freeMinutes * baseBilling.ratePerMinute;

  return {
    ...baseBilling,
    normalCharge: baseBilling.totalCharge,
    totalCharge: Math.max(0, baseBilling.totalCharge - discountAmount),
    rewardApplication: {
      rewardId: reward.id,
      type: reward.type,
      source: reward.source,
      originalValue: reward.value,
      usedValue: freeMinutes,
      remainingValue: Math.max(0, reward.remainingValue - freeMinutes),
      discountAmount,
      label: getRewardLabel(reward.type, reward.value, reward.source),
    },
  };
}

async function calculateAffordableSessionBilling(params: {
  tx: Pick<Prisma.TransactionClient, "session" | "userReward">;
  userId: string;
  serviceType: ServiceType;
  requestedDurationSeconds: number;
  walletBalance: number;
  now: Date;
  reservationReferenceId: string;
}) {
  const requestedBillableMinutes = Math.max(1, Math.ceil(Math.max(1, params.requestedDurationSeconds) / 60));

  for (let minutes = requestedBillableMinutes; minutes >= 1; minutes -= 1) {
    const candidate = await calculateRewardAdjustedBilling(
      params.tx,
      params.userId,
      params.serviceType,
      calculateSessionChargeForBillableMinutes(params.serviceType, minutes),
      params.now,
      { reservationReferenceId: params.reservationReferenceId },
    );
    if (candidate.totalCharge <= params.walletBalance) {
      return {
        billing: candidate,
        chargeableDurationSeconds: Math.min(params.requestedDurationSeconds, minutes * 60),
        maxAllowedSeconds: minutes * 60,
      };
    }
  }

  return {
    billing: zeroSessionBilling(params.serviceType),
    chargeableDurationSeconds: 0,
    maxAllowedSeconds: 0,
  };
}

async function redeemSessionReward(
  tx: Pick<Prisma.TransactionClient, "userReward">,
  rewardApplication: RewardApplication | null,
  sessionId: string,
  now: Date,
) {
  if (!rewardApplication) return;

  await tx.userReward.update({
    where: { id: rewardApplication.rewardId },
    data: {
      remainingValue: 0,
      status: UserRewardStatus.REDEEMED,
      redeemedAt: now,
      redemptionReferenceId: sessionId,
    },
  });
}

function createSessionId() {
  return `ses_${randomUUID().replace(/-/g, "")}`;
}

function getRewardFreeSeconds(reward: Pick<RewardApplication, "type" | "originalValue"> | null) {
  if (!reward) return 0;
  if (reward.type !== LuckyWheelRewardType.FREE_CALL_MINUTES && reward.type !== LuckyWheelRewardType.FREE_CHAT_MINUTES) {
    return 0;
  }
  return Math.max(0, reward.originalValue * 60);
}

function getEffectivePrepaidRatePerMinute(serviceType: ServiceType, reward: Pick<RewardApplication, "type" | "usedValue"> | null) {
  const rate = getFixedSessionRate(serviceType);
  if (reward?.type !== LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT) return rate;
  const discount = Math.min(rate, Math.max(0, Math.round((rate * reward.usedValue) / 100)));
  return Math.max(1, rate - discount);
}

function buildSessionBillingLimit(params: {
  serviceType: ServiceType;
  walletBalance: number;
  rewardApplication: RewardApplication | null;
  timerBase?: Date | null;
}): SessionBillingLimitMetadata {
  const freeSeconds = getRewardFreeSeconds(params.rewardApplication);
  const effectiveRatePerMinute = getEffectivePrepaidRatePerMinute(params.serviceType, params.rewardApplication);
  const paidSeconds = Math.max(0, Math.floor(params.walletBalance / effectiveRatePerMinute) * 60);
  const maxAllowedSeconds = freeSeconds + paidSeconds;
  const warningAtSeconds = maxAllowedSeconds > 30 ? maxAllowedSeconds - 30 : null;
  const autoEndAt = params.timerBase ? new Date(params.timerBase.getTime() + maxAllowedSeconds * 1000).toISOString() : null;
  return {
    maxAllowedSeconds,
    warningAtSeconds,
    autoEndAt,
  };
}

function toRewardApplication(reward: {
  id: string;
  type: LuckyWheelRewardType;
  source: UserRewardSource;
  value: number;
  remainingValue: number;
}): RewardApplication {
  return {
    rewardId: reward.id,
    type: reward.type,
    source: reward.source,
    originalValue: reward.value,
    usedValue: reward.remainingValue,
    remainingValue: 0,
    discountAmount: 0,
    label: getRewardLabel(reward.type, reward.value, reward.source),
  };
}

function toSessionRewardMetadata(params: {
  rewardApplication: RewardApplication | null;
  serviceType: ServiceType;
  walletBalance: number;
}) {
  const reward = params.rewardApplication;
  if (!reward) return null;
  const freeSeconds =
    reward.type === LuckyWheelRewardType.FREE_CALL_MINUTES || reward.type === LuckyWheelRewardType.FREE_CHAT_MINUTES
      ? reward.originalValue * 60
      : null;
  return {
    appliedRewardId: reward.rewardId,
    appliedRewardType: reward.type,
    appliedRewardSource: reward.source,
    label: reward.label,
    freeSeconds,
    shouldAutoEndAtFreeLimit: Boolean(freeSeconds && params.walletBalance < getFixedSessionRate(params.serviceType)),
  } satisfies SessionRewardMetadata;
}

async function getSessionRewardAndBillingMetadata(session: {
  id: string;
  userId: string;
  serviceType: ServiceType;
  startedAt?: Date | null;
  liveStartedAt?: Date | null;
}) {
  const rewardType = matchingRewardType(session.serviceType);

  const now = new Date();
  const [reward, wallet] = await Promise.all([
    rewardType
      ? prisma.userReward.findFirst({
          where: {
            userId: session.userId,
            type: rewardType,
            status: UserRewardStatus.ACTIVE,
            expiresAt: { gt: now },
            remainingValue: { gt: 0 },
            redemptionReferenceId: session.id,
          },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve(null),
    prisma.walletAccount.findUnique({
      where: { userId: session.userId },
      select: { balance: true },
    }),
  ]);
  const rewardApplication = reward ? toRewardApplication(reward) : null;
  return {
    rewardMetadata: toSessionRewardMetadata({
      rewardApplication,
      serviceType: session.serviceType,
      walletBalance: wallet?.balance ?? 0,
    }),
    billingLimit: buildSessionBillingLimit({
      serviceType: session.serviceType,
      walletBalance: wallet?.balance ?? 0,
      rewardApplication,
      timerBase: session.liveStartedAt ?? session.startedAt ?? null,
    }),
  };
}

async function releaseUnstartedSessionReward(
  tx: Pick<Prisma.TransactionClient, "userReward">,
  session: { id: string; startedAt?: Date | null; liveStartedAt?: Date | null },
) {
  if (session.startedAt || session.liveStartedAt) return;
  await tx.userReward.updateMany({
    where: {
      status: UserRewardStatus.ACTIVE,
      redemptionReferenceId: session.id,
    },
    data: {
      redemptionReferenceId: null,
    },
  });
}

function buildSessionChargeReason(params: {
  sessionCode: string;
  serviceType: ServiceType;
  billing: RewardAdjustedBilling;
}) {
  const base = `Session charge for ${params.sessionCode} (${params.serviceType}) - ${params.billing.billableMinutes} min x INR ${params.billing.ratePerMinute}`;
  if (!params.billing.rewardApplication) return base;
  const rewardSource = params.billing.rewardApplication.source === UserRewardSource.WELCOME_PROFILE ? "Welcome bonus" : "Lucky Wheel reward";
  return `${base}; ${rewardSource} applied: ${params.billing.rewardApplication.label}, discount INR ${params.billing.rewardApplication.discountAmount}`;
}

function getChatFreeWindowBase(session: {
  liveStartedAt?: Date | null;
  startedAt?: Date | null;
  acceptedAt?: Date | null;
}) {
  return session.liveStartedAt ?? session.startedAt ?? session.acceptedAt ?? null;
}

function isWithinFreeChatWindow(
  session: {
    liveStartedAt?: Date | null;
    startedAt?: Date | null;
    acceptedAt?: Date | null;
  },
  reward: { remainingValue: number } | null,
  now: Date,
) {
  if (!reward || reward.remainingValue <= 0) return false;
  const timerBase = getChatFreeWindowBase(session);
  if (!timerBase) return false;
  return now.getTime() - timerBase.getTime() < reward.remainingValue * 60 * 1000;
}

function buildChatMessageChargeReason(params: {
  sessionCode: string;
  messageId: string;
  senderRole: "USER" | "PARTNER";
}) {
  return `Chat message charge for ${params.sessionCode} (${params.senderRole} message ${params.messageId}) - INR ${CHAT_RATE_PER_MESSAGE}/message`;
}

function buildGiftMessageBody(gift: {
  key: string;
  name: string;
  emoji: string;
  amount: number;
  quantity: number;
  unitAmount: number;
}) {
  return `${giftMessagePrefix}${JSON.stringify({
    giftKey: gift.key,
    giftName: gift.name,
    giftEmoji: gift.emoji,
    amount: gift.amount,
    quantity: gift.quantity,
    unitAmount: gift.unitAmount,
  })}`;
}

function getGiftByKey(giftKey: string) {
  if (!giftKey) return null;
  if (!Object.prototype.hasOwnProperty.call(giftCatalog, giftKey)) return null;
  return giftCatalog[giftKey];
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
      quantity: payload.quantity ?? 1,
      unitAmount: payload.unitAmount ?? payload.amount,
    };
  } catch {
    return null;
  }
}

function hashToPositiveInt(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483640) + 1;
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
          quantity: gift.quantity,
          unitAmount: gift.unitAmount,
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
}, authUserId: string, rewardMetadata: SessionRewardMetadata | null = null, billingLimit: SessionBillingLimitMetadata | null = null) {
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
          name: (session.user as { name?: string | null }).name ?? null,
          fullName: (session.user as { fullName?: string | null }).fullName ?? null,
          phoneMasked: maskPhoneNumber((session.user as { phoneNumber: string }).phoneNumber),
        }
      : null,
    companion: session.companion
      ? {
          id: (session.companion as { id: string }).id,
          name:
            (session.companion as { displayName?: string | null }).displayName ??
            "Partner",
        }
      : null,
    reward: rewardMetadata,
    billingLimit,
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
    const metadata = await getSessionRewardAndBillingMetadata(session);

    res.json({
      session: toSessionResponse(session, authUser.id, metadata.rewardMetadata, metadata.billingLimit),
    });
  }),
);

sessionsRouter.get(
  "/:id/agora-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (env.CALL_PROVIDER !== "agora") {
      throw new HttpError(410, "Agora calling is disabled. Use the configured call provider.");
    }
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
    if (session.serviceType !== ServiceType.CHAT) {
      throw new HttpError(400, "Messages can only be sent in chat sessions.");
    }
    if (session.status !== SessionStatus.LIVE) {
      throw new HttpError(400, "Messages can only be sent in active sessions.");
    }
    const senderRole =
      authUser.id === session.userId
        ? "USER"
        : authUser.id === session.companion?.userId
          ? "PARTNER"
          : null;
    if (!senderRole) throw new HttpError(403, "You are not allowed to send messages in this session.");

    const payload = sendMessageSchema.parse(req.body);
    const headerIdempotencyKey =
      req.get("Idempotency-Key")?.trim() || req.get("X-Idempotency-Key")?.trim() || "";
    const requestedClientMessageId = payload.clientMessageId ?? headerIdempotencyKey;
    const clientMessageId = requestedClientMessageId || `server-${randomUUID()}`;
    const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
    const now = new Date();

    try {
      const result = await prisma.$transaction(async (tx) => {
        const existingMessage = await tx.chatMessage.findUnique({
          where: {
            sessionId_clientMessageId: {
              sessionId: session.id,
              clientMessageId,
            },
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
        if (existingMessage) {
          const wallet = await tx.walletAccount.findUnique({
            where: { userId: session.userId },
            select: { balance: true },
          });
          return {
            message: existingMessage,
            walletBalance: wallet?.balance ?? 0,
            chargeAmount: existingMessage.walletTransactionId ? CHAT_RATE_PER_MESSAGE : 0,
            wasCreated: false,
          };
        }

        const wallet = await tx.walletAccount.upsert({
          where: { userId: session.userId },
          update: {},
          create: { userId: session.userId },
        });
        const freeChatReward = await tx.userReward.findFirst({
          where: {
            userId: session.userId,
            type: LuckyWheelRewardType.FREE_CHAT_MINUTES,
            status: UserRewardStatus.ACTIVE,
            redemptionReferenceId: session.id,
            remainingValue: { gt: 0 },
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, remainingValue: true },
        });
        const isFreeMessage = isWithinFreeChatWindow(session, freeChatReward, now);
        let walletBalance = wallet.balance;
        let walletTransactionId: string | null = null;

        if (!isFreeMessage) {
          const debited = await tx.walletAccount.updateMany({
            where: {
              id: wallet.id,
              balance: { gte: CHAT_RATE_PER_MESSAGE },
            },
            data: {
              balance: { decrement: CHAT_RATE_PER_MESSAGE },
            },
          });

          if (debited.count === 0) {
            throw new HttpError(402, CHAT_LOW_BALANCE_MESSAGE);
          }

          const updatedWallet = await tx.walletAccount.findUnique({
            where: { id: wallet.id },
            select: { balance: true },
          });
          walletBalance = updatedWallet?.balance ?? walletBalance - CHAT_RATE_PER_MESSAGE;

          const walletTransaction = await tx.walletTransaction.create({
            data: {
              transactionCode: createCode("TXN"),
              walletAccountId: wallet.id,
              type: TransactionType.BOOKING,
              amount: -CHAT_RATE_PER_MESSAGE,
              status: TransactionStatus.SUCCESS,
              referenceId: messageId,
              reason: buildChatMessageChargeReason({
                sessionCode: session.sessionCode,
                messageId,
                senderRole,
              }),
            },
          });
          walletTransactionId = walletTransaction.id;

          const messageSplit = splitAmount(CHAT_RATE_PER_MESSAGE, 30, 70);
          await tx.partnerEarning.create({
            data: {
              companionId: session.companionId,
              userId: session.userId,
              sessionId: session.id,
              walletTransactionId: walletTransaction.id,
              sourceType: PartnerEarningSourceType.SESSION,
              grossAmount: messageSplit.grossAmount,
              partnerAmount: messageSplit.partnerAmount,
              companyAmount: messageSplit.companyAmount,
              partnerPercent: messageSplit.partnerPercent,
              companyPercent: messageSplit.companyPercent,
              status: PartnerEarningStatus.AVAILABLE,
            },
          });

          const companionEarning = Math.max(0, Math.round(messageSplit.partnerAmount));
          await tx.session.update({
            where: { id: session.id },
            data: {
              amount: { increment: CHAT_RATE_PER_MESSAGE },
              companionEarning: { increment: companionEarning },
              platformFee: { increment: CHAT_RATE_PER_MESSAGE - companionEarning },
              lastHeartbeatAt: now,
            },
          });
        } else {
          await tx.session.update({
            where: { id: session.id },
            data: { lastHeartbeatAt: now },
          });
        }

        const created = await tx.chatMessage.create({
          data: {
            id: messageId,
            sessionId: session.id,
            senderUserId: authUser.id,
            body: payload.body,
            clientMessageId,
            walletTransactionId,
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
          message: created,
          walletBalance,
          chargeAmount: walletTransactionId ? CHAT_RATE_PER_MESSAGE : 0,
          wasCreated: true,
        };
      });

      res.status(201).json({
        message: toMessageResponse(result.message, session, authUser.id),
        walletBalance: result.walletBalance,
        chargeAmount: result.chargeAmount,
      });
      if (senderRole === "USER" && result.wasCreated) {
        void sendPartnerChatMessagePush({
          sessionId: session.id,
          companionId: session.companionId,
          messageId: result.message.id,
          messageBody: result.message.body,
          senderLabel: result.message.senderUser?.name || "New message",
        }).catch((error) => {
          console.error("[push] chat message FCM dispatch failed", {
            sessionId: session.id,
            companionId: session.companionId,
            error: error instanceof Error ? { name: error.name, message: error.message } : { message: "Push dispatch failed" },
          });
        });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existingMessage = await prisma.chatMessage.findUnique({
          where: {
            sessionId_clientMessageId: {
              sessionId: session.id,
              clientMessageId,
            },
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
        if (existingMessage) {
          const wallet = await prisma.walletAccount.findUnique({
            where: { userId: session.userId },
            select: { balance: true },
          });
          res.status(200).json({
            message: toMessageResponse(existingMessage, session, authUser.id),
            walletBalance: wallet?.balance ?? 0,
            chargeAmount: existingMessage.walletTransactionId ? CHAT_RATE_PER_MESSAGE : 0,
          });
          return;
        }
      }
      throw error;
    }
  }),
);

sessionsRouter.post(
  "/:id/gifts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const requester = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true },
    });
    if (!requester) throw new HttpError(404, "User not found.");
    assertUserCanSendGifts(requester);
    const sessionId = String(req.params.id);
    const payloadResult = sendGiftSchema.safeParse(req.body ?? {});
    const requestedGiftKey = payloadResult.success ? payloadResult.data.giftKey : "";
    const requestedQuantity = payloadResult.success ? payloadResult.data.quantity : undefined;

    console.info("[sessions:gifts] request", {
      sessionId,
      userId: authUser.id,
      giftKey: requestedGiftKey || null,
      quantity: requestedQuantity ?? null,
    });

    if (!payloadResult.success) {
      console.warn("[sessions:gifts] invalid payload", {
        sessionId,
        userId: authUser.id,
        issues: payloadResult.error.issues.map((issue) => issue.message),
      });
      res.status(400).json({
        error: "INVALID_GIFT",
        message: "Invalid gift selected.",
      });
      return;
    }

    const gift = getGiftByKey(payloadResult.data.giftKey);
    const quantity = payloadResult.data.quantity;
    const totalAmount = gift ? gift.amount * quantity : 0;
    console.info("[sessions:gifts] catalog lookup", {
      sessionId,
      userId: authUser.id,
      giftKey: payloadResult.data.giftKey,
      quantity,
      found: Boolean(gift),
      giftName: gift?.name ?? null,
      amount: gift?.amount ?? null,
      totalAmount: gift ? totalAmount : null,
    });
    if (!gift) {
      res.status(400).json({
        error: "INVALID_GIFT",
        message: "Invalid gift selected.",
      });
      return;
    }

    const session = await findSessionForActor(sessionId, authUser.id);
    if (!session) throw new HttpError(404, "Session not found.");
    if (session.serviceType !== ServiceType.CHAT || session.status !== SessionStatus.LIVE) {
      res.status(400).json({
        error: "SESSION_NOT_LIVE",
        message: "Gifts can only be sent during an active chat.",
      });
      return;
    }
    if (session.userId !== authUser.id) {
      throw new HttpError(403, "Only users can send gifts in this session.");
    }
    if (!session.companionId) {
      res.status(404).json({
        error: "PARTNER_NOT_FOUND",
        message: "Partner unavailable.",
      });
      return;
    }

    let result:
      | {
          insufficientBalance: true;
          walletBalance: number;
          walletDebitedCount: number;
        }
      | {
          insufficientBalance: false;
          walletBalance: number;
          walletDebitedCount: number;
          message: Awaited<ReturnType<typeof prisma.chatMessage.create>>;
        };
    try {
      result = await prisma.$transaction(async (tx) => {
        const wallet = await tx.walletAccount.upsert({
          where: { userId: authUser.id },
          update: {},
          create: { userId: authUser.id },
        });

        const debited = await tx.walletAccount.updateMany({
          where: {
            id: wallet.id,
            balance: { gte: totalAmount },
          },
          data: {
            balance: { decrement: totalAmount },
          },
        });

        if (debited.count === 0) {
          console.info("[sessions:gifts] wallet debit blocked", {
            sessionId,
            userId: authUser.id,
            giftKey: gift.key,
            quantity,
            walletId: wallet.id,
            walletBalance: wallet.balance,
            giftAmount: gift.amount,
            totalAmount,
            debitCount: debited.count,
          });
          return {
            insufficientBalance: true as const,
            walletBalance: wallet.balance,
            walletDebitedCount: debited.count,
          };
        }

        const updatedWallet = await tx.walletAccount.findUnique({
          where: { id: wallet.id },
          select: { balance: true },
        });
        if (!updatedWallet) throw new HttpError(404, "Wallet account not found.");

        const giftTransaction = await tx.walletTransaction.create({
          data: {
            transactionCode: createCode("TXN"),
            walletAccountId: wallet.id,
            type: TransactionType.GIFT,
            amount: -totalAmount,
            status: TransactionStatus.SUCCESS,
            gateway: "WALLET",
            referenceId: session.id,
            reason: `Gift ${gift.name} x${quantity} sent in session ${session.sessionCode}`,
          },
        });

        const giftSplit = splitAmount(totalAmount, 40, 60);
        await tx.partnerEarning.upsert({
          where: {
            walletTransactionId: giftTransaction.id,
          },
          create: {
            companionId: session.companionId,
            userId: authUser.id,
            // Use wallet transaction as idempotency key for gifts to avoid session-level unique collisions.
            sessionId: null,
            walletTransactionId: giftTransaction.id,
            sourceType: PartnerEarningSourceType.GIFT,
            grossAmount: giftSplit.grossAmount,
            partnerAmount: giftSplit.partnerAmount,
            companyAmount: giftSplit.companyAmount,
            partnerPercent: giftSplit.partnerPercent,
            companyPercent: giftSplit.companyPercent,
            status: PartnerEarningStatus.AVAILABLE,
          },
          update: {
            companionId: session.companionId,
            userId: authUser.id,
            sourceType: PartnerEarningSourceType.GIFT,
            grossAmount: giftSplit.grossAmount,
            partnerAmount: giftSplit.partnerAmount,
            companyAmount: giftSplit.companyAmount,
            partnerPercent: giftSplit.partnerPercent,
            companyPercent: giftSplit.companyPercent,
            status: PartnerEarningStatus.AVAILABLE,
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
              amount: totalAmount,
              quantity,
              unitAmount: gift.amount,
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
          walletDebitedCount: debited.count,
          message: createdMessage,
        };
      });
    } catch (error) {
      console.error("[sessions:gifts] failed", {
        sessionId,
        userId: authUser.id,
        giftKey: gift.key,
        giftName: gift.name,
        giftAmount: gift.amount,
        quantity,
        totalAmount,
        error,
      });
      throw error;
    }

    if (result.insufficientBalance) {
      res.status(402).json({
        error: "INSUFFICIENT_BALANCE",
        message: "You don't have enough wallet balance.",
      });
      return;
    }

    console.info("[sessions:gifts] success", {
      sessionId,
      userId: authUser.id,
      giftKey: gift.key,
      giftName: gift.name,
      quantity,
      totalAmount,
      walletDebitedCount: result.walletDebitedCount,
      walletBalance: result.walletBalance,
    });

    res.status(201).json({
      walletBalance: result.walletBalance,
      gift: {
        giftKey: gift.key,
        giftName: gift.name,
        giftEmoji: gift.emoji,
        amount: totalAmount,
        quantity,
        unitAmount: gift.amount,
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
    const requester = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true, name: true },
    });
    if (!requester) throw new HttpError(404, "User not found.");
    assertUserCanStartSession(requester);

    const companion = await prisma.companion.findUnique({ where: { id: body.companionId } });
    if (!companion) throw new HttpError(404, "Partner not found.");
    assertPartnerCanReceiveRequests(companion);
    if (companion.status !== CompanionStatus.ACTIVE || companion.verificationStatus !== VerificationStatus.VERIFIED) {
      throw new HttpError(403, "Partner is not available for new sessions yet.");
    }
    const serviceType =
      body.serviceType === "chat"
        ? ServiceType.CHAT
        : body.serviceType === "audio"
          ? ServiceType.AUDIO
          : ServiceType.VIDEO;

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
    if (companion.availability === CompanionAvailability.BUSY && !hasActiveChatEscalationContext) {
      throw new HttpError(409, "Partner is currently busy.");
    }
    if (serviceType !== ServiceType.CHAT && !isCompanionOnlineForRequests(companion)) {
      throw new HttpError(409, "Host is offline. Please try later.");
    }

    if (!companion.servicesOffered.includes(serviceType)) {
      throw new HttpError(400, "This service is not offered by the selected partner.");
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
      if (serviceType === ServiceType.CHAT) {
        const now = new Date();
        const updatedChatSession = await prisma.session.update({
          where: { id: existingPending.id },
          data: {
            status: SessionStatus.LIVE,
            acceptedAt: existingPending.acceptedAt ?? now,
            startedAt: existingPending.startedAt ?? now,
            liveStartedAt: existingPending.liveStartedAt ?? now,
            lastHeartbeatAt: now,
          },
          include: { user: true, companion: true, booking: true },
        });
        const metadata = await getSessionRewardAndBillingMetadata(updatedChatSession);
        res.status(200).json({
          session: toSessionResponse(updatedChatSession, authUser.id, metadata.rewardMetadata, metadata.billingLimit),
        });
        return;
      }

      res.status(200).json({
        session: toSessionResponse(existingPending, authUser.id),
      });
      return;
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

    const sessionId = createSessionId();
    const now = new Date();
    const isChatSession = serviceType === ServiceType.CHAT;
    const creationResult = await prisma.$transaction(async (tx) => {
      await normalizeUserRewardReservations(tx, authUser.id);
      const wallet = await tx.walletAccount.upsert({
        where: { userId: authUser.id },
        update: {},
        create: { userId: authUser.id },
      });
      const rewardAdjustedMinimum = await calculateRewardAdjustedBilling(
        tx,
        authUser.id,
        serviceType,
        getMinimumBillingForSessionStart(serviceType),
        new Date(),
      );

      if (wallet.balance < rewardAdjustedMinimum.totalCharge) {
        return {
          insufficient: true as const,
          requiredBalance: rewardAdjustedMinimum.totalCharge,
          walletBalance: wallet.balance,
        };
      }

      const session = await tx.session.create({
        data: {
          id: sessionId,
          sessionCode: createCode("SES"),
          bookingId: body.bookingId,
          userId: authUser.id,
          companionId: body.companionId,
          serviceType,
          status: isChatSession ? SessionStatus.LIVE : SessionStatus.PENDING,
          acceptedAt: isChatSession ? now : null,
          startedAt: isChatSession ? now : null,
          liveStartedAt: isChatSession ? now : null,
          endedAt: null,
          endedByUserId: null,
          lastHeartbeatAt: now,
          amount: serviceType === ServiceType.CHAT ? 0 : getFixedSessionRate(serviceType),
        },
      });

      if (rewardAdjustedMinimum.rewardApplication) {
        const reserved = await tx.userReward.updateMany({
          where: {
            id: rewardAdjustedMinimum.rewardApplication.rewardId,
            userId: authUser.id,
            status: UserRewardStatus.ACTIVE,
            redemptionReferenceId: null,
            remainingValue: { gt: 0 },
            expiresAt: { gt: new Date() },
          },
          data: {
            redemptionReferenceId: session.id,
          },
        });
        if (reserved.count === 0) {
          throw new HttpError(409, "Reward is already in use.");
        }
      }

      return {
        insufficient: false as const,
        session,
        rewardMetadata: toSessionRewardMetadata({
          rewardApplication: rewardAdjustedMinimum.rewardApplication,
          serviceType,
          walletBalance: wallet.balance,
        }),
        billingLimit: buildSessionBillingLimit({
          serviceType,
          walletBalance: wallet.balance,
          rewardApplication: rewardAdjustedMinimum.rewardApplication,
          timerBase: session.liveStartedAt ?? session.startedAt ?? null,
        }),
      };
    });

    if (creationResult.insufficient) {
      res.status(402).json({
        code: INSUFFICIENT_WALLET_BALANCE_CODE,
        message: serviceType === ServiceType.CHAT ? CHAT_LOW_BALANCE_MESSAGE : "Please add money to continue.",
        requiredBalance: creationResult.requiredBalance,
        walletBalance: creationResult.walletBalance,
      });
      return;
    }

    const session = creationResult.session;
    void sendIncomingRequestPush({
      id: session.id,
      companionId: session.companionId,
      serviceType: session.serviceType,
      callerLabel: requester.name || "A member is calling",
    }).catch((error) => {
      console.error("[push] incoming request dispatch failed", {
        sessionId: session.id,
        companionId: session.companionId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: "Push dispatch failed" },
      });
    });
    res.status(201).json({
      session: toSessionResponse(session, authUser.id, creationResult.rewardMetadata, creationResult.billingLimit),
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

    const metadata = await getSessionRewardAndBillingMetadata(updated);
    res.json({ session: toSessionResponse(updated, authUser.id, metadata.rewardMetadata, metadata.billingLimit) });
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

    const updated = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.session.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.CANCELLED,
          endedAt: session.endedAt ?? now,
          endedByUserId: authUser.id,
        },
      });
      if (session.startedAt || session.liveStartedAt) {
        await finalizeStartedSessionRewardReservation(tx, session.id, now);
      } else {
        await releaseUnstartedSessionReward(tx, session);
      }
      return updated;
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

  if (session.serviceType === ServiceType.CHAT) {
    const updated = await prisma.$transaction(async (tx) => {
      const markEnded = await tx.session.updateMany({
        where: {
          id: session.id,
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        data: {
          status: SessionStatus.ENDED,
          endedAt: now,
          endedByUserId: authUser.id,
          durationSeconds,
          lastHeartbeatAt: now,
        },
      });

      if (markEnded.count > 0) {
        await finalizeStartedSessionRewardReservation(tx, session.id, now);
      }

      const next = await tx.session.findUnique({
        where: { id: session.id },
      });
      if (!next) throw new HttpError(404, "Session not found.");
      return next;
    });

    res.json({ session: toSessionResponse(updated, authUser.id) });
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const wallet = await tx.walletAccount.upsert({
      where: { userId: session.userId },
      update: {},
      create: { userId: session.userId },
    });
    const affordableBilling = await calculateAffordableSessionBilling({
      tx,
      userId: session.userId,
      serviceType: session.serviceType,
      requestedDurationSeconds: durationSeconds,
      walletBalance: wallet.balance,
      now,
      reservationReferenceId: session.id,
    });
    const billing = affordableBilling.billing;
    const chargeableDurationSeconds = affordableBilling.chargeableDurationSeconds;
    const sessionSplit = splitAmount(billing.totalCharge, 30, 70);
    const companionEarning = Math.max(0, Math.round(sessionSplit.partnerAmount));
    const platformFee = billing.totalCharge - companionEarning;

    const markEnded = await tx.session.updateMany({
      where: {
        id: session.id,
        status: { in: ACTIVE_SESSION_STATUSES },
      },
      data: {
        status: SessionStatus.ENDED,
        endedAt: now,
        endedByUserId: authUser.id,
        durationSeconds: chargeableDurationSeconds,
        amount: billing.totalCharge,
        companionEarning,
        platformFee,
      },
    });

    if (markEnded.count === 0) {
      const latest = await tx.session.findUnique({
        where: { id: session.id },
      });
      if (!latest) throw new HttpError(404, "Session not found.");
      return latest;
    }

    let chargeSucceeded = billing.totalCharge <= 0;

    if (billing.totalCharge > 0 || billing.rewardApplication) {
      const existingCharge = await tx.walletTransaction.findFirst({
        where: {
          walletAccountId: wallet.id,
          type: TransactionType.BOOKING,
          status: TransactionStatus.SUCCESS,
          referenceId: session.id,
        },
        select: { id: true },
      });

      if (!existingCharge) {
        if (billing.totalCharge <= 0) {
          await tx.walletTransaction.create({
            data: {
              transactionCode: createCode("TXN"),
              walletAccountId: wallet.id,
              type: TransactionType.BOOKING,
              amount: 0,
              status: TransactionStatus.SUCCESS,
              referenceId: session.id,
              reason: buildSessionChargeReason({ sessionCode: session.sessionCode, serviceType: session.serviceType, billing }),
            },
          });
          chargeSucceeded = true;
        } else {
          const debited = await tx.walletAccount.updateMany({
            where: {
              id: wallet.id,
              balance: { gte: billing.totalCharge },
            },
            data: {
              balance: { decrement: billing.totalCharge },
            },
          });

          if (debited.count > 0) {
            await tx.walletTransaction.create({
              data: {
                transactionCode: createCode("TXN"),
                walletAccountId: wallet.id,
                type: TransactionType.BOOKING,
                amount: -billing.totalCharge,
                status: TransactionStatus.SUCCESS,
                referenceId: session.id,
                reason: buildSessionChargeReason({ sessionCode: session.sessionCode, serviceType: session.serviceType, billing }),
              },
            });
            chargeSucceeded = true;
          } else {
            await tx.walletTransaction.create({
              data: {
                transactionCode: createCode("TXN"),
                walletAccountId: wallet.id,
                type: TransactionType.BOOKING,
                amount: -billing.totalCharge,
                status: TransactionStatus.FAILED,
                referenceId: session.id,
                reason: `Session charge failed (insufficient balance) for ${session.sessionCode} (${session.serviceType}) - ${billing.billableMinutes} min x INR ${billing.ratePerMinute}`,
              },
            });
            chargeSucceeded = false;
          }
        }
      } else {
        chargeSucceeded = true;
      }
    }

    await redeemSessionReward(tx, billing.rewardApplication, session.id, now);

    if (chargeSucceeded) {
      const existingSessionEarning = await tx.partnerEarning.findFirst({
        where: {
          sourceType: PartnerEarningSourceType.SESSION,
          sessionId: session.id,
          walletTransactionId: null,
        },
        select: { id: true },
      });

      if (existingSessionEarning) {
        await tx.partnerEarning.update({
          where: { id: existingSessionEarning.id },
          data: {
            grossAmount: sessionSplit.grossAmount,
            partnerAmount: sessionSplit.partnerAmount,
            companyAmount: sessionSplit.companyAmount,
            partnerPercent: sessionSplit.partnerPercent,
            companyPercent: sessionSplit.companyPercent,
          },
        });
      } else {
        await tx.partnerEarning.create({
          data: {
            companionId: session.companionId,
            userId: session.userId,
            sessionId: session.id,
            sourceType: PartnerEarningSourceType.SESSION,
            grossAmount: sessionSplit.grossAmount,
            partnerAmount: sessionSplit.partnerAmount,
            companyAmount: sessionSplit.companyAmount,
            partnerPercent: sessionSplit.partnerPercent,
            companyPercent: sessionSplit.companyPercent,
            status: PartnerEarningStatus.AVAILABLE,
          },
        });
      }
    }

    const next = await tx.session.findUnique({
      where: { id: session.id },
    });
    if (!next) throw new HttpError(404, "Session not found.");
    return next;
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
