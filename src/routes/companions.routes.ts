import { Router } from "express";
import { CompanionStatus, SessionStatus } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";

export const companionsRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];

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
        const { partnerApplications, ...companionData } = companion;
        const isBusy = busySet.has(companion.id);
        const effectiveStatus = !companion.isOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
        const resolvedProfileImageUrl = companion.profileImageUrl ?? partnerApplications[0]?.selfieUrl ?? null;
        return {
          ...companionData,
          image: resolvedProfileImageUrl,
          galleryImages: companionData.galleryImageUrls,
          resolvedProfileImageUrl,
          isBusy,
          effectiveStatus,
        };
      }),
    });
  }),
);

companionsRouter.get(
  "/featured",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: { status: CompanionStatus.ACTIVE },
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
        const { partnerApplications, ...companionData } = companion;
        const isBusy = busySet.has(companion.id);
        const effectiveStatus = !companion.isOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
        const resolvedProfileImageUrl = companion.profileImageUrl ?? partnerApplications[0]?.selfieUrl ?? null;
        return {
          ...companionData,
          image: resolvedProfileImageUrl,
          galleryImages: companionData.galleryImageUrls,
          resolvedProfileImageUrl,
          isBusy,
          effectiveStatus,
        };
      }),
    });
  }),
);

companionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const companion = await prisma.companion.findUnique({
      where: { id: String(req.params.id) },
      include: {
        partnerApplications: {
          where: { selfieUrl: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { selfieUrl: true },
        },
      },
    });
    if (!companion || companion.status !== CompanionStatus.ACTIVE) {
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
    const effectiveStatus = !companion.isOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
    const { partnerApplications, ...companionData } = companion;
    const resolvedProfileImageUrl = companionData.profileImageUrl ?? partnerApplications[0]?.selfieUrl ?? null;
    res.json({
      companion: {
        ...companionData,
        image: resolvedProfileImageUrl,
        galleryImages: companionData.galleryImageUrls,
        resolvedProfileImageUrl,
        isBusy,
        effectiveStatus,
      },
    });
  }),
);
