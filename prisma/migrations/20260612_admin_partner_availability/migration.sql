CREATE TYPE "CompanionAvailability" AS ENUM ('ONLINE', 'BUSY', 'OFFLINE');

ALTER TABLE "Companion"
ADD COLUMN "availability" "CompanionAvailability" NOT NULL DEFAULT 'OFFLINE',
ADD COLUMN "availabilitySetByAdminAt" TIMESTAMP(3);

UPDATE "Companion"
SET "availability" = CASE
  WHEN "isOnline" = TRUE THEN 'ONLINE'::"CompanionAvailability"
  ELSE 'OFFLINE'::"CompanionAvailability"
END;
