import { Router } from "express";
import {
  LuckyWheelRewardType,
  Prisma,
  TransactionStatus,
  TransactionType,
  UserRewardSource,
  UserRewardStatus,
} from "@prisma/client";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode } from "../utils/http";
import { normalizeUserRewardReservations } from "../services/rewardReservations";

type LuckyWheelRewardConfig = {
  id: string;
  rewardIndex: number;
  type: LuckyWheelRewardType;
  value: number;
  label: string;
};

const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const REWARD_EXPIRY_DAYS = 7;

const luckyWheelRewards: LuckyWheelRewardConfig[] = [
  {
    id: "free_call_2",
    rewardIndex: 0,
    type: LuckyWheelRewardType.FREE_CALL_MINUTES,
    value: 2,
    label: "1 Free Call - 2 Minutes",
  },
  {
    id: "talktime_20",
    rewardIndex: 1,
    type: LuckyWheelRewardType.TALK_TIME_CREDIT,
    value: 20,
    label: "+₹20 Talktime",
  },
  {
    id: "free_chat_5",
    rewardIndex: 2,
    type: LuckyWheelRewardType.FREE_CHAT_MINUTES,
    value: 5,
    label: "5 Free Chat Minutes",
  },
  {
    id: "video_discount_10",
    rewardIndex: 3,
    type: LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT,
    value: 10,
    label: "10% OFF Video Call",
  },
];

export const luckyWheelRouter = Router();

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function rewardClientType(type: LuckyWheelRewardType) {
  if (type === LuckyWheelRewardType.FREE_CALL_MINUTES) return "free_call";
  if (type === LuckyWheelRewardType.TALK_TIME_CREDIT) return "talktime";
  if (type === LuckyWheelRewardType.FREE_CHAT_MINUTES) return "free_chat";
  return "video_discount";
}

function rewardConfigForType(type: LuckyWheelRewardType) {
  return luckyWheelRewards.find((reward) => reward.type === type) ?? luckyWheelRewards[0];
}

function rewardPayload(input: {
  id?: string;
  type: LuckyWheelRewardType;
  value: number;
  remainingValue?: number | null;
  status?: UserRewardStatus;
  rewardIndex?: number;
  label?: string;
  createdAt?: Date;
  expiresAt?: Date | null;
  redeemedAt?: Date | null;
}) {
  const config = rewardConfigForType(input.type);
  return {
    id: input.id ?? config.id,
    rewardIndex: input.rewardIndex ?? config.rewardIndex,
    type: input.type,
    clientType: rewardClientType(input.type),
    value: input.value,
    remainingValue: input.remainingValue ?? input.value,
    label: input.label ?? config.label,
    resultLabel: input.label ?? config.label,
    status: input.status,
    createdAt: input.createdAt ? input.createdAt.toISOString() : null,
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    redeemedAt: input.redeemedAt ? input.redeemedAt.toISOString() : null,
  };
}

async function expireOldRewards(userId: string, now: Date) {
  await prisma.userReward.updateMany({
    where: {
      userId,
      status: UserRewardStatus.ACTIVE,
      expiresAt: { lte: now },
    },
    data: {
      status: UserRewardStatus.EXPIRED,
    },
  });
}

