import { Router } from "express";
import {
  CompanionStatus,
  PartnerApplicationStatus,
  SessionStatus,
  VerificationStatus,
} from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";

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
  const effectiveStatus = !effectiveOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
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
    chatPrice: companion.chatPrice,
    audioPrice: companion.audioPrice,
    videoPrice: companion.videoPrice,
    chatRate: companion.chatPrice,
    audioRate: companion.audioPrice,
    videoRate: companion.videoPrice,
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
        ...(online ? { isOnline: true } : {}),
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
      include: {
        partnerApplications: {
          where: { selfieUrl: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { selfieUrl: true },
        },
      },
    });

    const busySet = await getBusyCompanionIds(companions.map((companion) => companion.id));
    res.json({
      companions: companions.map((companion) => {
        const { partnerApplications } = companion;
        const isBusy = busySet.has(companion.id);
        const resolvedProfileImageUrl = companion.profileImageUrl ?? partnerApplications[0]?.selfieUrl ?? null;
        return toPublicCompanionSummary(companion, resolvedProfileImageUrl, isBusy);
      }),
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
      },
      orderBy: [{ rating: "desc" }],
      take: 12,
      include: {
        partnerApplications: {
          where: { selfieUrl: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { selfieUrl: true },
        },
      },
    });
    const busySet = await getBusyCompanionIds(companions.map((companion) => companion.id));
    res.json({
      companions: companions.map((companion) => {
        const { partnerApplications } = companion;
        const isBusy = busySet.has(companion.id);
        const resolvedProfileImageUrl = companion.profileImageUrl ?? partnerApplications[0]?.selfieUrl ?? null;
        return toPublicCompanionSummary(companion, resolvedProfileImageUrl, isBusy);
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
      },
    });

    res.json({ totalActiveCompanions });
  }),
);

companionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const companion = await prisma.companion.findFirst({
      where: {
        id: String(req.params.id),
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
      },
      include: {
        partnerApplications: {
          where: {
            status: {
              in: [PartnerApplicationStatus.APPROVED],
            },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            age: true,
            gender: true,
            religion: true,
            bornCity: true,
            nationality: true,
            school: true,
            college: true,
            qualification: true,
            communicationStyle: true,
            hobbies: true,
            aboutYourself: true,
            profileTagline: true,
            selfieUrl: true,
          },
        },
        reviews: {
          where: {
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
        },
        _count: {
          select: {
            sessions: true,
            reviews: true,
          },
        },
      },
    });
    if (!companion) {
      res.status(404).json({ error: "NOT_FOUND", message: "Companion not found." });
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
    const isBusy = Boolean(active);
    const { partnerApplications, reviews, _count } = companion;
    const latestProfile = partnerApplications[0];
    const summary = toPublicCompanionSummary(companion, latestProfile?.selfieUrl ?? null, isBusy);
    res.json({
      companion: {
        ...summary,
        headline: companion.tagline ?? latestProfile?.profileTagline ?? "",
        tagline: companion.tagline ?? latestProfile?.profileTagline ?? "",
        age: latestProfile?.age ?? null,
        gender: latestProfile?.gender ?? null,
        religion: latestProfile?.religion ?? null,
        bornCity: latestProfile?.bornCity ?? companion.city ?? null,
        nationality: latestProfile?.nationality ?? null,
        school: latestProfile?.school ?? null,
        college: latestProfile?.college ?? null,
        qualification: latestProfile?.qualification ?? null,
        communicationStyle: latestProfile?.communicationStyle ?? [],
        hobbies: latestProfile?.hobbies ?? [],
        interests: latestProfile?.hobbies ?? [],
        about: latestProfile?.aboutYourself ?? null,
        bio: latestProfile?.aboutYourself ?? null,
        serviceAreas: companion.city ? [companion.city] : [],
        sessions: _count.sessions,
        sessionsCompleted: _count.sessions,
        reviewsCount: _count.reviews,
        ratingCount: _count.reviews,
        reviews: reviews.map((review) => ({
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt,
          phoneMasked: maskPhone(review.user.phoneNumber),
        })),
      },
    });
  }),
);

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "******";
  return `******${digits.slice(-4)}`;
}
