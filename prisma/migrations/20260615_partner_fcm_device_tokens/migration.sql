-- Additive storage for native Android FCM tokens used by YoPartner Host.
CREATE TABLE "FcmDeviceToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companionId" TEXT,
  "token" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'android',
  "appPackage" TEXT,
  "appVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "FcmDeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FcmDeviceToken_token_key" ON "FcmDeviceToken"("token");
CREATE INDEX "FcmDeviceToken_userId_revokedAt_idx" ON "FcmDeviceToken"("userId", "revokedAt");
CREATE INDEX "FcmDeviceToken_companionId_revokedAt_idx" ON "FcmDeviceToken"("companionId", "revokedAt");

ALTER TABLE "FcmDeviceToken"
  ADD CONSTRAINT "FcmDeviceToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FcmDeviceToken"
  ADD CONSTRAINT "FcmDeviceToken_companionId_fkey"
  FOREIGN KEY ("companionId") REFERENCES "Companion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
