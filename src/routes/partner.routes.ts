import { Router } from "express";
import {
  CompanionAvailability,
  CompanionStatus,
  PartnerApplicationStatus,
  PartnerEarningSourceType,
  PartnerEarningStatus,
  PayoutStatus,
  Prisma,
  Role,
  ServiceType,
  SessionStatus,
  UserRewardStatus,
  VerificationStatus,
} from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z, ZodError } from "zod";
import { requireAuth } from "../middlewares/auth";
import { requireRole } from "../middlewares/roles";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { firebaseAdminAuth, isFirebaseAdminConfigured } from "../config/firebaseAdmin";
import { env } from "../config/env";
import { assertPartnerDashboardAccess } from "../utils/moderation";
import {
  isCompanionListedOnline,
  resolveCompanionAvailability,
} from "../utils/partnerAvailability";
import {
  AUDIO_RATE_PER_MIN,
  CHAT_RATE_PER_MIN,
  HOME_VISIT_RATE_PER_HOUR,
  VIDEO_RATE_PER_MIN,
  getFixedSessionRate,
} from "../config/platformPricing";

const onboardingSchema = z.object({
  fullName: z.string().min(2),
  age: z.number().int().min(18).max(70),
  gender: z.string().min(1),
  religion: z.string().optional(),
  bornCity: z.string().optional(),
  nationality: z.string().optional(),
  school: z.string().optional(),
  college: z.string().optional(),
  qualification: z.string().optional(),
  languagesKnown: z.array(z.string()).min(1),
  communicationStyle: z.array(z.string()).min(1),
  hobbies: z.array(z.string()).min(1),
  profileTagline: z.string().min(6),
  aboutYourself: z.string().min(80),
  servicesOffered: z.array(z.string()).min(1),
  chatPrice: z.coerce.number().int().nonnegative().optional(),
  audioPrice: z.coerce.number().int().nonnegative().optional(),
  videoPrice: z.coerce.number().int().nonnegative().optional(),
  homeVisitRequested: z.boolean().optional(),
  homeVisitPrice: z.coerce.number().int().nonnegative().optional(),
  categories: z.array(z.string()).min(1),
  safetyChecklist: z.array(z.string()).min(4),
  selfieUploaded: z.boolean().optional(),
  selfieFileName: z.string().optional(),
  selfieStoragePath: z.string().optional(),
  selfieUrl: z.string().optional(),
  aadhaarFrontUploaded: z.boolean().optional(),
  aadhaarFrontFileName: z.string().optional(),
  aadhaarFrontStoragePath: z.string().optional(),
  aadhaarFrontUrl: z.string().optional(),
  aadhaarBackUploaded: z.boolean().optional(),
  aadhaarBackFileName: z.string().optional(),
  aadhaarBackStoragePath: z.string().optional(),
  aadhaarBackUrl: z.string().optional(),
  panUploaded: z.boolean().optional(),
  panFileName: z.string().optional(),
  panStoragePath: z.string().optional(),
  panUrl: z.string().optional(),
  liveVerificationName: z.string().optional(),
  liveVerificationAge: z.coerce.number().int().min(18).max(70).optional(),
  liveVerificationHobbies: z.string().optional(),
  liveVideoUploaded: z.boolean().optional(),
  liveVideoFileName: z.string().optional(),
  liveVideoStoragePath: z.string().optional(),
});

const partnerAvailabilitySchema = z.object({
  isOnline: z.boolean(),
});

const partnerProfileImageSchema = z.object({
  imageUrl: z.string().url(),
  storagePath: z.string().min(1).max(500),
});

const partnerGalleryImageSchema = z.object({
  imageUrl: z.string().url(),
  storagePath: z.string().min(1).max(500),
});

const partnerDeleteGalleryImageSchema = z.object({
  imageUrl: z.string().url().optional(),
  storagePath: z.string().min(1).max(500).optional(),
});

const payoutRequestSchema = z.object({
  amount: z.coerce.number().int().positive(),
  note: z.string().trim().max(500).optional(),
});

const MAX_GALLERY_IMAGES = 6;
const STALE_LIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.LIVE, SessionStatus.ACCEPTED];
const PENDING_PAYOUT_STATUSES: PayoutStatus[] = [PayoutStatus.REQUESTED, PayoutStatus.APPROVED];
const KYC_STORAGE_PREFIX = "YoPartner/partner-kyc/";
const partnerApplicationFieldLabels: Record<string, string> = {
  fullName: "Full Name",
  age: "Age",
  gender: "Gender",
  religion: "Religion",
  bornCity: "Born City",
  nationality: "Nationality",
  school: "School",
  college: "College",
  qualification: "Qualification",
  languagesKnown: "Languages",
  communicationStyle: "Communication Style",
  hobbies: "Hobbies",
  profileTagline: "Profile Tagline",
  aboutYourself: "About Yourself",
  servicesOffered: "Services",
  categories: "Categories",
  safetyChecklist: "Safety checklist",
  selfieUploaded: "Selfie",
  selfieStoragePath: "Selfie upload path",
  aadhaarFrontUploaded: "Aadhaar Front",
  aadhaarFrontStoragePath: "Aadhaar Front upload path",
  aadhaarBackUploaded: "Aadhaar Back",
  aadhaarBackStoragePath: "Aadhaar Back upload path",
  panUploaded: "PAN",
  panStoragePath: "PAN upload path",
  liveVerificationName: "Live verification name",
  liveVerificationAge: "Live verification age",
  liveVerificationHobbies: "Live verification hobbies",
  liveVideoUploaded: "Live video",
  liveVideoStoragePath: "Live video upload path",
};

