-- Additive Lucky Wheel reward storage and redemption accounting.
ALTER TYPE "TransactionType" ADD VALUE 'LUCKY_WHEEL_REWARD';

CREATE TYPE "LuckyWheelRewardType" AS ENUM (
  'FREE_CALL_MINUTES',
  'TALK_TIME_CREDIT',
  'FREE_CHAT_MINUTES',
  'VIDEO_DISCOUNT_PERCENT'
);

CREATE TYPE "UserRewardStatus" AS ENUM (
  'ACTIVE',
  'REDEEMED',
  'EXPIRED'
);

CREATE TYPE "UserRewardSource" AS ENUM (
  'LUCKY_WHEEL'
);

CREATE TABLE "LuckyWheelSpin" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rewardType" "LuckyWheelRewardType" NOT NULL,
  "rewardValue" INTEGER NOT NULL,
  "rewardLabel" TEXT NOT NULL,
  "rewardIndex" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),

  CONSTRAINT "LuckyWheelSpin_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserReward" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "LuckyWheelRewardType" NOT NULL,
  "value" INTEGER NOT NULL,
  "remainingValue" INTEGER NOT NULL,
  "status" "UserRewardStatus" NOT NULL DEFAULT 'ACTIVE',
  "source" "UserRewardSource" NOT NULL DEFAULT 'LUCKY_WHEEL',
  "sourceSpinId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "redeemedAt" TIMESTAMP(3),
  "redemptionReferenceId" TEXT,
  "walletTransactionId" TEXT,

  CONSTRAINT "UserReward_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LuckyWheelSpin_userId_createdAt_idx" ON "LuckyWheelSpin"("userId", "createdAt");
CREATE INDEX "LuckyWheelSpin_rewardType_createdAt_idx" ON "LuckyWheelSpin"("rewardType", "createdAt");

CREATE UNIQUE INDEX "UserReward_sourceSpinId_key" ON "UserReward"("sourceSpinId");
CREATE UNIQUE INDEX "UserReward_walletTransactionId_key" ON "UserReward"("walletTransactionId");
CREATE INDEX "UserReward_userId_status_expiresAt_idx" ON "UserReward"("userId", "status", "expiresAt");
CREATE INDEX "UserReward_type_status_expiresAt_idx" ON "UserReward"("type", "status", "expiresAt");
CREATE INDEX "UserReward_source_createdAt_idx" ON "UserReward"("source", "createdAt");
CREATE INDEX "UserReward_redemptionReferenceId_idx" ON "UserReward"("redemptionReferenceId");

ALTER TABLE "LuckyWheelSpin"
  ADD CONSTRAINT "LuckyWheelSpin_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserReward"
  ADD CONSTRAINT "UserReward_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserReward"
  ADD CONSTRAINT "UserReward_sourceSpinId_fkey"
  FOREIGN KEY ("sourceSpinId") REFERENCES "LuckyWheelSpin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserReward"
  ADD CONSTRAINT "UserReward_walletTransactionId_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