async function getLuckyWheelState(userId: string, now = new Date()) {
  await expireOldRewards(userId, now);
  await prisma.$transaction((tx) => normalizeUserRewardReservations(tx, userId, now));

  const [lastSpin, activeRewards] = await Promise.all([
    prisma.luckyWheelSpin.findFirst({
      where: { userId },
      include: { userReward: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.userReward.findMany({
      where: {
        userId,
        status: UserRewardStatus.ACTIVE,
        expiresAt: { gt: now },
        redemptionReferenceId: null,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const nextSpinAt = lastSpin ? new Date(lastSpin.createdAt.getTime() + SPIN_COOLDOWN_MS) : null;
  const canSpin = !nextSpinAt || nextSpinAt <= now;

  return {
    canSpin,
    nextSpinAt: canSpin ? null : nextSpinAt?.toISOString() ?? null,
    lastReward: lastSpin
      ? rewardPayload({
          id: lastSpin.userReward?.id,
          type: lastSpin.rewardType,
          value: lastSpin.rewardValue,
          remainingValue: lastSpin.userReward?.remainingValue ?? lastSpin.rewardValue,
          status: lastSpin.userReward?.status,
          rewardIndex: lastSpin.rewardIndex,
          label: lastSpin.rewardLabel,
          createdAt: lastSpin.createdAt,
          expiresAt: lastSpin.expiresAt,
          redeemedAt: lastSpin.userReward?.redeemedAt,
        })
      : null,
    activeRewards: activeRewards.map((reward) =>
      rewardPayload({
        id: reward.id,
        type: reward.type,
        value: reward.value,
        remainingValue: reward.remainingValue,
        status: reward.status,
        createdAt: reward.createdAt,
        expiresAt: reward.expiresAt,
        redeemedAt: reward.redeemedAt,
      }),
    ),
  };
}

function pickReward() {
  return luckyWheelRewards[Math.floor(Math.random() * luckyWheelRewards.length)];
}

async function spinForUser(userId: string) {
  const now = new Date();

  const createSpin = async () =>
    prisma.$transaction(
      async (tx) => {
        await tx.userReward.updateMany({
          where: {
            userId,
            status: UserRewardStatus.ACTIVE,
            expiresAt: { lte: now },
          },
          data: { status: UserRewardStatus.EXPIRED },
        });
        await normalizeUserRewardReservations(tx, userId, now);

        const lastSpin = await tx.luckyWheelSpin.findFirst({
          where: { userId },
          include: { userReward: true },
          orderBy: { createdAt: "desc" },
        });
        const nextSpinAt = lastSpin ? new Date(lastSpin.createdAt.getTime() + SPIN_COOLDOWN_MS) : null;

        if (lastSpin && nextSpinAt && nextSpinAt > now) {
          const activeRewards = await tx.userReward.findMany({
            where: {
              userId,
              status: UserRewardStatus.ACTIVE,
              expiresAt: { gt: now },
              redemptionReferenceId: null,
            },
            orderBy: { createdAt: "asc" },
          });

          return {
            spun: false,
            canSpin: false,
            nextSpinAt: nextSpinAt.toISOString(),
            reward: rewardPayload({
              id: lastSpin?.userReward?.id,
              type: lastSpin.rewardType,
              value: lastSpin.rewardValue,
              remainingValue: lastSpin.userReward?.remainingValue ?? lastSpin.rewardValue,
              status: lastSpin.userReward?.status,
              rewardIndex: lastSpin.rewardIndex,
              label: lastSpin.rewardLabel,
              createdAt: lastSpin.createdAt,
              expiresAt: lastSpin.expiresAt,
              redeemedAt: lastSpin.userReward?.redeemedAt,
            }),
            activeRewards: activeRewards.map((reward) =>
              rewardPayload({
                id: reward.id,
                type: reward.type,
                value: reward.value,
                remainingValue: reward.remainingValue,
                status: reward.status,
                createdAt: reward.createdAt,
                expiresAt: reward.expiresAt,
                redeemedAt: reward.redeemedAt,
              }),
            ),
          };
        }

        const reward = pickReward();
        const expiresAt = addDays(now, REWARD_EXPIRY_DAYS);
        const spin = await tx.luckyWheelSpin.create({
          data: {
            userId,
            rewardType: reward.type,
            rewardValue: reward.value,
            rewardLabel: reward.label,
            rewardIndex: reward.rewardIndex,
            expiresAt,
          },
        });

        let userReward = await tx.userReward.create({
          data: {
            userId,
            type: reward.type,
            value: reward.value,
            remainingValue: reward.value,
            status: UserRewardStatus.ACTIVE,
            source: UserRewardSource.LUCKY_WHEEL,
            sourceSpinId: spin.id,
            expiresAt,
          },
        });

        if (reward.type === LuckyWheelRewardType.TALK_TIME_CREDIT) {
          const wallet = await tx.walletAccount.upsert({
            where: { userId },
            update: {},
            create: { userId },
          });

          const existingCredit = await tx.walletTransaction.findFirst({
            where: {
              walletAccountId: wallet.id,
              type: TransactionType.LUCKY_WHEEL_REWARD,
              status: TransactionStatus.SUCCESS,
              referenceId: userReward.id,
            },
            select: { id: true },
          });

          let walletTransactionId = existingCredit?.id ?? null;
          if (!walletTransactionId) {
            await tx.walletAccount.update({
              where: { id: wallet.id },
              data: { balance: { increment: reward.value } },
            });
            const transaction = await tx.walletTransaction.create({
              data: {
                transactionCode: createCode("TXN"),
                walletAccountId: wallet.id,
                type: TransactionType.LUCKY_WHEEL_REWARD,
                amount: reward.value,
                status: TransactionStatus.SUCCESS,
                gateway: "LUCKY_WHEEL",
                referenceId: userReward.id,
                reason: `Lucky Wheel reward credited: ${reward.label}`,
              },
            });
            walletTransactionId = transaction.id;
          }

          userReward = await tx.userReward.update({
            where: { id: userReward.id },
            data: {
              remainingValue: 0,
              status: UserRewardStatus.REDEEMED,
              redeemedAt: now,
              redemptionReferenceId: walletTransactionId,
              walletTransactionId,
            },
          });
        }

        const activeRewards = await tx.userReward.findMany({
          where: {
            userId,
            status: UserRewardStatus.ACTIVE,
            expiresAt: { gt: now },
            redemptionReferenceId: null,
          },
          orderBy: { createdAt: "asc" },
        });

        return {
          spun: true,
          canSpin: false,
          nextSpinAt: new Date(spin.createdAt.getTime() + SPIN_COOLDOWN_MS).toISOString(),
          reward: rewardPayload({
            id: userReward.id,
            type: reward.type,
            value: reward.value,
            remainingValue: userReward.remainingValue,
            status: userReward.status,
            rewardIndex: reward.rewardIndex,
            label: reward.label,
            createdAt: spin.createdAt,
            expiresAt,
            redeemedAt: userReward.redeemedAt,
          }),
          activeRewards: activeRewards.map((activeReward) =>
            rewardPayload({
              id: activeReward.id,
              type: activeReward.type,
              value: activeReward.value,
              remainingValue: activeReward.remainingValue,
              status: activeReward.status,
              createdAt: activeReward.createdAt,
              expiresAt: activeReward.expiresAt,
              redeemedAt: activeReward.redeemedAt,
            }),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  try {
    return await createSpin();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return createSpin();
    }
    throw error;
  }
}

luckyWheelRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = await getLuckyWheelState(req.authUser!.id);
    res.json(state);
  }),
);

luckyWheelRouter.post(
  "/spin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await spinForUser(req.authUser!.id);
    res.status(result.spun ? 201 : 200).json(result);
  }),
);