function getPartnerApplicationValidationDetails(error: ZodError) {
  const issues = error.issues.map((issue) => {
    const field = issue.path.join(".") || "payload";
    const label = partnerApplicationFieldLabels[String(issue.path[0] ?? "")] ?? field;
    return {
      field,
      label,
      message: issue.message,
    };
  });
  const firstIssue = issues[0];
  return {
    issues,
    message: firstIssue
      ? `${firstIssue.label}: ${firstIssue.message}`
      : "Invalid partner application payload.",
  };
}

async function hasActiveCompanionSession(companionId: string) {
  const staleThreshold = new Date(Date.now() - STALE_LIVE_SESSION_MS);
  await prisma.session.updateMany({
    where: {
      companionId,
      status: { in: ACTIVE_SESSION_STATUSES },
      endedAt: null,
      updatedAt: { lt: staleThreshold },
    },
    data: {
      status: SessionStatus.EXPIRED,
      endedAt: new Date(),
    },
  });

  const active = await prisma.session.findFirst({
    where: {
      companionId,
      status: { in: ACTIVE_SESSION_STATUSES },
      endedAt: null,
      updatedAt: { gte: staleThreshold },
    },
    select: { id: true },
  });

  return Boolean(active);
}

function maskPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return value;
  return `+91******${digits.slice(-4)}`;
}

function buildChannelName(sessionId: string) {
  return `session-${sessionId}`;
}

function decimalToNumber(value: Prisma.Decimal | number | null | undefined) {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundToTwo(value: number) {
  return Math.round(value * 100) / 100;
}

function payoutAdminNote(value: string | null | undefined) {
  return value?.trim() || null;
}

function toPartnerPayoutPayload(payout: {
  id: string;
  payoutCode: string;
  amount: number;
  status: PayoutStatus;
  requestedAt: Date;
  processedAt: Date | null;
  rejectionReason: string | null;
}) {
  return {
    id: payout.id,
    payoutCode: payout.payoutCode,
    amount: payout.amount,
    status: payout.status,
    requestedAt: payout.requestedAt.toISOString(),
    processedAt: payout.processedAt ? payout.processedAt.toISOString() : null,
    adminNote: payoutAdminNote(payout.rejectionReason),
  };
}

async function getPartnerPayoutBalances(
  tx: Pick<Prisma.TransactionClient, "partnerEarning" | "payout">,
  companionId: string,
) {
  const [availableEarnings, pendingPayouts, paidPayouts] = await Promise.all([
    tx.partnerEarning.aggregate({
      where: {
        companionId,
        status: PartnerEarningStatus.AVAILABLE,
      },
      _sum: { partnerAmount: true },
    }),
    tx.payout.aggregate({
      where: {
        companionId,
        status: { in: PENDING_PAYOUT_STATUSES },
      },
      _sum: { amount: true },
    }),
    tx.payout.aggregate({
      where: {
        companionId,
        status: PayoutStatus.PAID,
      },
      _sum: { amount: true },
    }),
  ]);

  const earnedAvailableAmount = roundToTwo(decimalToNumber(availableEarnings._sum.partnerAmount));
  const pendingPayoutAmount = pendingPayouts._sum.amount ?? 0;
  const totalPaidAmount = paidPayouts._sum.amount ?? 0;
  const availableToWithdraw = roundToTwo(
    Math.max(0, earnedAvailableAmount - pendingPayoutAmount - totalPaidAmount),
  );

  return {
    availableEarnings: availableToWithdraw,
    availableToWithdraw,
    pendingPayoutAmount,
    totalPaidAmount,
    earnedAvailableAmount,
    bankDetails: {
      required: false,
      status: "NOT_CONFIGURED",
      note: "Bank details are not stored in the current payout model. Admin may verify payout details before processing.",
    },
  };
}

const toServiceType = (value: string): ServiceType | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat") return ServiceType.CHAT;
  if (normalized === "audio" || normalized === "audio call") return ServiceType.AUDIO;
  if (normalized === "video" || normalized === "video call") return ServiceType.VIDEO;
  return null;
};

function sanitizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getRequestOrigin(req: { headers: Record<string, unknown>; protocol?: string; get(name: string): string | undefined }) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = req.get("host");
  return host ? `${protocol}://${host}` : "";
}

function getCompanionProfileImageProxyUrl(
  req: { headers: Record<string, unknown>; protocol?: string; get(name: string): string | undefined },
  companionId: string,
) {
  const origin = getRequestOrigin(req);
  const path = `/api/companions/${encodeURIComponent(companionId)}/profile-image`;
  return origin ? `${origin}${path}` : path;
}

function sanitizeKycDocument(input: {
  uploaded?: boolean;
  fileName?: string;
  storagePath?: string;
  url?: string;
}) {
  const fileName = sanitizeOptionalString(input.fileName);
  const storagePath = sanitizeOptionalString(input.storagePath);
  const url = sanitizeOptionalString(input.url);
  const uploaded = Boolean(input.uploaded) && Boolean(fileName || storagePath || url);

  return {
    uploaded,
    fileName,
    storagePath,
    url,
  };
}

function isPartnerKycPathForUser(storagePath: string | null, firebaseUid: string | null | undefined) {
  const normalized = storagePath?.trim() ?? "";
  const uid = firebaseUid?.trim() ?? "";
  return Boolean(uid && normalized.startsWith(`${KYC_STORAGE_PREFIX}${uid}/`));
}

function assertRequiredKycDocument(
  document: ReturnType<typeof sanitizeKycDocument>,
  firebaseUid: string | null | undefined,
  label: string,
) {
  if (!document.uploaded) {
    throw new HttpError(400, `${label}: upload is missing.`);
  }
  if (!document.storagePath) {
    throw new HttpError(400, `${label}: upload path is missing.`);
  }
  if (!isPartnerKycPathForUser(document.storagePath, firebaseUid)) {
    throw new HttpError(400, `${label}: upload path does not match your login session. Please reselect and upload this document.`);
  }
}

