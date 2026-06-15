ALTER TABLE "Companion"
  ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinnedAt" TIMESTAMP(3);

CREATE INDEX "Companion_isPinned_pinnedAt_idx"
  ON "Companion"("isPinned", "pinnedAt");
