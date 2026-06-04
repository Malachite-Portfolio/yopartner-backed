import { Router } from "express";
import {
  CompanionStatus,
  HomeVisitVerificationStatus,
  ModerationTargetType,
  PartnerModerationStatus,
  PartnerEarningSourceType,
  PartnerEarningStatus,
  PartnerApplicationStatus,
  PayoutStatus,
  Prisma,
  Role,
  SessionStatus,
  TransactionStatus,
  TransactionType,
  UserModerationStatus,
  VerificationStatus,
} from "@prisma/client";
import { requireAdminAccess } from "../middlewares/adminAccess";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { firebaseAdminStorage } from "../config/firebaseAdmin";
import {
  isPartnerTemporaryStatus,
  isUserTemporaryStatus,
  parseTemporaryExpiry,
  resolvePartnerModerationStatus,
  resolveUserModerationStatus,
  toPartnerOffline,
  toUserBlocked,
} from "../utils/moderation";
import {
  AUDIO_RATE_PER_MIN,
  CHAT_RATE_PER_MIN,
  HOME_VISIT_RATE_PER_HOUR,
  VIDEO_RATE_PER_MIN,
} from "../config/platformPricing";

export const adminRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];
const MAX_MANUAL_WALLET_CREDIT_AMOUNT = 10_000;
const KYC_STORAGE_PREFIX = "YoPartner/partner-kyc/";

adminRouter.use(requireAdminAccess);

const DEMO_PARTNER_FIREBASE_UID = "demo-host-4455667788";
const shouldExcludeDemoPartner =
  process.env.NEXT_PUBLIC_CLIENT_DEMO_ENABLED !== "true" &&
  process.env.CLIENT_DEMO_ENABLED !== "true";

type KycDocumentType = "selfie" | "aadhaarFront" | "aadhaarBack" | "pan";

const kycDocumentFields: Record<KycDocumentType, {
  uploadedField: "selfieUploaded" | "aadhaarFrontUploaded" | "aadhaarBackUploaded" | "panUploaded";
  storagePathField: "selfieStoragePath" | "aadhaarFrontStoragePath" | "aadhaarBackStoragePath" | "panStoragePath";
  urlField: "selfieUrl" | "aadhaarFrontUrl" | "aadhaarBackUrl" | "panUrl";
  fileNameField: "selfieFileName" | "aadhaarFrontFileName" | "aadhaarBackFileName" | "panFileName";
}> = {
  selfie: {
    uploadedField: "selfieUploaded",
    storagePathField: "selfieStoragePath",
    urlField: "selfieUrl",
    fileNameField: "selfieFileName",
  },
  aadhaarFront: {
    uploadedField: "aadhaarFrontUploaded",
    storagePathField: "aadhaarFrontStoragePath",
    urlField: "aadhaarFrontUrl",
    fileNameField: "aadhaarFrontFileName",
  },
  aadhaarBack: {
    uploadedField: "aadhaarBackUploaded",
    storagePathField: "aadhaarBackStoragePath",
    urlField: "aadhaarBackUrl",
    fileNameField: "aadhaarBackFileName",
  },
  pan: {
    uploadedField: "panUploaded",
    storagePathField: "panStoragePath",
    urlField: "panUrl",
    fileNameField: "panFileName",
  },
};

function parseKycDocumentType(value: unknown): KycDocumentType | null {
  if (value === "selfie" || value === "aadhaarFront" || value === "aadhaarBack" || value === "pan") return value;
  return null;
}

function parseFirebaseStorageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "firebasestorage.googleapis.com") {
      const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (!match) return null;
      return {
        bucketName: decodeURIComponent(match[1]),
        objectPath: decodeURIComponent(match[2]),
      };
    }
    if (url.hostname === "storage.googleapis.com") {
      const [, bucketName, ...pathParts] = url.pathname.split("/");
      if (!bucketName || pathParts.length === 0) return null;
      return {
        bucketName: decodeURIComponent(bucketName),
        objectPath: decodeURIComponent(pathParts.join("/")),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function resolveKycStorageObject(storagePath: string | null, url: string | null) {
  const normalizedStoragePath = storagePath?.trim() ?? "";
  if (normalizedStoragePath.startsWith("gs://")) {
    const withoutScheme = normalizedStoragePath.slice("gs://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex > 0) {
      return {
        bucketName: withoutScheme.slice(0, slashIndex),
        objectPath: withoutScheme.slice(slashIndex + 1),
      };
    }
  }

  if (normalizedStoragePath && !/^https?:\/\//i.test(normalizedStoragePath)) {
    return {
      bucketName: null,
      objectPath: normalizedStoragePath.replace(/^\/+/, ""),
    };
  }

  const parsedUrl = url ? parseFirebaseStorageUrl(url) : null;
  if (parsedUrl) return parsedUrl;

  if (normalizedStoragePath) {
    const parsedStoragePathUrl = parseFirebaseStorageUrl(normalizedStoragePath);
    if (parsedStoragePathUrl) return parsedStoragePathUrl;
  }

  return null;
}

function withFixedCompanionPrices<T extends { chatPrice?: number; audioPrice?: number; videoPrice?: number }>(companion: T) {
  return {
    ...companion,
    chatPrice: CHAT_RATE_PER_MIN,
    audioPrice: AUDIO_RATE_PER_MIN,
    videoPrice: VIDEO_RATE_PER_MIN,
  };
}

function withFixedApplicationPrices<
  T extends {
    chatPrice?: number;
    audioPrice?: number;
    videoPrice?: number;
    homeVisitRequested?: boolean;
    homeVisitPrice?: number | null;
    companion?: ({ chatPrice?: number; audioPrice?: number; videoPrice?: number } | null);
  },
>(application: T) {
  return {
    ...application,
    chatPrice: CHAT_RATE_PER_MIN,
    audioPrice: AUDIO_RATE_PER_MIN,
    videoPrice: VIDEO_RATE_PER_MIN,
    homeVisitPrice: application.homeVisitRequested ? HOME_VISIT_RATE_PER_HOUR : null,
    companion: application.companion ? withFixedCompanionPrices(application.companion) : null,
  };
}

function parseTransactionType(value: unknown): TransactionType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === TransactionType.RECHARGE ||
    normalized === TransactionType.BOOKING ||
    normalized === TransactionType.GIFT ||
    normalized === TransactionType.REFUND ||
    normalized === TransactionType.ADMIN_CREDIT
  ) {
    return normalized as TransactionType;
  }
  return null;
}

