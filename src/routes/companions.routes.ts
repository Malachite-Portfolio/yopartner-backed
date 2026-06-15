import { Router, type Request } from "express";
import {
  CompanionAvailability,
  CompanionStatus,
  HomeVisitVerificationStatus,
  PartnerModerationStatus,
  PartnerApplicationStatus,
  SessionStatus,
  VerificationStatus,
} from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { resolvePartnerModerationStatus } from "../utils/moderation";
import { firebaseAdminStorage } from "../config/firebaseAdmin";
import {
  isCompanionListedOnline,
  resolveCompanionAvailability,
} from "../utils/partnerAvailability";
import {
  AUDIO_RATE_PER_MIN,
  CHAT_RATE_PER_MIN,
  HOME_VISIT_RATE_PER_HOUR,
  VIDEO_RATE_PER_MIN,
} from "../config/platformPricing";

export const companionsRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];
const KYC_STORAGE_PREFIX = "YoPartner/partner-kyc/";

type ApprovedSelfieFallback = {
  selfieStoragePath: string | null;
  selfieUrl: string | null;
} | null | undefined;

function toPublicCompanionSummary(
  req: Request,
  companion: {
    id: string;
    displayName: string;
    tagline: string | null;
    city: string | null;
    category: string | null;
    languages: string[];
    servicesOffered: unknown[];
    chatPrice: number;
    audioPrice: number;
    videoPrice: number;
    rating: number;
    availability: CompanionAvailability;
    availabilitySetByAdminAt: Date | null;
    isPinned: boolean;
    pinnedAt: Date | null;
    updatedAt: Date;
    profileImageUrl: string | null;
    profileImageStoragePath?: string | null;
    galleryImageUrls: string[];
  },
  approvedSelfieFallback: ApprovedSelfieFallback,
  isBusy: boolean,
) {
  const effectiveStatus = resolveCompanionAvailability(companion, isBusy);
  const effectiveOnline = isCompanionListedOnline(companion, isBusy);
  const profileImageUrl = resolvePublicProfileImageUrl(req, companion, approvedSelfieFallback);

  return {
    id: companion.id,
    displayName: companion.displayName,
    name: companion.displayName,
    tagline: companion.tagline ?? "",
    city: companion.city,
    category: companion.category,
    languages: companion.languages,
    servicesOffered: companion.servicesOffered,
    chatPrice: CHAT_RATE_PER_MIN,
    audioPrice: AUDIO_RATE_PER_MIN,
    videoPrice: VIDEO_RATE_PER_MIN,
    chatRate: CHAT_RATE_PER_MIN,
    audioRate: AUDIO_RATE_PER_MIN,
    videoRate: VIDEO_RATE_PER_MIN,
    rating: companion.rating,
    ratingAverage: companion.rating,
    profileImageUrl,
    image: profileImageUrl,
    galleryImageUrls: companion.galleryImageUrls,
    galleryImages: companion.galleryImageUrls,
    resolvedProfileImageUrl: profileImageUrl,
    isOnline: effectiveOnline,
    isBusy,
    effectiveStatus,
    isPinned: companion.isPinned,
    pinnedAt: companion.pinnedAt,
  };
}

function isCompanionVisibleForListing(companion: {
  moderationStatus: PartnerModerationStatus;
  moderationExpiresAt: Date | null;
}) {
  const status = resolvePartnerModerationStatus(companion);
  return status !== PartnerModerationStatus.BANNED && status !== PartnerModerationStatus.TEMP_BANNED && status !== PartnerModerationStatus.HIDDEN;
}

function availabilityRank(status: CompanionAvailability | string | null | undefined) {
  if (status === CompanionAvailability.ONLINE) return 0;
  if (status === CompanionAvailability.BUSY) return 1;
  if (status === CompanionAvailability.OFFLINE) return 2;
  return 3;
}