export const partnerRouter = Router();

partnerRouter.post(
  "/applications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;

    try {
      const parsed = onboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        const validation = getPartnerApplicationValidationDetails(parsed.error);
        console.error("Partner application submit failed", {
          message: validation.message,
          code: "VALIDATION_ERROR",
          meta: validation.issues,
        });
        res.status(400).json({
          error: validation.message,
          message: validation.message,
          detail: "VALIDATION_ERROR",
          validationErrors: validation.issues,
        });
        return;
      }
      const payload = parsed.data;

      const servicesOffered = payload.servicesOffered
        .map(toServiceType)
        .filter((value): value is ServiceType => value !== null);
      if (servicesOffered.length === 0) {
        throw new HttpError(400, "At least one valid service is required.");
      }

      const selfie = sanitizeKycDocument({
        uploaded: payload.selfieUploaded,
        fileName: payload.selfieFileName,
        storagePath: payload.selfieStoragePath,
        url: payload.selfieUrl,
      });
      const aadhaarFront = sanitizeKycDocument({
        uploaded: payload.aadhaarFrontUploaded,
        fileName: payload.aadhaarFrontFileName,
        storagePath: payload.aadhaarFrontStoragePath,
        url: payload.aadhaarFrontUrl,
      });
      const aadhaarBack = sanitizeKycDocument({
        uploaded: payload.aadhaarBackUploaded,
        fileName: payload.aadhaarBackFileName,
        storagePath: payload.aadhaarBackStoragePath,
        url: payload.aadhaarBackUrl,
      });
      const pan = sanitizeKycDocument({
        uploaded: payload.panUploaded,
        fileName: payload.panFileName,
        storagePath: payload.panStoragePath,
        url: payload.panUrl,
      });
      const liveVideo = sanitizeKycDocument({
        uploaded: payload.liveVideoUploaded,
        fileName: payload.liveVideoFileName,
        storagePath: payload.liveVideoStoragePath,
      });

      assertRequiredKycDocument(selfie, authUser.firebaseUid, "Selfie");
      assertRequiredKycDocument(aadhaarFront, authUser.firebaseUid, "Aadhaar Front");
      assertRequiredKycDocument(aadhaarBack, authUser.firebaseUid, "Aadhaar Back");
      if (pan.uploaded) {
        assertRequiredKycDocument(pan, authUser.firebaseUid, "PAN");
      }

      const liveVerificationName = sanitizeOptionalString(payload.liveVerificationName);
      const liveVerificationHobbies = sanitizeOptionalString(payload.liveVerificationHobbies);
      if (
        !liveVerificationName ||
        !payload.liveVerificationAge ||
        !liveVerificationHobbies ||
        !liveVideo.uploaded
      ) {
        throw new HttpError(400, "Please complete live video verification before submitting.");
      }
      if (!liveVideo.storagePath) {
        throw new HttpError(400, "Live video: upload path is missing.");
      }
      if (!isPartnerKycPathForUser(liveVideo.storagePath, authUser.firebaseUid)) {
        throw new HttpError(400, "Live video: upload path does not match your login session. Please record and upload live verification again.");
      }
      if (!liveVideo.storagePath.includes("/live-video/")) {
        throw new HttpError(400, "Live video: upload path is invalid. Please record and upload live verification again.");
      }

      const applicationData = {
        fullName: payload.fullName,
        age: payload.age,
        gender: payload.gender,
        religion: payload.religion,
        bornCity: payload.bornCity,
        nationality: payload.nationality,
        school: payload.school,
        college: payload.college,
        qualification: payload.qualification,
        languagesKnown: payload.languagesKnown,
        communicationStyle: payload.communicationStyle,
        hobbies: payload.hobbies,
        profileTagline: payload.profileTagline,
        aboutYourself: payload.aboutYourself,
        servicesOffered,
        chatPrice: CHAT_RATE_PER_MIN,
        audioPrice: AUDIO_RATE_PER_MIN,
        videoPrice: VIDEO_RATE_PER_MIN,
        homeVisitRequested: Boolean(payload.homeVisitRequested),
        homeVisitPrice: payload.homeVisitRequested ? HOME_VISIT_RATE_PER_HOUR : null,
        categories: payload.categories,
        safetyChecklist: payload.safetyChecklist,
        selfieUploaded: selfie.uploaded,
        selfieFileName: selfie.fileName,
        selfieStoragePath: selfie.storagePath,
        selfieUrl: selfie.url,
        aadhaarFrontUploaded: aadhaarFront.uploaded,
        aadhaarFrontFileName: aadhaarFront.fileName,
        aadhaarFrontStoragePath: aadhaarFront.storagePath,
        aadhaarFrontUrl: aadhaarFront.url,
        aadhaarBackUploaded: aadhaarBack.uploaded,
        aadhaarBackFileName: aadhaarBack.fileName,
        aadhaarBackStoragePath: aadhaarBack.storagePath,
        aadhaarBackUrl: aadhaarBack.url,
        ...(pan.uploaded
          ? {
              panUploaded: pan.uploaded,
              panFileName: pan.fileName,
              panStoragePath: pan.storagePath,
              panUrl: pan.url,
            }
          : {}),
        liveVerificationName,
        liveVerificationAge: payload.liveVerificationAge,
        liveVerificationHobbies,
        liveVideoUploaded: liveVideo.uploaded,
        liveVideoFileName: liveVideo.fileName,
        liveVideoStoragePath: liveVideo.storagePath,
        liveVerificationSubmittedAt: new Date(),
      };

      const existingEditableApplication = await prisma.partnerApplication.findFirst({
        where: {
          applicantUserId: authUser.id,
          status: {
            in: [PartnerApplicationStatus.UNDER_REVIEW, PartnerApplicationStatus.NEEDS_INFO],
          },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      const application = existingEditableApplication
        ? await prisma.partnerApplication.update({
            where: { id: existingEditableApplication.id },
            data: {
              ...applicationData,
              status: PartnerApplicationStatus.UNDER_REVIEW,
            },
          })
        : await prisma.partnerApplication.create({
            data: {
              applicantUserId: authUser.id,
              ...applicationData,
            },
          });

      await prisma.user.update({
        where: { id: authUser.id },
        data: { role: Role.PARTNER, name: payload.fullName },
      });

      res.status(existingEditableApplication ? 200 : 201).json({ application });
    } catch (error) {
      const httpStatus = error instanceof HttpError ? error.statusCode : undefined;
      const detail =
        httpStatus === 401 || httpStatus === 403
          ? "AUTH_ERROR"
          : error instanceof HttpError || error instanceof ZodError
            ? "VALIDATION_ERROR"
          : error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientValidationError
            ? "DATABASE_ERROR"
            : "DATABASE_ERROR";

      console.error("Partner application submit failed", {
        message: error instanceof Error ? error.message : "Unknown error",
        code:
          typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : undefined,
        meta:
          typeof error === "object" && error && "meta" in error
            ? (error as { meta?: unknown }).meta
            : undefined,
        stack: process.env.NODE_ENV !== "production" && error instanceof Error ? error.stack : undefined,
      });

      const statusCode =
        detail === "AUTH_ERROR"
          ? (httpStatus ?? 401)
          : detail === "VALIDATION_ERROR"
            ? 400
            : 500;
      res.status(statusCode).json({
        error: error instanceof HttpError ? error.message : "Unable to submit partner application.",
        message: error instanceof HttpError ? error.message : "Unable to submit partner application.",
        detail,
      });
    }
  }),
);