function parseTransactionStatus(value: unknown): TransactionStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === TransactionStatus.SUCCESS ||
    normalized === TransactionStatus.PENDING ||
    normalized === TransactionStatus.FAILED
  ) {
    return normalized as TransactionStatus;
  }
  return null;
}

function parseUserModerationStatus(value: unknown): UserModerationStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === UserModerationStatus.ACTIVE ||
    normalized === UserModerationStatus.RESTRICTED ||
    normalized === UserModerationStatus.TEMP_BANNED ||
    normalized === UserModerationStatus.BANNED
  ) {
    return normalized as UserModerationStatus;
  }
  return null;
}

function parsePartnerModerationStatus(value: unknown): PartnerModerationStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === PartnerModerationStatus.ACTIVE ||
    normalized === PartnerModerationStatus.RESTRICTED ||
    normalized === PartnerModerationStatus.TEMP_BANNED ||
    normalized === PartnerModerationStatus.BANNED ||
    normalized === PartnerModerationStatus.HIDDEN
  ) {
    return normalized as PartnerModerationStatus;
  }
  return null;
}

function parseHomeVisitVerificationStatus(value: unknown): HomeVisitVerificationStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === HomeVisitVerificationStatus.NOT_SUBMITTED ||
    normalized === HomeVisitVerificationStatus.PENDING ||
    normalized === HomeVisitVerificationStatus.APPROVED ||
    normalized === HomeVisitVerificationStatus.REJECTED ||
    normalized === HomeVisitVerificationStatus.NEEDS_INFO ||
    normalized === HomeVisitVerificationStatus.SUSPENDED
  ) {
    return normalized as HomeVisitVerificationStatus;
  }
  return null;
}

function parsePaidAmountFromReason(reason: string | null, fallbackAmount: number) {
  if (!reason) return Math.abs(fallbackAmount);
  const match = reason.match(/\bpay=(\d+)\b/i);
  if (!match) return Math.abs(fallbackAmount);
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Math.abs(fallbackAmount);
}

function decimalToNumber(value: Prisma.Decimal | number | null | undefined) {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

adminRouter.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    const [
      usersCount,
      companionsCount,
      pendingApplicationsCount,
      sessionsLiveCount,
      bookingsCount,
      rechargeTotal,
      pendingPayoutsCount,
      supportOpenCount,
    ] = await Promise.all([
      prisma.user.count({ where: { role: Role.USER } }),
      prisma.companion.count({ where: { status: CompanionStatus.ACTIVE } }),
      prisma.partnerApplication.count({ where: { status: PartnerApplicationStatus.UNDER_REVIEW } }),
      prisma.session.count({ where: { status: SessionStatus.LIVE } }),
      prisma.booking.count(),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.RECHARGE, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
      }),
      prisma.payout.count({ where: { status: PayoutStatus.REQUESTED } }),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
    ]);

    res.json({
      stats: {
        usersCount,
        companionsCount,
        pendingApplicationsCount,
        sessionsLiveCount,
        bookingsCount,
        rechargeTotal: rechargeTotal._sum.amount ?? 0,
        pendingPayoutsCount,
        supportOpenCount,
      },
    });
  }),
);

adminRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      include: { walletAccount: true, bookings: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      users: users.map((user) => ({
        ...user,
        moderationStatus: resolveUserModerationStatus(user),
      })),
    });
  }),
);