function normalizeStringArray(value: string[] | null | undefined) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function cleanText(value: string | null | undefined) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function normalizeServiceLabel(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "CHAT") return "Chat";
  if (normalized === "AUDIO") return "Audio Call";
  if (normalized === "VIDEO") return "Video Call";
  if (normalized === "HOME_VISIT") return "Home Visit";
  return value.trim();
}

function normalizeServiceArray(value: unknown[] | string[] | null | undefined) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => normalizeServiceLabel(String(item)))
    .filter(Boolean);
}

function isSafePublicUrl(value: string | null | undefined) {
  const text = cleanText(value);
  if (!text) return false;
  if (/^(https?:\/\/)/i.test(text)) return true;
  if (text.startsWith("/")) return true;
  return false;
}

function sanitizePublicUrl(value: string | null | undefined) {
  return isSafePublicUrl(value) ? cleanText(value) : null;
}

function sanitizePublicUrls(values: string[] | null | undefined) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizePublicUrl(value))
    .filter((value): value is string => Boolean(value));
}

function getRequestOrigin(req: Request) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = req.get("host");
  return host ? `${protocol}://${host}` : "";
}

function getCompanionProfileImageProxyUrl(req: Request, companionId: string) {
  const origin = getRequestOrigin(req);
  const path = `/api/companions/${encodeURIComponent(companionId)}/profile-image`;
  return origin ? `${origin}${path}` : path;
}

function resolvePublicProfileImageUrl(
  req: Request,
  companion: { id: string; profileImageUrl: string | null; profileImageStoragePath?: string | null },
  approvedSelfieFallback: ApprovedSelfieFallback,
) {
  const customProfileImageUrl = sanitizePublicUrl(companion.profileImageUrl);
  if (customProfileImageUrl) return customProfileImageUrl;

  const selfieStoragePath = cleanText(companion.profileImageStoragePath) || cleanText(approvedSelfieFallback?.selfieStoragePath);
  if (selfieStoragePath) return getCompanionProfileImageProxyUrl(req, companion.id);

  return sanitizePublicUrl(approvedSelfieFallback?.selfieUrl);
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

const latestApprovedSelfieSelect = {
  where: {
    status: PartnerApplicationStatus.APPROVED,
    OR: [{ selfieStoragePath: { not: null } }, { selfieUrl: { not: null } }],
  },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: {
    selfieStoragePath: true,
    selfieUrl: true,
  },
};

async function getBusyCompanionIds(companionIds: string[]) {
  if (companionIds.length === 0) return new Set<string>();
  const staleThreshold = new Date(Date.now() - STALE_ACTIVE_SESSION_MS);
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

  const active = await prisma.session.findMany({
    where: {
      companionId: { in: companionIds },
      status: { in: ACTIVE_SESSION_STATUSES },
      endedAt: null,
      updatedAt: { gte: staleThreshold },
    },
    select: { companionId: true },
  });

  return new Set(active.map((session) => session.companionId));
}

companionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const online = req.query.online === "true" || req.query.availability === "online";

    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: { notIn: [PartnerModerationStatus.BANNED, PartnerModerationStatus.TEMP_BANNED, PartnerModerationStatus.HIDDEN] },
        ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: "insensitive" } },
                { tagline: { contains: search, mode: "insensitive" } },
                { city: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        partnerApplications: latestApprovedSelfieSelect,
      },
      orderBy: [{ isPinned: "desc" }, { pinnedAt: "desc" }, { isOnline: "desc" }, { rating: "desc" }, { createdAt: "desc" }],
    });
    const visibleCompanions = companions.filter((companion) => isCompanionVisibleForListing(companion));

    const busySet = await getBusyCompanionIds(visibleCompanions.map((companion) => companion.id));
    const summaries = visibleCompanions.map((companion) => {
      const isBusy = busySet.has(companion.id);
      return toPublicCompanionSummary(req, companion, companion.partnerApplications[0], isBusy);
    });
    const sortedSummaries = summaries
      .map((companion, index) => ({ companion, index }))
      .sort((first, second) => {
        const pinnedDelta = Number(Boolean(second.companion.isPinned)) - Number(Boolean(first.companion.isPinned));
        if (pinnedDelta) return pinnedDelta;
        if (first.companion.isPinned && second.companion.isPinned) {
          const firstPinnedAt = first.companion.pinnedAt ? new Date(first.companion.pinnedAt).getTime() : 0;
          const secondPinnedAt = second.companion.pinnedAt ? new Date(second.companion.pinnedAt).getTime() : 0;
          const pinnedAtDelta = secondPinnedAt - firstPinnedAt;
          if (pinnedAtDelta) return pinnedAtDelta;
        }
        const rankDelta = availabilityRank(first.companion.effectiveStatus) - availabilityRank(second.companion.effectiveStatus);
        return rankDelta || first.index - second.index;
      })
      .map(({ companion }) => companion);
    res.json({
      companions: online ? sortedSummaries.filter((companion) => companion.effectiveStatus !== CompanionAvailability.OFFLINE) : sortedSummaries,
    });
  }),
);

