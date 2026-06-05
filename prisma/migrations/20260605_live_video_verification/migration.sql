ALTER TABLE "PartnerApplication"
ADD COLUMN     "liveVerificationName" TEXT,
ADD COLUMN     "liveVerificationAge" INTEGER,
ADD COLUMN     "liveVerificationHobbies" TEXT,
ADD COLUMN     "liveVideoUploaded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveVideoFileName" TEXT,
ADD COLUMN     "liveVideoStoragePath" TEXT,
ADD COLUMN     "liveVerificationSubmittedAt" TIMESTAMP(3);