partnerRouter.get(
  "/applications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const application = await prisma.partnerApplication.findFirst({
      where: { applicantUserId: authUser.id },
      include: { companion: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ application });
  }),
);

partnerRouter.get(
  "/applications/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const application = await prisma.partnerApplication.findFirst({
      where: { applicantUserId: authUser.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ application });
  }),
);

partnerRouter.get(
  "/dashboard",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const [companion, application] = await Promise.all([
      prisma.companion.findFirst({ where: { userId: authUser.id } }),
      prisma.partnerApplication.findFirst({
        where: { applicantUserId: authUser.id },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    assertPartnerDashboardAccess(companion);

    const isApproved = Boolean(
      application?.status === "APPROVED" ||
        (companion?.status === CompanionStatus.ACTIVE &&
          companion?.verificationStatus === VerificationStatus.VERIFIED),
    );
    const isUnderReview = !isApproved && Boolean(
      application?.status === "UNDER_REVIEW" ||
        application?.status === "NEEDS_INFO" ||
        companion?.status === CompanionStatus.UNDER_REVIEW ||
        companion?.verificationStatus === VerificationStatus.PENDING ||
        companion?.verificationStatus === VerificationStatus.NEEDS_REVIEW,
    );
    const isNotSubmitted = !application && !companion && !isApproved;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    let activeSessions: Array<{
      id: string;
      memberLabel: string;
      type: "CHAT" | "AUDIO" | "VIDEO";
      expectedRate: number;
      startedAt: string | null;
      status: SessionStatus;
    }> = [];

    let pendingRequests: Array<{
      id: string;
      memberLabel: string;
      type: "CHAT" | "AUDIO" | "VIDEO";
      expectedRate: number;
      createdAt: string;
    }> = [];

    let stats = {
      peopleSupportedToday: 0,
      audioConversations: 0,
      videoConversations: 0,
      pendingRequests: 0,
      earningsToday: 0,
      averageRating: companion?.rating ?? 0,
    };

    if (companion && isApproved) {
      const staleThreshold = new Date(Date.now() - STALE_LIVE_SESSION_MS);
      await prisma.session.updateMany({
        where: {
          companionId: companion.id,
          status: { in: ACTIVE_SESSION_STATUSES },
          endedAt: null,
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status: SessionStatus.EXPIRED,
          endedAt: new Date(),
        },
      });

      const [todaySessions, liveSessions, requestSessions, earningsTodayAgg] = await Promise.all([
        prisma.session.findMany({
          where: {
            companionId: companion.id,
            createdAt: { gte: startOfDay, lte: endOfDay },
          },
          select: {
            id: true,
            userId: true,
            serviceType: true,
            companionEarning: true,
            status: true,
          },
        }),
        prisma.session.findMany({
          where: {
            companionId: companion.id,
            status: { in: ACTIVE_SESSION_STATUSES },
            endedAt: null,
            updatedAt: { gte: staleThreshold },
          },
          include: { user: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
        prisma.session.findMany({
          where: { companionId: companion.id, status: SessionStatus.PENDING },
          include: { user: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.partnerEarning.aggregate({
          where: {
            companionId: companion.id,
            createdAt: { gte: startOfDay, lte: endOfDay },
            status: { in: [PartnerEarningStatus.PENDING, PartnerEarningStatus.AVAILABLE, PartnerEarningStatus.PAID] },
          },
          _sum: { partnerAmount: true },
        }),
      ]);

      const supportedToday = new Set(todaySessions.map((session) => session.userId)).size;
      const audioConversations = todaySessions.filter((session) => session.serviceType === ServiceType.AUDIO).length;
      const videoConversations = todaySessions.filter((session) => session.serviceType === ServiceType.VIDEO).length;
      const earningsToday = decimalToNumber(earningsTodayAgg._sum.partnerAmount);

      stats = {
        peopleSupportedToday: supportedToday,
        audioConversations,
        videoConversations,
        pendingRequests: requestSessions.length,
        earningsToday,
        averageRating: companion.rating ?? 0,
      };

      activeSessions = Array.from(
        new Map(
          liveSessions.map((session) => [
            session.id,
            {
              id: session.id,
              memberLabel: session.user.phoneNumber,
              memberPhoneMasked: maskPhoneNumber(session.user.phoneNumber),
              memberName: session.user.name ?? "Member",
              type: session.serviceType,
              expectedRate: getFixedSessionRate(session.serviceType),
              startedAt: session.startedAt ? session.startedAt.toISOString() : null,
              status: session.status,
            },
          ]),
        ).values(),
      );

      pendingRequests = requestSessions.map((session) => ({
        id: session.id,
        memberLabel: session.user.phoneNumber,
        memberPhoneMasked: maskPhoneNumber(session.user.phoneNumber),
        memberName: session.user.name ?? "Member",
        type: session.serviceType,
        expectedRate: getFixedSessionRate(session.serviceType),
        createdAt: session.createdAt.toISOString(),
      }));
    }

    const isBusy = activeSessions.length > 0;
    const isOnline = companion ? companion.availability !== CompanionAvailability.OFFLINE : false;
    const isPresenceOnline = companion ? isCompanionListedOnline(companion, isBusy) : false;
    const effectiveStatus = companion
      ? resolveCompanionAvailability(companion, isBusy)
      : CompanionAvailability.OFFLINE;

    res.json({
      hasApplication: Boolean(application),
      applicationStatus: application?.status ?? "NOT_SUBMITTED",
      companionStatus: companion?.status ?? "UNDER_REVIEW",
      verificationStatus: companion?.verificationStatus ?? "PENDING",
      kycStatus:
        companion?.verificationStatus === VerificationStatus.VERIFIED
          ? "VERIFIED"
          : "PENDING",
      approvalState: {
        hasApplication: Boolean(application),
        applicationStatus: application?.status ?? null,
        kycStatus:
          companion?.verificationStatus === VerificationStatus.VERIFIED
            ? "VERIFIED"
            : companion?.verificationStatus === VerificationStatus.FAILED
              ? "REJECTED"
              : "PENDING",
        companionStatus: companion?.status ?? null,
        verificationStatus:
          companion?.verificationStatus === VerificationStatus.FAILED
            ? "REJECTED"
            : companion?.verificationStatus ?? null,
        approved: isApproved,
        underReview: isUnderReview,
        notSubmitted: isNotSubmitted,
      },
      approved: isApproved,
      underReview: isUnderReview,
      notSubmitted: isNotSubmitted,
      message: isApproved
        ? "Partner dashboard ready."
        : "Your profile is being reviewed by our safety team.",
      companion: companion
        ? {
            id: companion.id,
            status: companion.status,
            verificationStatus: companion.verificationStatus,
            isOnline: isPresenceOnline,
            rawIsOnline: isOnline,
            isBusy,
            effectiveStatus,
          }
        : null,
      availability: {
        isOnline: isPresenceOnline,
        rawIsOnline: isOnline,
        presenceFresh: isPresenceOnline,
        isBusy,
        effectiveStatus,
      },
      application: application ?? null,
      stats,
      pendingRequests,
      activeSessions,
    });
  }),
);

partnerRouter.get(
  "/requests",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (
      !companion ||
      companion.status !== CompanionStatus.ACTIVE ||
      companion.verificationStatus !== VerificationStatus.VERIFIED
    ) {
      res.json({ pendingRequests: [] });
      return;
    }

    const requestSessions = await prisma.session.findMany({
      where: { companionId: companion.id, status: SessionStatus.PENDING },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      pendingRequests: requestSessions.map((session) => ({
        id: session.id,
        memberLabel: session.user.phoneNumber,
        memberPhoneMasked: maskPhoneNumber(session.user.phoneNumber),
        memberName: session.user.name ?? "Member",
        type: session.serviceType,
        expectedRate: getFixedSessionRate(session.serviceType),
        createdAt: session.createdAt.toISOString(),
      })),
    });
  }),
);

partnerRouter.post(
  "/requests/:id/accept",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (
      !companion ||
      companion.status !== CompanionStatus.ACTIVE ||
      companion.verificationStatus !== VerificationStatus.VERIFIED
    ) {
      throw new HttpError(403, "Partner approval is required before accepting requests.");
    }

    const existing = await prisma.session.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.companionId !== companion.id) {
      throw new HttpError(404, "Request not found.");
    }

    if (existing.status !== SessionStatus.PENDING) {
      res.json({
        session: {
          id: existing.id,
          type: existing.serviceType,
          status: existing.status,
          channelName: buildChannelName(existing.id),
          acceptedAt: existing.acceptedAt,
          startedAt: existing.startedAt,
          liveStartedAt: existing.liveStartedAt,
          endedAt: existing.endedAt,
          userId: existing.userId,
          companionId: existing.companionId,
        },
        message: "Request is no longer pending.",
      });
      return;
    }

    const now = new Date();
    const nextStatus = existing.serviceType === ServiceType.CHAT ? SessionStatus.LIVE : SessionStatus.ACCEPTED;
    const nextLiveStartedAt = existing.serviceType === ServiceType.CHAT ? existing.liveStartedAt ?? now : existing.liveStartedAt;
    const nextStartedAt =
      existing.serviceType === ServiceType.CHAT
        ? existing.startedAt ?? existing.liveStartedAt ?? existing.acceptedAt ?? now
        : existing.startedAt;
    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        acceptedAt: existing.acceptedAt ?? now,
        liveStartedAt: nextLiveStartedAt,
        startedAt: nextStartedAt,
        lastHeartbeatAt: now,
      },
    });

    res.json({
      session: {
        id: updated.id,
        type: updated.serviceType,
        status: updated.status,
        channelName: buildChannelName(updated.id),
        acceptedAt: updated.acceptedAt,
        startedAt: updated.startedAt,
        liveStartedAt: updated.liveStartedAt,
        endedAt: updated.endedAt,
        userId: updated.userId,
        companionId: updated.companionId,
      },
    });
  }),
);

