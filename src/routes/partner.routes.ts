import { Router } from "express";
import { CompanionStatus, Role, ServiceType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { requireRole } from "../middlewares/roles";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { HttpError } from "../utils/http";

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
  chatPrice: z.number().int().nonnegative(),
  audioPrice: z.number().int().nonnegative(),
  videoPrice: z.number().int().nonnegative(),
  categories: z.array(z.string()).min(1),
  safetyChecklist: z.array(z.string()).min(4),
});

const toServiceType = (value: string): ServiceType | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat") return ServiceType.CHAT;
  if (normalized === "audio" || normalized === "audio call") return ServiceType.AUDIO;
  if (normalized === "video" || normalized === "video call") return ServiceType.VIDEO;
  return null;
};

export const partnerRouter = Router();

partnerRouter.post(
  "/applications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = onboardingSchema.parse(req.body);
    const servicesOffered = payload.servicesOffered.map(toServiceType).filter((value): value is ServiceType => value !== null);
    if (servicesOffered.length === 0) {
      throw new HttpError(400, "At least one valid service is required.");
    }

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
        chatPrice: payload.chatPrice,
        audioPrice: payload.audioPrice,
        videoPrice: payload.videoPrice,
        categories: payload.categories,
        safetyChecklist: payload.safetyChecklist,
      },
    });

    await prisma.user.update({
      where: { id: authUser.id },
      data: { role: Role.PARTNER, name: payload.fullName },
    });

    res.status(201).json({ application });
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
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });

    if (!companion || companion.status !== CompanionStatus.ACTIVE) {
      res.json({
        status: "UNDER_REVIEW",
        message: "Your dashboard will appear after your account is approved.",
      });
      return;
    }

    const [bookingsCount, sessionsCount, openSessions] = await Promise.all([
      prisma.booking.count({ where: { companionId: companion.id } }),
      prisma.session.count({ where: { companionId: companion.id } }),
      prisma.session.count({ where: { companionId: companion.id, status: "LIVE" } }),
    ]);

    res.json({
      companion,
      stats: {
        bookingsCount,
        sessionsCount,
        openSessions,
      },
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
    res.json({ companion });
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
    if (!companion) {
      throw new HttpError(404, "Companion profile not found.");
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
  "/bookings",
  requireAuth,
  requireRole([Role.PARTNER, Role.ADMIN]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
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
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    if (!companion) {
      res.json({ payouts: [] });
      return;
    }
    const payouts = await prisma.payout.findMany({
      where: { companionId: companion.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ payouts });
  }),
);