adminRouter.post(
  "/users/:userId/wallet/credit",
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId ?? "").trim();
    if (!userId) throw new HttpError(400, "User ID is required.");

    const parsedAmount =
      typeof req.body?.amount === "number" ? req.body.amount : Number(req.body?.amount);
    if (!Number.isFinite(parsedAmount)) {
      throw new HttpError(400, "amount must be a valid number.");
    }
    if (!Number.isInteger(parsedAmount)) {
      throw new HttpError(400, "amount must be an integer value in rupees.");
    }
    if (parsedAmount <= 0) {
      throw new HttpError(400, "amount must be greater than 0.");
    }
    if (parsedAmount > MAX_MANUAL_WALLET_CREDIT_AMOUNT) {
      throw new HttpError(400, `amount cannot exceed ₹${MAX_MANUAL_WALLET_CREDIT_AMOUNT}.`);
    }

    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim().length > 0
        ? req.body.reason.trim()
        : "Admin manual credit";

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
      },
    });

    if (!user) throw new HttpError(404, "User not found.");

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.walletAccount.upsert({
        where: { userId: user.id },
        update: {
          balance: {
            increment: parsedAmount,
          },
        },
        create: {
          userId: user.id,
          balance: parsedAmount,
        },
      });

      const transaction = await tx.walletTransaction.create({
        data: {
          transactionCode: createCode("TXN"),
          walletAccountId: wallet.id,
          type: TransactionType.ADMIN_CREDIT,
          amount: parsedAmount,
          status: TransactionStatus.SUCCESS,
          gateway: "ADMIN",
          referenceId: req.authUser?.adminLoginId
            ? `ADMIN:${req.authUser.adminLoginId}`
            : `ADMIN:${req.authUser?.id ?? "SYSTEM"}`,
          reason,
        },
      });

      return {
        wallet,
        transaction,
      };
    });

    res.status(201).json({
      user,
      creditedAmount: parsedAmount,
      updatedBalance: result.wallet.balance,
      transaction: result.transaction,
    });
  }),
);

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!user) throw new HttpError(404, "User not found.");
    const walletDelta = typeof req.body.walletDelta === "number" ? req.body.walletDelta : 0;

    const updatedUser = await prisma.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: user.id },
        data: {
          ...(typeof req.body.name === "string" ? { name: req.body.name } : {}),
          ...(typeof req.body.isBlocked === "boolean" ? { isBlocked: req.body.isBlocked } : {}),
        },
      });
      if (walletDelta !== 0) {
        const wallet = await tx.walletAccount.update({
          where: { userId: user.id },
          data: { balance: { increment: walletDelta } },
        });
        await tx.walletTransaction.create({
          data: {
            transactionCode: createCode("TXN"),
            walletAccountId: wallet.id,
            type: TransactionType.ADMIN_CREDIT,
            amount: walletDelta,
            status: TransactionStatus.SUCCESS,
            reason: "Admin wallet credit adjustment",
          },
        });
      }
      return nextUser;
    });

    res.json({ user: updatedUser });
  }),
);

adminRouter.get(
  "/companions",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        ...(shouldExcludeDemoPartner
          ? {
              user: {
                firebaseUid: {
                  not: DEMO_PARTNER_FIREBASE_UID,
                },
              },
            }
          : {}),
      },
      include: { user: true, sessions: true },
      orderBy: { createdAt: "desc" },
    });
    const companionIds = companions.map((companion) => companion.id);
    const staleThreshold = new Date(Date.now() - STALE_ACTIVE_SESSION_MS);
    if (companionIds.length > 0) {
      await prisma.session.updateMany({
        where: {
          companionId: { in: companionIds },
          status: { in: ACTIVE_SESSION_STATUSES },
          endedAt: null,
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status: SessionStatus.EXPIRED,
          endedAt: new Date(),
        },
      });
    }
    const busySessions = companionIds.length
      ? await prisma.session.findMany({
          where: {
            companionId: { in: companionIds },
            status: { in: ACTIVE_SESSION_STATUSES },
            endedAt: null,
            updatedAt: { gte: staleThreshold },
          },
          select: { companionId: true },
        })
      : [];
    const busySet = new Set(busySessions.map((session) => session.companionId));

    res.json({
      companions: companions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        const effectiveStatus = !companion.isOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
        return {
          ...withFixedCompanionPrices(companion),
          moderationStatus: resolvePartnerModerationStatus(companion),
          isBusy,
          effectiveStatus,
        };
      }),
    });
  }),
);

adminRouter.patch(
  "/users/:id/status",
  asyncHandler(async (req, res) => {
    const userId = String(req.params.id ?? "").trim();
    if (!userId) throw new HttpError(400, "User ID is required.");

    const nextStatus = parseUserModerationStatus(req.body?.status);
    if (!nextStatus) {
      throw new HttpError(400, "status must be ACTIVE, RESTRICTED, TEMP_BANNED, or BANNED.");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw new HttpError(400, "reason is required.");
    const expiresAt = parseTemporaryExpiry(req.body?.expiresAt);
    if (isUserTemporaryStatus(nextStatus) && !expiresAt) {
      throw new HttpError(400, "expiresAt is required for temporary status updates.");
    }
    if (nextStatus === UserModerationStatus.ACTIVE && expiresAt) {
      throw new HttpError(400, "expiresAt is not allowed for ACTIVE status.");
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, "expiresAt must be in the future.");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, "User not found.");
    const previousStatus = resolveUserModerationStatus(user);

    const updated = await prisma.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: user.id },
        data: {
          moderationStatus: nextStatus,
          moderationReason: reason,
          moderationExpiresAt: isUserTemporaryStatus(nextStatus) ? expiresAt : null,
          moderatedAt: new Date(),
          moderatedBy: req.authUser?.adminLoginId ?? req.authUser?.phoneNumber ?? req.authUser?.id ?? "ADMIN",
          isBlocked: toUserBlocked(nextStatus),
        },
      });

      await tx.moderationAction.create({
        data: {
          targetType: ModerationTargetType.USER,
          targetId: user.id,
          actionType: `USER_${nextStatus}`,
          previousStatus,
          newStatus: nextStatus,
          reason,
          expiresAt: isUserTemporaryStatus(nextStatus) ? expiresAt : null,
          adminId: req.authUser?.id ?? "ADMIN",
          adminEmail:
            typeof req.body?.adminEmail === "string" && req.body.adminEmail.trim().length > 0
              ? req.body.adminEmail.trim()
              : null,
        },
      });

      return nextUser;
    });

    res.json({
      user: {
        ...updated,
        moderationStatus: resolveUserModerationStatus(updated),
      },
    });
  }),
);

