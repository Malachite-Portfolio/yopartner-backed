import {
  LuckyWheelRewardType,
  Prisma,
  SessionStatus,
  UserRewardStatus,
} from "@prisma/client";

const sessionRewardTypes = [
  LuckyWheelRewardType.FREE_CALL_MINUTES,
  LuckyWheelRewardType.FREE_CHAT_MINUTES,
  LuckyWheelRewardType.VIDEO_DISCOUNT_PERCENT,
];

const terminalSessionStatuses: SessionStatus[] = [
  SessionStatus.CANCELLED,
  SessionStatus.COMPLETED,
  SessionStatus.DECLINED,
  SessionStatus.ENDED,
  SessionStatus.EXPIRED,
  SessionStatus.FAILED,
  SessionStatus.FLAGGED,
];

type RewardReservationClient = Pick<Prisma.TransactionClient, "session" | "userReward">;

type ReservedReward = {
  id: string;
  redemptionReferenceId: string | null;
};

function isStartedSession(session: { startedAt: Date | null; liveStartedAt: Date | null }) {
  return Boolean(session.startedAt || session.liveStartedAt);
}

async function releaseRewards(tx: RewardReservationClient, rewardIds: string[]) {
  if (rewardIds.length === 0) return 0;
  const released = await tx.userReward.updateMany({
    where: {
      id: { in: rewardIds },
      status: UserRewardStatus.ACTIVE,
    },
    data: {
      redemptionReferenceId: null,
    },
  });
  return released.count;
}

async function redeemRewards(tx: RewardReservationClient, rewardIds: string[], now: Date) {
  if (rewardIds.length === 0) return 0;
  const redeemed = await tx.userReward.updateMany({
    where: {
      id: { in: rewardIds },
      status: UserRewardStatus.ACTIVE,
    },
    data: {
      remainingValue: 0,
      status: UserRewardStatus.REDEEMED,
      redeemedAt: now,
    },
  });
  return redeemed.count;
}

export async function normalizeUserRewardReservations(
  tx: RewardReservationClient,
  userId: string,
  now = new Date(),
) {
  const reservedRewards = await tx.userReward.findMany({
    where: {
      userId,
      type: { in: sessionRewardTypes },
      status: UserRewardStatus.ACTIVE,
      remainingValue: { gt: 0 },
      redemptionReferenceId: { not: null },
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      redemptionReferenceId: true,
    },
  });

  if (reservedRewards.length === 0) {
    return { released: 0, redeemed: 0 };
  }

  const rewardsByReference = new Map<string, ReservedReward[]>();
  for (const reward of reservedRewards) {
    if (!reward.redemptionReferenceId) continue;
    const rewards = rewardsByReference.get(reward.redemptionReferenceId) ?? [];
    rewards.push(reward);
    rewardsByReference.set(reward.redemptionReferenceId, rewards);
  }

  const sessions = await tx.session.findMany({
    where: { id: { in: [...rewardsByReference.keys()] } },
    select: {
      id: true,
      status: true,
      startedAt: true,
      liveStartedAt: true,
    },
  });
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  const rewardsToRelease: string[] = [];
  const rewardsToRedeem: string[] = [];

  for (const [referenceId, rewards] of rewardsByReference) {
    const session = sessionsById.get(referenceId);
    if (!session) {
      rewardsToRelease.push(...rewards.map((reward) => reward.id));
      continue;
    }

    if (!terminalSessionStatuses.includes(session.status)) continue;

    if (isStartedSession(session)) {
      rewardsToRedeem.push(...rewards.map((reward) => reward.id));
    } else {
      rewardsToRelease.push(...rewards.map((reward) => reward.id));
    }
  }

  const [released, redeemed] = await Promise.all([
    releaseRewards(tx, rewardsToRelease),
    redeemRewards(tx, rewardsToRedeem, now),
  ]);

  return { released, redeemed };
}

export async function finalizeStartedSessionRewardReservation(
  tx: Pick<Prisma.TransactionClient, "userReward">,
  sessionId: string,
  now = new Date(),
) {
  const finalized = await tx.userReward.updateMany({
    where: {
      type: { in: sessionRewardTypes },
      status: UserRewardStatus.ACTIVE,
      redemptionReferenceId: sessionId,
    },
    data: {
      remainingValue: 0,
      status: UserRewardStatus.REDEEMED,
      redeemedAt: now,
    },
  });
  return finalized.count;
}
