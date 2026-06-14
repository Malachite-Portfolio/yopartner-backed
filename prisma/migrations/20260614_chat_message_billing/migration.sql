ALTER TABLE "ChatMessage"
  ADD COLUMN "clientMessageId" TEXT,
  ADD COLUMN "walletTransactionId" TEXT;

CREATE UNIQUE INDEX "ChatMessage_sessionId_clientMessageId_key"
  ON "ChatMessage"("sessionId", "clientMessageId");

CREATE UNIQUE INDEX "ChatMessage_walletTransactionId_key"
  ON "ChatMessage"("walletTransactionId");

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_walletTransactionId_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX IF EXISTS "PartnerEarning_sourceType_sessionId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PartnerEarning_session_unique_without_transaction_idx"
  ON "PartnerEarning"("sourceType", "sessionId")
  WHERE "walletTransactionId" IS NULL;