adminRouter.patch(
  "/partners/:id/status",
  asyncHandler(async (req, res) => {
    const companionId = String(req.params.id ?? "").trim();
    if (!companionId) throw new HttpError(400, "Partner ID is required.");

    const nextStatus = parsePartnerModerationStatus(req.body?.status);
    if (!nextStatus) {
      throw new HttpError(400, "status must be ACTIVE, RESTRICTED, TEMP_BANNED, BANNED, or HIDDEN.");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw new HttpError(400, "reason is required.");
    const expiresAt = parseTemporaryExpiry(req.body?.expiresAt);
    if (isPartnerTemporaryStatus(nextStatus) && !expiresAt) {
      throw new HttpError(400, "expiresAt is required for temporary status updates.");
    }
    if ((nextStatus === PartnerModerationStatus.ACTIVE || nextStatus === PartnerModerationStatus.HIDDEN) && expiresAt) {
      throw new HttpError(400, "expiresAt is not allowed for this status.");
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, "expiresAt must be in the future.");
    }

    const companion = await prisma.companion.findUnique({ where: { id: companionId } });
    if (!companion) throw new HttpError(404, "Partner not found.");
    const previousStatus = resolvePartnerModerationStatus(companion);

    const updated = await prisma.$transaction(async (tx) => {
      const nextCompanion = await tx.companion.update({
        where: { id: companion.id },
        data: {
          moderationStatus: nextStatus,
          moderationReason: reason,
          moderationExpiresAt: isPartnerTemporaryStatus(nextStatus) ? expiresAt : null,
          moderatedAt: new Date(),
          moderatedBy: req.authUser?.adminLoginId ?? req.authUser?.phoneNumber ?? req.authUser?.id ?? "ADMIN",
          isOnline: toPartnerOffline(nextStatus) ? false : companion.isOnline,
        },
      });

      await tx.moderationAction.create({
        data: {
          targetType: ModerationTargetType.PARTNER,
          targetId: companion.id,
          actionType: `PARTNER_${nextStatus}`,
          previousStatus,
          newStatus: nextStatus,
          reason,
          expiresAt: isPartnerTemporaryStatus(nextStatus) ? expiresAt : null,
          adminId: req.authUser?.id ?? "ADMIN",
          adminEmail:
            typeof req.body?.adminEmail === "string" && req.body.adminEmail.trim().length > 0
              ? req.body.adminEmail.trim()
              : null,
        },
      });

      return nextCompanion;
    });

    res.json({
      companion: {
        ...updated,
        moderationStatus: resolvePartnerModerationStatus(updated),
      },
    });
  }),
);

adminRouter.get(
  "/moderation/actions",
  asyncHandler(async (req, res) => {
    const target = typeof req.query.target === "string" ? req.query.target.trim().toUpperCase() : "";
    const where: Prisma.ModerationActionWhereInput = {};
    if (
      target === ModerationTargetType.USER ||
      target === ModerationTargetType.PARTNER ||
      target === ModerationTargetType.HOME_VISIT
    ) {
      where.targetType = target as ModerationTargetType;
    }
    const actions = await prisma.moderationAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json({ actions });
  }),
);

adminRouter.patch(
  "/companions/:id",
  asyncHandler(async (req, res) => {
    const companion = await prisma.companion.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.displayName === "string" ? { displayName: req.body.displayName } : {}),
        ...(typeof req.body.city === "string" ? { city: req.body.city } : {}),
        ...(typeof req.body.category === "string" ? { category: req.body.category } : {}),
        ...(typeof req.body.status === "string"
          ? { status: req.body.status as CompanionStatus }
          : {}),
        ...(typeof req.body.verificationStatus === "string"
          ? { verificationStatus: req.body.verificationStatus as VerificationStatus }
          : {}),
      },
    });
    res.json({ companion });
  }),
);

