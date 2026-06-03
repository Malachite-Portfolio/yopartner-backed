import { Router } from "express";
import {
  CompanionStatus,
  PartnerEarningSourceType,
  PartnerEarningStatus,
  Prisma,
  Role,
  ServiceType,
  SessionStatus,
  VerificationStatus,
} from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z, ZodError } from "zod";
import { requireAuth } from "../middlewares/auth";
import { requireRole } from "../middlewares/roles";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { HttpError } from "../utils/http";
import { firebaseAdminAuth, isFirebaseAdminConfigured } from "../config/firebaseAdmin";
import { env } from "../config/env";
import { assertPartnerDashboardAccess } from "../utils/moderation";
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

const MAX_GALLERY_IMAGES = 6;
const STALE_LIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.LIVE, SessionStatus.ACCEPTED];
const PARTNER_PRESENCE_STALE_MS = 90 * 1000;

function isPartnerPresenceFresh(companion: { isOnline: boolean; updatedAt: Date }) {
  if (!companion.isOnline) return false;
  return Date.now() - companion.updatedAt.getTime() <= PARTNER_PRESENCE_STALE_MS;
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

export const partnerRouter = Router();

partnerRouter.post(
  "/applications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;

    try {
      const parsed = onboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        console.error("Partner application submit failed", {
          message: "Validation failed",
          code: "VALIDATION_ERROR",
          meta: parsed.error.flatten(),
        });
        res.status(400).json({
          error: "Unable to submit partner application.",
          detail: "VALIDATION_ERROR",
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

      const application = await prisma.partnerApplication.create({
        data: {
          applicantUserId: authUser.id,
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
          panUploaded: pan.uploaded,
          panFileName: pan.fileName,
          panStoragePath: pan.storagePath,
          panUrl: pan.url,
        },
      });

      await prisma.user.update({
        where: { id: authUser.id },
        data: { role: Role.PARTNER, name: payload.fullName },
      });

      res.status(201).json({ application });
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
        error: "Unable to submit partner application.",
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
    const isOnline = Boolean(companion?.isOnline);
    const isPresenceOnline = companion ? isPartnerPresenceFresh(companion) : false;
    const effectiveOnline = isOnline && isPresenceOnline;
    const effectiveStatus = !effectiveOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";

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
            isOnline: effectiveOnline,
            rawIsOnline: companion.isOnline,
            isBusy,
            effectiveStatus,
          }
        : null,
      availability: {
        isOnline: effectiveOnline,
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

    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: {
        status: SessionStatus.DECLINED,
        endedAt: existing.endedAt ?? new Date(),
        endedByUserId: authUser.id,
      },
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
      data: { isOnline: payload.isOnline },
    });

    res.json({
      isOnline: updated.isOnline,
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
      data: { isOnline: true },
    });

    res.json({
      isOnline: true,
      rawIsOnline: updated.isOnline,
      presenceFresh: true,
      effectiveStatus: "ONLINE",
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
      data: { isOnline: companion.isOnline },
    });
    const effectiveOnline = isPartnerPresenceFresh(updated);

    res.json({
      isOnline: effectiveOnline,
      rawIsOnline: updated.isOnline,
      presenceFresh: effectiveOnline,
      effectiveStatus: effectiveOnline ? "ONLINE" : "OFFLINE",
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
      data: { isOnline: false },
    });

    res.json({
      isOnline: false,
      rawIsOnline: updated.isOnline,
      presenceFresh: false,
      effectiveStatus: "OFFLINE",
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
      data: { isOnline: false },
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
        selfieUrl: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: {
        selfieUrl: true,
      },
    });

    const resolvedProfileImageUrl = companion.profileImageUrl ?? latestApplicationWithSelfie?.selfieUrl ?? null;

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

    const summary = partnerEarnings.reduce(
      (acc, row) => {
        const gross = decimalToNumber(row.grossAmount);
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
        grossAmount: decimalToNumber(row.grossAmount),
        myEarnings: decimalToNumber(row.partnerAmount),
        status: row.status,
        ...(isAdmin
          ? {
              companyAmount: decimalToNumber(row.companyAmount),
              partnerPercent: decimalToNumber(row.partnerPercent),
              companyPercent: decimalToNumber(row.companyPercent),
            }
          : {}),
      })),
      payouts,
      summary: isAdmin
        ? {
            ...summary,
            companyTotal: summary.companyTotal,
          }
        : {
            totalEarnings: summary.totalEarnings,
            sessionEarnings: summary.sessionEarnings,
            giftEarnings: summary.giftEarnings,
            availableBalance: summary.availableBalance,
            pendingAmount: summary.pendingAmount,
            paidAmount: summary.paidAmount,
          },
    });
  }),
);