companionsRouter.get(
  "/featured",
  asyncHandler(async (req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: { notIn: [PartnerModerationStatus.BANNED, PartnerModerationStatus.TEMP_BANNED, PartnerModerationStatus.HIDDEN] },
      },
      include: {
        partnerApplications: latestApprovedSelfieSelect,
      },
      orderBy: [{ rating: "desc" }],
      take: 12,
    });
    const visibleCompanions = companions.filter((companion) => isCompanionVisibleForListing(companion));
    const busySet = await getBusyCompanionIds(visibleCompanions.map((companion) => companion.id));
    res.json({
      companions: visibleCompanions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        return toPublicCompanionSummary(req, companion, companion.partnerApplications[0], isBusy);
      }),
    });
  }),
);

companionsRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const totalActiveCompanions = await prisma.companion.count({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: PartnerModerationStatus.ACTIVE,
      },
    });

    res.json({ totalActiveCompanions });
  }),
);

companionsRouter.get(
  "/home-visits",
  asyncHandler(async (req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: PartnerModerationStatus.ACTIVE,
        homeVisitVerificationStatus: HomeVisitVerificationStatus.APPROVED,
      },
      include: {
        partnerApplications: latestApprovedSelfieSelect,
      },
      orderBy: [{ isOnline: "desc" }, { rating: "desc" }],
    });
    const busySet = await getBusyCompanionIds(companions.map((companion) => companion.id));
    res.json({
      companions: companions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        return toPublicCompanionSummary(req, companion, companion.partnerApplications[0], isBusy);
      }),
    });
  }),
);