adminRouter.get(
  "/applications",
  asyncHandler(async (_req, res) => {
    const applications = await prisma.partnerApplication.findMany({
      select: {
        id: true,
        companionId: true,
        fullName: true,
        age: true,
        gender: true,
        bornCity: true,
        nationality: true,
        languagesKnown: true,
        communicationStyle: true,
        hobbies: true,
        profileTagline: true,
        aboutYourself: true,
        servicesOffered: true,
        chatPrice: true,
        audioPrice: true,
        videoPrice: true,
        homeVisitRequested: true,
        homeVisitPrice: true,
        categories: true,
        safetyChecklist: true,
        selfieUploaded: true,
        aadhaarFrontUploaded: true,
        aadhaarBackUploaded: true,
        panUploaded: true,
        status: true,
        adminNote: true,
        createdAt: true,
        updatedAt: true,
        applicantUser: {
          select: {
            id: true,
            phoneNumber: true,
            name: true,
            role: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        companion: {
          select: {
            id: true,
            userId: true,
            displayName: true,
            city: true,
            category: true,
            languages: true,
            servicesOffered: true,
            chatPrice: true,
            audioPrice: true,
            videoPrice: true,
            status: true,
            verificationStatus: true,
            isOnline: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ applications: applications.map(withFixedApplicationPrices) });
  }),
);

adminRouter.get(
  "/applications/:id",
  asyncHandler(async (req, res) => {
    const application = await prisma.partnerApplication.findUnique({
      where: { id: String(req.params.id) },
      select: {
        id: true,
        companionId: true,
        fullName: true,
        age: true,
        gender: true,
        religion: true,
        bornCity: true,
        nationality: true,
        school: true,
        college: true,
        qualification: true,
        languagesKnown: true,
        communicationStyle: true,
        hobbies: true,
        profileTagline: true,
        aboutYourself: true,
        servicesOffered: true,
        chatPrice: true,
        audioPrice: true,
        videoPrice: true,
        homeVisitRequested: true,
        homeVisitPrice: true,
        categories: true,
        safetyChecklist: true,
        selfieUploaded: true,
        aadhaarFrontUploaded: true,
        aadhaarBackUploaded: true,
        panUploaded: true,
        status: true,
        adminNote: true,
        createdAt: true,
        updatedAt: true,
        applicantUser: {
          select: {
            id: true,
            phoneNumber: true,
            name: true,
            role: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        companion: {
          select: {
            id: true,
            userId: true,
            displayName: true,
            city: true,
            category: true,
            languages: true,
            servicesOffered: true,
            chatPrice: true,
            audioPrice: true,
            videoPrice: true,
            status: true,
            verificationStatus: true,
            isOnline: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!application) throw new HttpError(404, "Application not found.");
    res.json({ application: withFixedApplicationPrices(application) });
  }),
);

adminRouter.get(
  "/kyc-documents/:applicationId/:documentType/preview",
  asyncHandler(async (req, res) => {
    const documentType = parseKycDocumentType(req.params.documentType);
    if (!documentType) throw new HttpError(400, "Unsupported KYC document type.");
    if (!firebaseAdminStorage) {
      throw new HttpError(503, "KYC preview storage is not configured.");
    }

    const fields = kycDocumentFields[documentType];
    const application = await prisma.partnerApplication.findUnique({
      where: { id: String(req.params.applicationId) },
      select: {
        selfieUploaded: true,
        selfieFileName: true,
        selfieStoragePath: true,
        selfieUrl: true,
        aadhaarFrontUploaded: true,
        aadhaarFrontFileName: true,
        aadhaarFrontStoragePath: true,
        aadhaarFrontUrl: true,
        aadhaarBackUploaded: true,
        aadhaarBackFileName: true,
        aadhaarBackStoragePath: true,
        aadhaarBackUrl: true,
        panUploaded: true,
        panFileName: true,
        panStoragePath: true,
        panUrl: true,
      },
    });

    if (!application) throw new HttpError(404, "Application not found.");
    if (!application[fields.uploadedField]) throw new HttpError(404, "KYC document not uploaded.");

    const storageObject = resolveKycStorageObject(
      application[fields.storagePathField],
      application[fields.urlField],
    );
    if (!storageObject?.objectPath) {
      throw new HttpError(404, "KYC document storage path not found.");
    }
    if (!storageObject.objectPath.startsWith(KYC_STORAGE_PREFIX)) {
      throw new HttpError(403, "KYC document path is not allowed.");
    }

    const bucket = storageObject.bucketName
      ? firebaseAdminStorage.bucket(storageObject.bucketName)
      : firebaseAdminStorage.bucket();
    const file = bucket.file(storageObject.objectPath);
    const [exists] = await file.exists();
    if (!exists) throw new HttpError(404, "KYC document file not found.");

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || "application/octet-stream";

    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");

    await new Promise<void>((resolve, reject) => {
      const stream = file.createReadStream();
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
  }),
);

adminRouter.patch(
  "/applications/:id",
  asyncHandler(async (req, res) => {
    const rawStatus = typeof req.body.status === "string" ? req.body.status.trim().toUpperCase() : "";
    const status =
      rawStatus === PartnerApplicationStatus.APPROVED ||
      rawStatus === PartnerApplicationStatus.REJECTED ||
      rawStatus === PartnerApplicationStatus.NEEDS_INFO
        ? (rawStatus as PartnerApplicationStatus)
        : undefined;
    if (!status) {
      throw new HttpError(400, "status must be APPROVED, REJECTED, or NEEDS_INFO.");
    }
    const application = await prisma.partnerApplication.findUnique({ where: { id: String(req.params.id) } });
    if (!application) throw new HttpError(404, "Application not found.");

    let updated: Awaited<ReturnType<typeof prisma.partnerApplication.findUniqueOrThrow>>;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const next = await tx.partnerApplication.update({
          where: { id: application.id },
          data: {
            status,
            ...(typeof req.body.adminNote === "string" ? { adminNote: req.body.adminNote } : {}),
          },
        });

        if (status === PartnerApplicationStatus.APPROVED) {
          await tx.user.update({
            where: { id: application.applicantUserId },
            data: { role: Role.PARTNER },
          });

          const companion =
            application.companionId
              ? await tx.companion.findUnique({ where: { id: application.companionId } })
              : await tx.companion.findUnique({ where: { userId: application.applicantUserId } });

          if (companion) {
            await tx.companion.update({
              where: { id: companion.id },
              data: {
                status: CompanionStatus.ACTIVE,
                verificationStatus: VerificationStatus.VERIFIED,
                chatPrice: CHAT_RATE_PER_MIN,
                audioPrice: AUDIO_RATE_PER_MIN,
                videoPrice: VIDEO_RATE_PER_MIN,
                homeVisitVerificationStatus: application.homeVisitRequested
                  ? HomeVisitVerificationStatus.PENDING
                  : companion.homeVisitVerificationStatus,
              },
            });
            if (!application.companionId || application.companionId !== companion.id) {
              await tx.partnerApplication.update({
                where: { id: application.id },
                data: { companionId: companion.id },
              });
            }
          } else {
            const createdCompanion = await tx.companion.create({
              data: {
                userId: application.applicantUserId,
                displayName: application.fullName,
                tagline: application.profileTagline,
                city: application.bornCity,
                category: application.categories[0] ?? null,
                languages: application.languagesKnown,
                servicesOffered: application.servicesOffered,
                chatPrice: CHAT_RATE_PER_MIN,
                audioPrice: AUDIO_RATE_PER_MIN,
                videoPrice: VIDEO_RATE_PER_MIN,
                status: CompanionStatus.ACTIVE,
                verificationStatus: VerificationStatus.VERIFIED,
                homeVisitVerificationStatus: application.homeVisitRequested
                  ? HomeVisitVerificationStatus.PENDING
                  : HomeVisitVerificationStatus.NOT_SUBMITTED,
              },
            });
            await tx.partnerApplication.update({
              where: { id: application.id },
              data: { companionId: createdCompanion.id },
            });
          }
        } else {
          if (application.companionId) {
            await tx.companion.update({
              where: { id: application.companionId },
              data: {
                status: CompanionStatus.UNDER_REVIEW,
                verificationStatus: VerificationStatus.PENDING,
              },
            });
          }
        }

        return tx.partnerApplication.findUniqueOrThrow({
          where: { id: next.id },
          include: { companion: true },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") {
          throw new HttpError(409, "This applicant already has a partner profile. Please refresh and try approval again.");
        }
        if (error.code === "P2025") {
          throw new HttpError(404, "Required applicant or partner record was not found. Please refresh and try again.");
        }
      }
      console.error("[admin] application status update failed", {
        applicationId: application.id,
        status,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new HttpError(500, "Unable to update application status. Please retry or contact support.");
    }

    res.json({ application: updated });
  }),
);

adminRouter.get(
  "/bookings",
  asyncHandler(async (_req, res) => {
    const bookings = await prisma.booking.findMany({
      include: { user: true, companion: true, session: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  }),
);

adminRouter.patch(
  "/bookings/:id",
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
        ...(typeof req.body.companionId === "string" ? { companionId: req.body.companionId } : {}),
      },
    });
    res.json({ booking });
  }),
);

adminRouter.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    const sessions = await prisma.session.findMany({
      include: { user: true, companion: true, booking: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ sessions });
  }),
);

adminRouter.patch(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const session = await prisma.session.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status as SessionStatus } : {}),
        ...(typeof req.body.safetyFlag === "boolean" ? { safetyFlag: req.body.safetyFlag } : {}),
        ...(typeof req.body.safetyNote === "string" ? { safetyNote: req.body.safetyNote } : {}),
      },
    });
    res.json({ session });
  }),
);

adminRouter.get(
  "/wallet/transactions",
  asyncHandler(async (_req, res) => {
    const transactions = await prisma.walletTransaction.findMany({
      include: { walletAccount: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ transactions });
  }),
);

adminRouter.get(
  "/wallet/summary",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const type = parseTransactionType(req.query.type);
    const status = parseTransactionStatus(req.query.status);

    const where: Prisma.WalletTransactionWhereInput = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { transactionCode: { contains: search, mode: "insensitive" } },
        { referenceId: { contains: search, mode: "insensitive" } },
        { walletAccount: { user: { phoneNumber: { contains: search, mode: "insensitive" } } } },
        { walletAccount: { user: { name: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [transactions, rechargedAgg, spentAgg, refundsAgg, totalTransactions] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        include: {
          walletAccount: {
            include: {
              user: {
                select: {
                  name: true,
                  phoneNumber: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.RECHARGE, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
        _count: { id: true },
      }),
      prisma.walletTransaction.aggregate({
        where: {
          type: { in: [TransactionType.BOOKING, TransactionType.GIFT] },
          status: TransactionStatus.SUCCESS,
        },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.REFUND, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.count(),
    ]);

    const totalRecharged = rechargedAgg._sum.amount ?? 0;
    const totalSpent = Math.abs(spentAgg._sum.amount ?? 0);
    const totalRefunds = refundsAgg._sum.amount ?? 0;
    const rechargeCount = rechargedAgg._count.id ?? 0;
    const averageRecharge = rechargeCount > 0 ? Math.round(totalRecharged / rechargeCount) : 0;

    res.json({
      totalRecharged,
      totalSpent,
      totalRefunds,
      totalTransactions,
      averageRecharge,
      transactions: transactions.map((tx) => ({
        id: tx.id,
        transactionId: tx.transactionCode,
        userPhone: tx.walletAccount.user.phoneNumber,
        userName: tx.walletAccount.user.name,
        type: tx.type,
        amount: tx.amount,
        status: tx.status,
        gateway: tx.gateway,
        createdAt: tx.createdAt,
        paidAmount: parsePaidAmountFromReason(tx.reason, tx.amount),
        walletCredit: tx.type === TransactionType.RECHARGE && tx.status === TransactionStatus.SUCCESS
          ? Math.max(tx.amount, 0)
          : 0,
      })),
    });
  }),
);

adminRouter.get(
  "/payouts",
  asyncHandler(async (_req, res) => {
    const [payouts, partnerEarnings] = await Promise.all([
      prisma.payout.findMany({
        include: { companion: { include: { user: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.partnerEarning.findMany({
        include: {
          companion: {
            include: {
              user: {
                select: {
                  phoneNumber: true,
                  name: true,
                },
              },
            },
          },
          session: {
            select: {
              serviceType: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const summary = partnerEarnings.reduce(
      (acc, row) => {
        const gross = decimalToNumber(row.grossAmount);
        const partnerAmount = decimalToNumber(row.partnerAmount);
        const companyAmount = decimalToNumber(row.companyAmount);
        const isSession = row.sourceType === PartnerEarningSourceType.SESSION;
        const isGift = row.sourceType === PartnerEarningSourceType.GIFT;
        const isPending = row.status === PartnerEarningStatus.PENDING;
        const isAvailable = row.status === PartnerEarningStatus.AVAILABLE;
        const isPaid = row.status === PartnerEarningStatus.PAID;

        acc.grossTotal += gross;
        acc.partnerTotal += partnerAmount;
        acc.companyTotal += companyAmount;
        if (isSession) {
          acc.sessionGross += gross;
          acc.sessionPartner += partnerAmount;
          acc.sessionCompany += companyAmount;
        }
        if (isGift) {
          acc.giftGross += gross;
          acc.giftPartner += partnerAmount;
          acc.giftCompany += companyAmount;
        }
        if (isPending) acc.pendingPartner += partnerAmount;
        if (isAvailable) acc.availablePartner += partnerAmount;
        if (isPaid) acc.paidPartner += partnerAmount;
        return acc;
      },
      {
        grossTotal: 0,
        partnerTotal: 0,
        companyTotal: 0,
        sessionGross: 0,
        sessionPartner: 0,
        sessionCompany: 0,
        giftGross: 0,
        giftPartner: 0,
        giftCompany: 0,
        pendingPartner: 0,
        availablePartner: 0,
        paidPartner: 0,
      },
    );

    res.json({
      payouts,
      earnings: partnerEarnings.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        sourceType: row.sourceType,
        status: row.status,
        companionId: row.companionId,
        companionName: row.companion.displayName,
        companionPhone: row.companion.user.phoneNumber,
        sessionType: row.session?.serviceType ?? null,
        grossAmount: decimalToNumber(row.grossAmount),
        partnerAmount: decimalToNumber(row.partnerAmount),
        companyAmount: decimalToNumber(row.companyAmount),
        partnerPercent: decimalToNumber(row.partnerPercent),
        companyPercent: decimalToNumber(row.companyPercent),
      })),
      summary,
    });
  }),
);

adminRouter.patch(
  "/payouts/:id",
  asyncHandler(async (req, res) => {
    const payout = await prisma.payout.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status as PayoutStatus } : {}),
        ...(typeof req.body.rejectionReason === "string" ? { rejectionReason: req.body.rejectionReason } : {}),
        ...(req.body.status === PayoutStatus.PAID ? { processedAt: new Date() } : {}),
      },
    });
    res.json({ payout });
  }),
);

adminRouter.get(
  "/verification",
  asyncHandler(async (_req, res) => {
    const verifications = await prisma.verificationRecord.findMany({
      include: { companion: { include: { user: true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ verifications });
  }),
);

adminRouter.patch(
  "/verification/:id",
  asyncHandler(async (req, res) => {
    const verification = await prisma.verificationRecord.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.idVerification === "string"
          ? { idVerification: req.body.idVerification as VerificationStatus }
          : {}),
        ...(typeof req.body.policeVerification === "string"
          ? { policeVerification: req.body.policeVerification as VerificationStatus }
          : {}),
        ...(typeof req.body.psychometricTest === "string"
          ? { psychometricTest: req.body.psychometricTest as VerificationStatus }
          : {}),
        ...(typeof req.body.interviewStatus === "string"
          ? { interviewStatus: req.body.interviewStatus as VerificationStatus }
          : {}),
        ...(typeof req.body.trainingStatus === "string"
          ? { trainingStatus: req.body.trainingStatus as VerificationStatus }
          : {}),
        ...(typeof req.body.overallStatus === "string"
          ? { overallStatus: req.body.overallStatus as VerificationStatus }
          : {}),
      },
    });
    res.json({ verification });
  }),
);

adminRouter.get(
  "/reviews",
  asyncHandler(async (_req, res) => {
    const reviews = await prisma.review.findMany({
      include: { user: true, companion: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ reviews });
  }),
);

adminRouter.patch(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const review = await prisma.review.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.isApproved === "boolean" ? { isApproved: req.body.isApproved } : {}),
        ...(typeof req.body.isHidden === "boolean" ? { isHidden: req.body.isHidden } : {}),
        ...(typeof req.body.isFlagged === "boolean" ? { isFlagged: req.body.isFlagged } : {}),
      },
    });
    res.json({ review });
  }),
);

adminRouter.delete(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    await prisma.review.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/support",
  asyncHandler(async (_req, res) => {
    const tickets = await prisma.supportTicket.findMany({
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ tickets });
  }),
);

adminRouter.patch(
  "/support/:id",
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!ticket) throw new HttpError(404, "Support ticket not found.");
    const note = typeof req.body.note === "string" ? req.body.note : null;
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
        ...(typeof req.body.assignedTo === "string" ? { assignedTo: req.body.assignedTo } : {}),
        ...(note ? { internalNotes: [...ticket.internalNotes, note] } : {}),
      },
    });
    res.json({ ticket: updated });
  }),
);

