import { Router } from "express";
import {
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
import {
  AUDIO_RATE_PER_MIN,
  CHAT_RATE_PER_MIN,
  HOME_VISIT_RATE_PER_HOUR,
  VIDEO_RATE_PER_MIN,
} from "../config/platformPricing";

export const companionsRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];
const PARTNER_PRESENCE_STALE_MS = 90 * 1000;

function isPresenceFresh(companion: { isOnline: boolean; updatedAt: Date }) {
  if (!companion.isOnline) return false;
  return Date.now() - companion.updatedAt.getTime() <= PARTNER_PRESENCE_STALE_MS;
}

function toPublicCompanionSummary(
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
    isOnline: boolean;
    updatedAt: Date;
    profileImageUrl: string | null;
    galleryImageUrls: string[];
  },
  profileImageFallback: string | null | undefined,
  isBusy: boolean,
) {
  const effectiveOnline = isPresenceFresh(companion);
  const effectiveStatus = isBusy ? "BUSY" : effectiveOnline ? "ONLINE" : "OFFLINE";
  const profileImageUrl = companion.profileImageUrl ?? profileImageFallback ?? null;

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
  };
}

function isCompanionVisibleForListing(companion: {
  moderationStatus: PartnerModerationStatus;
  moderationExpiresAt: Date | null;
}) {
  const status = resolvePartnerModerationStatus(companion);
  return status !== PartnerModerationStatus.BANNED && status !== PartnerModerationStatus.TEMP_BANNED && status !== PartnerModerationStatus.HIDDEN;
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
      orderBy: [{ isOnline: "desc" }, { rating: "desc" }],
    });
    const visibleCompanions = companions.filter((companion) => isCompanionVisibleForListing(companion));

    const busySet = await getBusyCompanionIds(visibleCompanions.map((companion) => companion.id));
    const summaries = visibleCompanions.map((companion) => {
      const isBusy = busySet.has(companion.id);
      return toPublicCompanionSummary(companion, companion.profileImageUrl, isBusy);
    });
    res.json({
      companions: online ? summaries.filter((companion) => companion.effectiveStatus !== "OFFLINE") : summaries,
    });
  }),
);

companionsRouter.get(
  "/featured",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: { notIn: [PartnerModerationStatus.BANNED, PartnerModerationStatus.TEMP_BANNED, PartnerModerationStatus.HIDDEN] },
      },
      orderBy: [{ rating: "desc" }],
      take: 12,
    });
    const visibleCompanions = companions.filter((companion) => isCompanionVisibleForListing(companion));
    const busySet = await getBusyCompanionIds(visibleCompanions.map((companion) => companion.id));
    res.json({
      companions: visibleCompanions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        return toPublicCompanionSummary(companion, companion.profileImageUrl, isBusy);
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
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        moderationStatus: PartnerModerationStatus.ACTIVE,
        homeVisitVerificationStatus: HomeVisitVerificationStatus.APPROVED,
      },
      orderBy: [{ isOnline: "desc" }, { rating: "desc" }],
    });
    const busySet = await getBusyCompanionIds(companions.map((companion) => companion.id));
    res.json({
      companions: companions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        return toPublicCompanionSummary(companion, companion.profileImageUrl, isBusy);
      }),
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
      const profileImageUrl = sanitizePublicUrl(companion.profileImageUrl);
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
        {
          ...companion,
          languages,
          galleryImageUrls: galleryUrls,
          profileImageUrl,
        },
        profileImageUrl,
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