companionsRouter.get(
  "/:id/profile-image",
  asyncHandler(async (req, res) => {
    if (!firebaseAdminStorage) {
      res.status(404).json({ error: "NOT_FOUND", message: "Profile image storage is not configured." });
      return;
    }

    const companion = await prisma.companion.findFirst({
      where: {
        id: String(req.params.id),
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: PartnerModerationStatus.ACTIVE,
      },
      select: {
        id: true,
        profileImageUrl: true,
        profileImageStoragePath: true,
        partnerApplications: latestApprovedSelfieSelect,
      },
    });

    if (!companion) {
      res.status(404).json({ error: "NOT_FOUND", message: "Partner not found." });
      return;
    }
    const customProfileImageUrl = sanitizePublicUrl(companion.profileImageUrl);
    if (customProfileImageUrl) {
      res.redirect(customProfileImageUrl);
      return;
    }

    const selfieFallback = companion.partnerApplications[0] ?? null;
    const storageObject = resolveKycStorageObject(
      companion.profileImageStoragePath ?? selfieFallback?.selfieStoragePath ?? null,
      selfieFallback?.selfieUrl ?? null,
    );
    if (!storageObject?.objectPath || !storageObject.objectPath.startsWith(KYC_STORAGE_PREFIX)) {
      res.status(404).json({ error: "NOT_FOUND", message: "Profile image not found." });
      return;
    }

    const bucket = storageObject.bucketName
      ? firebaseAdminStorage.bucket(storageObject.bucketName)
      : firebaseAdminStorage.bucket();
    const file = bucket.file(storageObject.objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "NOT_FOUND", message: "Profile image file not found." });
      return;
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || "image/jpeg";

    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");

    await new Promise<void>((resolve, reject) => {
      const stream = file.createReadStream();
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
  }),
);

companionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const companionId = String(req.params.id);
    try {
      const companion = await prisma.companion.findFirst({
        where: {
          id: companionId,
          status: CompanionStatus.ACTIVE,
          verificationStatus: VerificationStatus.VERIFIED,
          moderationStatus: PartnerModerationStatus.ACTIVE,
        },
        include: {
          partnerApplications: latestApprovedSelfieSelect,
          _count: {
            select: {
              sessions: true,
            },
          },
        },
      });
      if (!companion) {
        res.status(404).json({ error: "NOT_FOUND", message: "Partner not found." });
        return;
      }

      const staleThreshold = new Date(Date.now() - STALE_ACTIVE_SESSION_MS);
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
      const active = await prisma.session.findFirst({
        where: {
          companionId: companion.id,
          status: { in: ACTIVE_SESSION_STATUSES },
          endedAt: null,
          updatedAt: { gte: staleThreshold },
        },
        select: { id: true },
      });

      let latestProfile: {
        fullName: string;
        age: number;
        gender: string | null;
        categories: string[];
        languagesKnown: string[];
        servicesOffered: unknown[];
        communicationStyle: string[];
        hobbies: string[];
        aboutYourself: string | null;
        profileTagline: string | null;
        selfieStoragePath: string | null;
        selfieUrl: string | null;
      } | null = null;

      try {
        latestProfile = await prisma.partnerApplication.findFirst({
          where: {
            companionId: companion.id,
            status: {
              in: [PartnerApplicationStatus.APPROVED],
            },
          },
          orderBy: { createdAt: "desc" },
          select: {
            fullName: true,
            age: true,
            gender: true,
            categories: true,
            languagesKnown: true,
            servicesOffered: true,
            communicationStyle: true,
            hobbies: true,
            aboutYourself: true,
            profileTagline: true,
            selfieStoragePath: true,
            selfieUrl: true,
          },
        });
      } catch (error) {
        console.error("[companions.detail] failed to load public profile details", { companionId: companion.id, error });
      }

      let publicReviews: Array<{
        rating: number;
        comment: string;
        createdAt: Date;
        user: { phoneNumber: string };
      }> = [];
      let totalPublicReviewCount = 0;

      try {
        const [reviews, reviewCount] = await Promise.all([
          prisma.review.findMany({
            where: {
              companionId: companion.id,
              isApproved: true,
              isHidden: false,
            },
            include: {
              user: {
                select: {
                  phoneNumber: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 8,
          }),
          prisma.review.count({
            where: {
              companionId: companion.id,
              isApproved: true,
              isHidden: false,
            },
          }),
        ]);
        publicReviews = reviews;
        totalPublicReviewCount = reviewCount;
      } catch (error) {
        console.error("[companions.detail] failed to load public reviews", { companionId: companion.id, error });
      }

      const isBusy = Boolean(active);
      const { _count } = companion;
      const fallbackName = cleanText(companion.displayName);
      const headline = cleanText(companion.tagline) || cleanText(latestProfile?.profileTagline) || "";
      const bio = cleanText(latestProfile?.aboutYourself);
      const languages =
        normalizeStringArray(latestProfile?.languagesKnown).length > 0
          ? normalizeStringArray(latestProfile?.languagesKnown)
          : normalizeStringArray(companion.languages);
      const services =
        normalizeServiceArray(latestProfile?.servicesOffered).length > 0
          ? normalizeServiceArray(latestProfile?.servicesOffered)
          : normalizeServiceArray(companion.servicesOffered as unknown[]);
      const interests = Array.from(
        new Set(
          [
            ...normalizeStringArray(latestProfile?.categories),
            ...normalizeStringArray(latestProfile?.communicationStyle),
            ...normalizeStringArray(latestProfile?.hobbies),
          ]
            .map((value) => cleanText(value))
            .filter(Boolean),
        ),
      );
      const approvedSelfieFallback = {
        selfieStoragePath: latestProfile?.selfieStoragePath ?? null,
        selfieUrl: latestProfile?.selfieUrl ?? null,
      };
      const profileImageUrl = resolvePublicProfileImageUrl(req, companion, approvedSelfieFallback);
      const galleryUrls = sanitizePublicUrls(companion.galleryImageUrls);
      const city = cleanText(companion.city);
      const reviews = publicReviews
        .map((review) => ({
          rating: review.rating,
          comment: cleanText(review.comment),
          createdAt: review.createdAt,
          phoneMasked: maskPhone(review.user.phoneNumber),
        }))
        .filter((review) => review.comment.length > 0);

      const summary = toPublicCompanionSummary(
        req,
        {
          ...companion,
          languages,
          galleryImageUrls: galleryUrls,
          profileImageUrl,
        },
        approvedSelfieFallback,
        isBusy,
      );

      const publicProfile = {
        id: companion.id,
        displayName: fallbackName || cleanText(latestProfile?.fullName) || "Verified Partner",
        headline,
        bio,
        profileImageUrl,
        galleryUrls,
        services,
        interests,
        languages,
        city: city || null,
        serviceArea: city || null,
        verificationBadges: ["Profile Reviewed", "ID Verified", "Safety Checked", "Behaviour Reviewed"],
        rating: companion.rating,
        reviewCount: totalPublicReviewCount,
        completedSessions: _count.sessions,
        rates: {
          chat: CHAT_RATE_PER_MIN,
          audio: AUDIO_RATE_PER_MIN,
          video: VIDEO_RATE_PER_MIN,
          homeVisit: companion.homeVisitVerificationStatus === HomeVisitVerificationStatus.APPROVED ? HOME_VISIT_RATE_PER_HOUR : null,
        },
        reviews,
      };

      res.json({
        success: true,
        companion: {
          ...summary,
          displayName: publicProfile.displayName,
          name: publicProfile.displayName,
          headline: publicProfile.headline,
          tagline: publicProfile.headline,
          age: latestProfile?.age ?? null,
          gender: cleanText(latestProfile?.gender) || null,
          communicationStyle: normalizeStringArray(latestProfile?.communicationStyle),
          hobbies: normalizeStringArray(latestProfile?.hobbies),
          interests: publicProfile.interests,
          about: publicProfile.bio || null,
          bio: publicProfile.bio || null,
          services: publicProfile.services,
          serviceAreas: publicProfile.city ? [publicProfile.city] : [],
          city: publicProfile.city,
          languages: publicProfile.languages,
          sessions: _count.sessions,
          sessionsCompleted: _count.sessions,
          reviewsCount: totalPublicReviewCount,
          ratingCount: totalPublicReviewCount,
          reviews: publicProfile.reviews,
          verificationBadges: publicProfile.verificationBadges,
          profileImageUrl: publicProfile.profileImageUrl,
          galleryImageUrls: publicProfile.galleryUrls,
          galleryImages: publicProfile.galleryUrls,
          rates: publicProfile.rates,
          reviewCount: publicProfile.reviewCount,
          completedSessions: publicProfile.completedSessions,
          publicProfile,
        },
        publicProfile,
      });
    } catch (error) {
      console.error("[companions.detail] failed to load companion profile", { companionId, error });
      throw error;
    }
  }),
);

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "******";
  return `******${digits.slice(-4)}`;
}