adminRouter.get(
  "/settings/:key",
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const setting = await prisma.platformSetting.findUnique({ where: { key } });
    res.json({ setting });
  }),
);

adminRouter.get(
  "/home-visit-verifications",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
          },
        },
        partnerApplications: {
          where: {
            status: {
              in: [PartnerApplicationStatus.APPROVED, PartnerApplicationStatus.UNDER_REVIEW, PartnerApplicationStatus.NEEDS_INFO],
            },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      verifications: companions.map((companion) => {
        const latestApplication = companion.partnerApplications[0] ?? null;
        const status = companion.homeVisitVerificationStatus;
        const computedStatus =
          status === HomeVisitVerificationStatus.NOT_SUBMITTED && latestApplication?.homeVisitRequested
            ? HomeVisitVerificationStatus.PENDING
            : status;

        return {
          id: companion.id,
          companionId: companion.id,
          companionName: companion.displayName,
          companionStatus: companion.status,
          companionVerificationStatus: companion.verificationStatus,
          moderationStatus: resolvePartnerModerationStatus(companion),
          homeVisitStatus: computedStatus,
          adminNote: companion.homeVisitVerificationNote,
          reviewedAt: companion.homeVisitVerifiedAt,
          reviewedBy: companion.homeVisitVerifiedBy,
          createdAt: companion.createdAt,
          updatedAt: companion.updatedAt,
          user: companion.user,
          request: latestApplication
            ? {
                applicationId: latestApplication.id,
                homeVisitRequested: latestApplication.homeVisitRequested,
                homeVisitPrice: latestApplication.homeVisitRequested ? HOME_VISIT_RATE_PER_HOUR : null,
                city: latestApplication.bornCity,
                languages: latestApplication.languagesKnown,
                categories: latestApplication.categories,
                safetyChecklist: latestApplication.safetyChecklist,
                selfieUrl: latestApplication.selfieUrl,
                aadhaarFrontUploaded: latestApplication.aadhaarFrontUploaded,
                aadhaarBackUploaded: latestApplication.aadhaarBackUploaded,
                panUploaded: latestApplication.panUploaded,
              }
            : null,
        };
      }),
    });
  }),
);