partnerRouter.post(
  "/requests/:id/decline",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (
      !companion ||
      companion.status !== CompanionStatus.ACTIVE ||
      companion.verificationStatus !== VerificationStatus.VERIFIED
    ) {
      throw new HttpError(403, "Partner approval is required before declining requests.");
    }

    const existing = await prisma.session.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.companionId !== companion.id) {
      throw new HttpError(404, "Request not found.");
    }

    if (existing.status !== SessionStatus.PENDING) {
      res.json({ request: existing, message: "Request is no longer pending." });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updated = await tx.session.update({
        where: { id: existing.id },
        data: {
          status: SessionStatus.DECLINED,
          endedAt: existing.endedAt ?? new Date(),
          endedByUserId: authUser.id,
        },
      });
      await tx.userReward.updateMany({
        where: {
          status: UserRewardStatus.ACTIVE,
          redemptionReferenceId: existing.id,
        },
        data: {
          redemptionReferenceId: null,
        },
      });
      return updated;
    });

    res.json({
      request: updated,
      sessionId: updated.id,
      type: updated.serviceType,
    });
  }),
);

partnerRouter.get(
  "/profile",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    const application = await prisma.partnerApplication.findFirst({
      where: {
        applicantUserId: authUser.id,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ companion, application });
  }),
);

