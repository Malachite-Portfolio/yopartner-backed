ALTER TABLE "Companion"
  ALTER COLUMN "chatPrice" DROP DEFAULT,
  ALTER COLUMN "chatPrice" TYPE DECIMAL(10, 2)
    USING ("chatPrice"::DECIMAL(10, 2)),
  ALTER COLUMN "chatPrice" SET DEFAULT 2.50;

ALTER TABLE "PartnerApplication"
  ALTER COLUMN "chatPrice" DROP DEFAULT,
  ALTER COLUMN "chatPrice" TYPE DECIMAL(10, 2)
    USING ("chatPrice"::DECIMAL(10, 2)),
  ALTER COLUMN "chatPrice" SET DEFAULT 2.50;