adminRouter.patch(
  "/home-visit-verifications/:id/status",
  asyncHandler(async (req, res) => {
    const companionId = String(req.params.id ?? "").trim();
    if (!companionId) throw new HttpError(400, "Partner ID is required.");

    const nextStatus = parseHomeVisitVerificationStatus(req.body?.status);
    if (!nextStatus) {
      throw new HttpError(400, "status must be NOT_SUBMITTED, PENDING, APPROVED, REJECTED, NEEDS_INFO, or SUSPENDED.");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw new HttpError(400, "reason is required.");

    const companion = await prisma.companion.findUnique({ where: { id: companionId } });
    if (!companion) throw new HttpError(404, "Partner not found.");

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.companion.update({
        where: { id: companion.id },
        data: {
          homeVisitVerificationStatus: nextStatus,
          homeVisitVerificationNote: reason,
          homeVisitVerifiedAt: new Date(),
          homeVisitVerifiedBy: req.authUser?.adminLoginId ?? req.authUser?.phoneNumber ?? req.authUser?.id ?? "ADMIN",
        },
      });

      await tx.moderationAction.create({
        data: {
          targetType: ModerationTargetType.HOME_VISIT,
          targetId: companion.id,
          actionType: `HOME_VISIT_${nextStatus}`,
          previousStatus: companion.homeVisitVerificationStatus,
          newStatus: nextStatus,
          reason,
          expiresAt: null,
          adminId: req.authUser?.id ?? "ADMIN",
          adminEmail:
            typeof req.body?.adminEmail === "string" && req.body.adminEmail.trim().length > 0
              ? req.body.adminEmail.trim()
              : null,
        },
      });

      return next;
    });

    res.json({ verification: updated });
  }),
);

