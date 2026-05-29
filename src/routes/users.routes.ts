import { Router } from "express";
import { SessionStatus } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode } from "../utils/http";

const profileSchema = z.object({
  name: z.string().min(2).optional(),
});

const SAFE_PROFILE_IMAGE_HOSTS = new Set([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]);

function isSafeProfileImageUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && SAFE_PROFILE_IMAGE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const profileDetailsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().min(1).email().max(180),
  age: z.coerce.number().int().min(18).max(120),
  gender: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().max(40).optional()),
  profileImageUrl: z
    .string()
    .trim()
    .min(1)
    .url()
    .max(500)
    .refine((value) => isSafeProfileImageUrl(value), {
      message: "Profile image must be a secure supported storage URL.",
    }),
});

const supportSchema = z.object({
  subject: z.string().min(3),
  type: z.string().min(2),
  message: z.string().min(10),
  priority: z.string().optional(),
});

const reviewSchema = z.object({
  companionId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3),
});

export const usersRouter = Router();

function isUserProfileComplete(user: {
  name: string | null;
  email: string | null;
  age: number | null;
  profileImageUrl: string | null;
}) {
  const hasName = Boolean(user.name && user.name.trim().length >= 2);
  const hasEmail = Boolean(user.email && z.string().email().safeParse(user.email).success);
  const hasAge = typeof user.age === "number" && user.age >= 18;
  const hasSafeProfileImage = Boolean(
    user.profileImageUrl && isSafeProfileImageUrl(user.profileImageUrl),
  );
  return hasName && hasEmail && hasAge && hasSafeProfileImage;
}

usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: {
        walletAccount: true,
      },
    });
    res.json({ user, profileComplete: user ? isUserProfileComplete(user) : false });
  }),
);

usersRouter.get(
  "/me/profile-summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        firebaseUid: true,
        phoneNumber: true,
        name: true,
        email: true,
        age: true,
        gender: true,
        profileImageUrl: true,
        onboardingCompletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "USER_NOT_FOUND", message: "User not found." });
      return;
    }

    const [activeConversations, totalSessions, completedSessions] = await Promise.all([
      prisma.session.count({
        where: {
          userId: authUser.id,
          status: SessionStatus.LIVE,
          endedAt: null,
        },
      }),
      prisma.session.count({
        where: { userId: authUser.id },
      }),
      prisma.session.count({
        where: {
          userId: authUser.id,
          status: { in: [SessionStatus.ENDED, SessionStatus.COMPLETED] },
        },
      }),
    ]);

    const profileComplete = isUserProfileComplete(user);
    res.json({
      user: {
        ...user,
        verificationStatus: profileComplete ? "VERIFIED" : "PENDING_PROFILE",
      },
      profileComplete,
      stats: {
        activeConversations,
        totalSessions,
        completedSessions,
        memberSince: user.createdAt,
        lastLogin: null,
      },
    });
  }),
);

usersRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
      },
    });
    res.json({ user });
  }),
);

usersRouter.patch(
  "/me/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = profileDetailsSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: {
        name: body.name,
        email: body.email,
        age: body.age,
        gender: body.gender ?? null,
        profileImageUrl: body.profileImageUrl,
        onboardingCompletedAt: new Date(),
      },
      include: {
        walletAccount: true,
      },
    });
    res.json({ user, profileComplete: isUserProfileComplete(user) });
  }),
);

usersRouter.post(
  "/support",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = supportSchema.parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: {
        ticketCode: createCode("TKT"),
        userId: authUser.id,
        subject: body.subject,
        type: body.type,
        message: body.message,
        priority: body.priority ?? "MEDIUM",
      },
    });
    res.status(201).json({ ticket });
  }),
);

usersRouter.post(
  "/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = reviewSchema.parse(req.body);
    const review = await prisma.review.create({
      data: {
        userId: authUser.id,
        companionId: body.companionId,
        rating: body.rating,
        comment: body.comment,
      },
    });
    res.status(201).json({ review });
  }),
);
