-- Additive storage for partner Web Push subscriptions.
CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companionId" TEXT,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_revokedAt_idx" ON "PushSubscription"("userId", "revokedAt");
CREATE INDEX "PushSubscription_companionId_revokedAt_idx" ON "PushSubscription"("companionId", "revokedAt");

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_companionId_fkey"
  FOREIGN KEY ("companionId") REFERENCES "Companion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
