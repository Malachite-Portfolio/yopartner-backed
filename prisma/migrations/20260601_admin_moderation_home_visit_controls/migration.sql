-- CreateEnum
CREATE TYPE "UserModerationStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'TEMP_BANNED', 'BANNED');

-- CreateEnum
CREATE TYPE "PartnerModerationStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'TEMP_BANNED', 'BANNED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "HomeVisitVerificationStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ModerationTargetType" AS ENUM ('USER', 'PARTNER', 'HOME_VISIT');

-- AlterTable
ALTER TABLE "Companion" ADD COLUMN     "homeVisitVerificationNote" TEXT,
ADD COLUMN     "homeVisitVerificationStatus" "HomeVisitVerificationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "homeVisitVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "homeVisitVerifiedBy" TEXT,
ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" TEXT,
ADD COLUMN     "moderationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "moderationReason" TEXT,
ADD COLUMN     "moderationStatus" "PartnerModerationStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "PartnerApplication" ADD COLUMN     "homeVisitPrice" INTEGER,
ADD COLUMN     "homeVisitRequested" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" TEXT,
ADD COLUMN     "moderationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "moderationReason" TEXT,
ADD COLUMN     "moderationStatus" "UserModerationStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "targetType" "ModerationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationAction_targetType_targetId_createdAt_idx" ON "ModerationAction"("targetType", "targetId", "createdAt");