adminRouter.put(
  "/settings/:key",
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const setting = await prisma.platformSetting.upsert({
      where: { key },
      update: { value: req.body ?? {} },
      create: { key, value: req.body ?? {} },
    });
    res.json({ setting });
  }),
);

adminRouter.get(
  "/media",
  asyncHandler(async (_req, res) => {
    const media = await prisma.mediaItem.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ media });
  }),
);

adminRouter.post(
  "/media",
  asyncHandler(async (req, res) => {
    const media = await prisma.mediaItem.create({
      data: {
        title: req.body.title,
        publisher: req.body.publisher,
        type: req.body.type,
        imageUrl: req.body.imageUrl,
        linkUrl: req.body.linkUrl,
        status: req.body.status ?? "DRAFT",
      },
    });
    res.status(201).json({ media });
  }),
);

adminRouter.patch(
  "/media/:id",
  asyncHandler(async (req, res) => {
    const media = await prisma.mediaItem.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.title === "string" ? { title: req.body.title } : {}),
        ...(typeof req.body.publisher === "string" ? { publisher: req.body.publisher } : {}),
        ...(typeof req.body.type === "string" ? { type: req.body.type } : {}),
        ...(typeof req.body.imageUrl === "string" ? { imageUrl: req.body.imageUrl } : {}),
        ...(typeof req.body.linkUrl === "string" ? { linkUrl: req.body.linkUrl } : {}),
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
      },
    });
    res.json({ media });
  }),
);

adminRouter.delete(
  "/media/:id",
  asyncHandler(async (req, res) => {
    await prisma.mediaItem.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/client-diaries",
  asyncHandler(async (_req, res) => {
    const diaries = await prisma.clientDiary.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ diaries });
  }),
);

adminRouter.post(
  "/client-diaries",
  asyncHandler(async (req, res) => {
    const diary = await prisma.clientDiary.create({
      data: {
        title: req.body.title,
        subtitle: req.body.subtitle,
        imageUrl: req.body.imageUrl,
        videoUrl: req.body.videoUrl,
        status: req.body.status ?? "DRAFT",
      },
    });
    res.status(201).json({ diary });
  }),
);

adminRouter.patch(
  "/client-diaries/:id",
  asyncHandler(async (req, res) => {
    const diary = await prisma.clientDiary.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.title === "string" ? { title: req.body.title } : {}),
        ...(typeof req.body.subtitle === "string" ? { subtitle: req.body.subtitle } : {}),
        ...(typeof req.body.imageUrl === "string" ? { imageUrl: req.body.imageUrl } : {}),
        ...(typeof req.body.videoUrl === "string" ? { videoUrl: req.body.videoUrl } : {}),
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
      },
    });
    res.json({ diary });
  }),
);

adminRouter.delete(
  "/client-diaries/:id",
  asyncHandler(async (req, res) => {
    await prisma.clientDiary.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/reports/summary",
  asyncHandler(async (_req, res) => {
    const [sessionsByType, companionStats, userStats, payoutStats] = await Promise.all([
      prisma.session.groupBy({
        by: ["serviceType"],
        _count: { id: true },
      }),
      prisma.companion.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.user.groupBy({
        by: ["isBlocked"],
        _count: { id: true },
      }),
      prisma.payout.aggregate({
        _sum: { amount: true },
      }),
    ]);

    res.json({
      sessionsByType,
      companionStats,
      userStats,
      payoutAmountTotal: payoutStats._sum.amount ?? 0,
    });
  }),
);