partnerRouter.patch(
  "/availability",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = partnerAvailabilitySchema.parse(req.body);
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    if (
      !companion ||
      companion.status !== CompanionStatus.ACTIVE ||
      companion.verificationStatus !== VerificationStatus.VERIFIED
    ) {
      throw new HttpError(403, "Partner approval is required before updating availability.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        isOnline: payload.isOnline,
        availability: payload.isOnline
          ? CompanionAvailability.ONLINE
          : CompanionAvailability.OFFLINE,
        availabilitySetByAdminAt: null,
      },
    });

    res.json({
      isOnline: updated.availability !== CompanionAvailability.OFFLINE,
      companion: updated,
    });
  }),
);

partnerRouter.post(
  "/presence/online",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        isOnline: true,
        availability: CompanionAvailability.ONLINE,
        availabilitySetByAdminAt: null,
      },
    });
    const isBusy = await hasActiveCompanionSession(updated.id);
    const effectiveStatus = resolveCompanionAvailability(updated, isBusy);
    const presenceFresh = effectiveStatus !== CompanionAvailability.OFFLINE;

    res.json({
      isOnline: presenceFresh,
      rawIsOnline: updated.availability !== CompanionAvailability.OFFLINE,
      presenceFresh,
      isBusy,
      effectiveStatus,
      updatedAt: updated.updatedAt,
    });
  }),
);

partnerRouter.post(
  "/presence/heartbeat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        isOnline: companion.availability !== CompanionAvailability.OFFLINE,
        availability: companion.availability,
      },
    });
    const isBusy = await hasActiveCompanionSession(updated.id);
    const effectiveStatus = resolveCompanionAvailability(updated, isBusy);
    const presenceFresh = effectiveStatus !== CompanionAvailability.OFFLINE;

    res.json({
      isOnline: presenceFresh,
      rawIsOnline: updated.availability !== CompanionAvailability.OFFLINE,
      presenceFresh,
      isBusy,
      effectiveStatus,
      updatedAt: updated.updatedAt,
    });
  }),
);

partnerRouter.post(
  "/presence/offline",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        isOnline: false,
        availability: CompanionAvailability.OFFLINE,
        availabilitySetByAdminAt: null,
      },
    });
    const isBusy = await hasActiveCompanionSession(updated.id);

    res.json({
      isOnline: false,
      rawIsOnline: updated.isOnline,
      presenceFresh: false,
      isBusy,
      effectiveStatus: CompanionAvailability.OFFLINE,
      updatedAt: updated.updatedAt,
    });
  }),
);

partnerRouter.post(
  "/presence/offline-beacon",
  asyncHandler(async (req, res) => {
    const idToken = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!idToken) {
      res.status(400).json({ error: "TOKEN_REQUIRED" });
      return;
    }
    if (!firebaseAdminAuth || !isFirebaseAdminConfigured()) {
      res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
      return;
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await firebaseAdminAuth.verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    if (decoded.aud !== env.FIREBASE_ADMIN_PROJECT_ID) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const companionOwner = await prisma.user.findFirst({
      where: {
        OR: [
          { firebaseUid: decoded.uid },
          ...(decoded.phone_number ? [{ phoneNumber: decoded.phone_number }] : []),
        ],
      },
      select: { id: true },
    });

    if (!companionOwner) {
      res.status(404).json({ error: "USER_NOT_FOUND" });
      return;
    }

    await prisma.companion.updateMany({
      where: { userId: companionOwner.id },
      data: {
        isOnline: false,
        availability: CompanionAvailability.OFFLINE,
        availabilitySetByAdminAt: null,
      },
    });

    res.status(202).json({ ok: true });
  }),
);

partnerRouter.patch(
  "/profile",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        displayName: typeof req.body.displayName === "string" ? req.body.displayName : companion.displayName,
        tagline: typeof req.body.tagline === "string" ? req.body.tagline : companion.tagline,
        city: typeof req.body.city === "string" ? req.body.city : companion.city,
        category: typeof req.body.category === "string" ? req.body.category : companion.category,
        isOnline: typeof req.body.isOnline === "boolean" ? req.body.isOnline : companion.isOnline,
        availability:
          typeof req.body.isOnline === "boolean"
            ? req.body.isOnline
              ? CompanionAvailability.ONLINE
              : CompanionAvailability.OFFLINE
            : companion.availability,
        availabilitySetByAdminAt:
          typeof req.body.isOnline === "boolean" ? null : companion.availabilitySetByAdminAt,
      },
    });

    res.json({ companion: updated });
  }),
);

partnerRouter.get(
  "/profile/media",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
      select: {
        id: true,
        moderationStatus: true,
        moderationExpiresAt: true,
        profileImageUrl: true,
        profileImageStoragePath: true,
        galleryImageUrls: true,
        galleryImageStoragePaths: true,
      },
    });
    assertPartnerDashboardAccess(companion);

    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const latestApplicationWithSelfie = await prisma.partnerApplication.findFirst({
      where: {
        applicantUserId: authUser.id,
        OR: [{ selfieStoragePath: { not: null } }, { selfieUrl: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        selfieStoragePath: true,
        selfieUrl: true,
      },
    });

    const selfieStoragePath = companion.profileImageStoragePath || latestApplicationWithSelfie?.selfieStoragePath || null;
    const resolvedProfileImageUrl =
      companion.profileImageUrl ??
      (selfieStoragePath ? getCompanionProfileImageProxyUrl(req, companion.id) : latestApplicationWithSelfie?.selfieUrl ?? null);

    const galleryItems = companion.galleryImageUrls.map((imageUrl, index) => ({
      imageUrl,
      storagePath: companion.galleryImageStoragePaths[index] ?? "",
    }));

    res.json({
      profileImageUrl: companion.profileImageUrl,
      profileImageStoragePath: companion.profileImageStoragePath,
      resolvedProfileImageUrl,
      galleryImages: galleryItems,
    });
  }),
);

partnerRouter.put(
  "/profile/media/profile-image",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = partnerProfileImageSchema.parse(req.body);
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
      select: { id: true, moderationStatus: true, moderationExpiresAt: true },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        profileImageUrl: payload.imageUrl,
        profileImageStoragePath: payload.storagePath,
      },
      select: {
        profileImageUrl: true,
        profileImageStoragePath: true,
      },
    });

    res.json({
      profileImageUrl: updated.profileImageUrl,
      profileImageStoragePath: updated.profileImageStoragePath,
    });
  }),
);

partnerRouter.post(
  "/profile/media/gallery",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = partnerGalleryImageSchema.parse(req.body);
    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
      select: {
        id: true,
        moderationStatus: true,
        moderationExpiresAt: true,
        galleryImageUrls: true,
        galleryImageStoragePaths: true,
      },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const existingIndexByPath = companion.galleryImageStoragePaths.findIndex((path) => path === payload.storagePath);
    const existingIndexByUrl = companion.galleryImageUrls.findIndex((url) => url === payload.imageUrl);
    const isExisting = existingIndexByPath >= 0 || existingIndexByUrl >= 0;

    let nextUrls = [...companion.galleryImageUrls];
    let nextPaths = [...companion.galleryImageStoragePaths];
    if (!isExisting) {
      if (nextUrls.length >= MAX_GALLERY_IMAGES) {
        throw new HttpError(400, `You can upload up to ${MAX_GALLERY_IMAGES} gallery images.`);
      }
      nextUrls.push(payload.imageUrl);
      nextPaths.push(payload.storagePath);
    } else {
      const existingIndex = existingIndexByPath >= 0 ? existingIndexByPath : existingIndexByUrl;
      nextUrls[existingIndex] = payload.imageUrl;
      nextPaths[existingIndex] = payload.storagePath;
    }

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        galleryImageUrls: nextUrls,
        galleryImageStoragePaths: nextPaths,
      },
      select: {
        galleryImageUrls: true,
        galleryImageStoragePaths: true,
      },
    });

    res.status(201).json({
      galleryImages: updated.galleryImageUrls.map((imageUrl, index) => ({
        imageUrl,
        storagePath: updated.galleryImageStoragePaths[index] ?? "",
      })),
    });
  }),
);

partnerRouter.delete(
  "/profile/media/gallery",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = partnerDeleteGalleryImageSchema.parse(req.body ?? {});
    if (!payload.imageUrl && !payload.storagePath) {
      throw new HttpError(400, "imageUrl or storagePath is required.");
    }

    const companion = await prisma.companion.findFirst({
      where: { userId: authUser.id },
      select: {
        id: true,
        moderationStatus: true,
        moderationExpiresAt: true,
        galleryImageUrls: true,
        galleryImageStoragePaths: true,
      },
    });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const matchIndex = companion.galleryImageUrls.findIndex((url, index) => {
      if (payload.storagePath && companion.galleryImageStoragePaths[index] === payload.storagePath) return true;
      if (payload.imageUrl && url === payload.imageUrl) return true;
      return false;
    });

    if (matchIndex < 0) {
      throw new HttpError(404, "Gallery image not found.");
    }

    const nextUrls = companion.galleryImageUrls.filter((_, index) => index !== matchIndex);
    const nextPaths = companion.galleryImageStoragePaths.filter((_, index) => index !== matchIndex);

    const updated = await prisma.companion.update({
      where: { id: companion.id },
      data: {
        galleryImageUrls: nextUrls,
        galleryImageStoragePaths: nextPaths,
      },
      select: {
        galleryImageUrls: true,
        galleryImageStoragePaths: true,
      },
    });

    res.json({
      galleryImages: updated.galleryImageUrls.map((imageUrl, index) => ({
        imageUrl,
        storagePath: updated.galleryImageStoragePaths[index] ?? "",
      })),
    });
  }),
);

partnerRouter.get(
  "/bookings",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      res.json({ bookings: [] });
      return;
    }
    const bookings = await prisma.booking.findMany({
      where: { companionId: companion.id },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  }),
);

partnerRouter.get(
  "/sessions",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      res.json({ sessions: [] });
      return;
    }
    const sessions = await prisma.session.findMany({
      where: { companionId: companion.id },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ sessions });
  }),
);

partnerRouter.get(
  "/payouts/summary",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      res.json({
        summary: {
          availableEarnings: 0,
          availableToWithdraw: 0,
          pendingPayoutAmount: 0,
          totalPaidAmount: 0,
          earnedAvailableAmount: 0,
          bankDetails: {
            required: false,
            status: "NOT_CONFIGURED",
            note: "Bank details are not stored in the current payout model. Admin may verify payout details before processing.",
          },
        },
      });
      return;
    }

    const summary = await getPartnerPayoutBalances(prisma, companion.id);
    res.json({ summary });
  }),
);

partnerRouter.get(
  "/payouts",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      res.json({ payouts: [] });
      return;
    }

    const payouts = await prisma.payout.findMany({
      where: { companionId: companion.id },
      orderBy: { requestedAt: "desc" },
    });

    res.json({ payouts: payouts.map(toPartnerPayoutPayload) });
  }),
);

partnerRouter.post(
  "/payouts/request",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = payoutRequestSchema.parse(req.body);
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const createRequest = async () =>
      prisma.$transaction(
        async (tx) => {
          const balances = await getPartnerPayoutBalances(tx, companion.id);
          if (payload.amount <= 0) {
            throw new HttpError(400, "Payout amount must be greater than zero.");
          }
          if (payload.amount > balances.availableToWithdraw) {
            throw new HttpError(400, "Payout amount exceeds available earnings.");
          }

          const payout = await tx.payout.create({
            data: {
              payoutCode: createCode("PO"),
              companionId: companion.id,
              amount: payload.amount,
              status: PayoutStatus.REQUESTED,
            },
          });

          return {
            payout,
            summary: await getPartnerPayoutBalances(tx, companion.id),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    let result: Awaited<ReturnType<typeof createRequest>>;
    try {
      result = await createRequest();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        result = await createRequest();
      } else {
        throw error;
      }
    }

    res.status(201).json({
      payout: toPartnerPayoutPayload(result.payout),
      summary: result.summary,
      message: "Payout request submitted.",
    });
  }),
);

partnerRouter.get(
  "/earnings",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const isAdmin = authUser.role === Role.ADMIN;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      res.json({
        earnings: [],
        payouts: [],
        summary: {
          totalEarnings: 0,
          sessionEarnings: 0,
          giftEarnings: 0,
          pendingAmount: 0,
          availableBalance: 0,
          paidAmount: 0,
          pendingPayoutAmount: 0,
          totalPaidAmount: 0,
          ...(isAdmin ? { companyTotal: 0 } : {}),
        },
      });
      return;
    }
    const [partnerEarnings, payouts] = await Promise.all([
      prisma.partnerEarning.findMany({
        where: { companionId: companion.id },
        include: {
          user: {
            select: {
              name: true,
              phoneNumber: true,
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
      prisma.payout.findMany({
        where: { companionId: companion.id },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const payoutBalances = await getPartnerPayoutBalances(prisma, companion.id);

    const summary = partnerEarnings.reduce(
      (acc, row) => {
        const partnerAmount = decimalToNumber(row.partnerAmount);
        const companyAmount = decimalToNumber(row.companyAmount);
        const isSession = row.sourceType === PartnerEarningSourceType.SESSION;
        const isPending = row.status === PartnerEarningStatus.PENDING;
        const isAvailable = row.status === PartnerEarningStatus.AVAILABLE;
        const isPaid = row.status === PartnerEarningStatus.PAID;

        acc.totalEarnings += partnerAmount;
        acc.companyTotal += companyAmount;
        if (isSession) {
          acc.sessionEarnings += partnerAmount;
        } else {
          acc.giftEarnings += partnerAmount;
        }
        if (isPending) acc.pendingAmount += partnerAmount;
        if (isAvailable) acc.availableBalance += partnerAmount;
        if (isPaid) acc.paidAmount += partnerAmount;
        return acc;
      },
      {
        totalEarnings: 0,
        companyTotal: 0,
        sessionEarnings: 0,
        giftEarnings: 0,
        pendingAmount: 0,
        availableBalance: 0,
        paidAmount: 0,
      },
    );

    res.json({
      earnings: partnerEarnings.map((row) => ({
        id: row.id,
        date: row.createdAt.toISOString(),
        sourceType: row.sourceType,
        source: row.sourceType === PartnerEarningSourceType.SESSION ? (row.session?.serviceType ?? "SESSION") : "GIFT",
        user: row.user.name?.trim() || maskPhoneNumber(row.user.phoneNumber),
        myEarnings: decimalToNumber(row.partnerAmount),
        status: row.status,
        ...(isAdmin
          ? {
              grossAmount: decimalToNumber(row.grossAmount),
              companyAmount: decimalToNumber(row.companyAmount),
              partnerPercent: decimalToNumber(row.partnerPercent),
              companyPercent: decimalToNumber(row.companyPercent),
            }
          : {}),
      })),
      payouts: payouts.map(toPartnerPayoutPayload),
      summary: isAdmin
        ? {
            ...summary,
            companyTotal: summary.companyTotal,
          }
        : {
            totalEarnings: summary.totalEarnings,
            sessionEarnings: summary.sessionEarnings,
            giftEarnings: summary.giftEarnings,
            availableBalance: payoutBalances.availableToWithdraw,
            pendingAmount: summary.pendingAmount,
            paidAmount: summary.paidAmount,
            pendingPayoutAmount: payoutBalances.pendingPayoutAmount,
            totalPaidAmount: payoutBalances.totalPaidAmount,
          },
    });
  }),
);
