import { Router } from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { requireRole } from "../middlewares/roles";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { HttpError } from "../utils/http";
import { assertPartnerDashboardAccess } from "../utils/moderation";
import { env } from "../config/env";
import { isWebPushConfigured, isWebPushEnabled } from "../services/pushNotifications";

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  userAgent: z.string().max(500).optional(),
});

const deletePushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).optional(),
});

const fcmTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.literal("android").default("android"),
  appPackage: z.string().trim().max(120).optional(),
  appVersion: z.string().trim().max(80).optional(),
});

const deleteFcmTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
});

export const notificationsRouter = Router();

notificationsRouter.get(
  "/status",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);

    const activeSubscriptions = await prisma.pushSubscription.count({
      where: {
        userId: authUser.id,
        revokedAt: null,
      },
    });
    const activeFcmTokens = await prisma.fcmDeviceToken.count({
      where: {
        userId: authUser.id,
        revokedAt: null,
      },
    });

    res.json({
      enabled: isWebPushEnabled(),
      configured: isWebPushConfigured(),
      publicKey: env.VAPID_PUBLIC_KEY || null,
      activeSubscriptions,
      activeFcmTokens,
    });
  }),
);

notificationsRouter.post(
  "/push-subscriptions",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    if (!isWebPushConfigured()) {
      throw new HttpError(503, "Web push notifications are not configured.");
    }

    const authUser = req.authUser!;
    const payload = pushSubscriptionSchema.parse(req.body);
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const userAgent =
      payload.userAgent?.trim() ||
      (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);

    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint: payload.endpoint },
      create: {
        userId: authUser.id,
        companionId: companion.id,
        endpoint: payload.endpoint,
        p256dh: payload.keys.p256dh,
        auth: payload.keys.auth,
        userAgent,
      },
      update: {
        userId: authUser.id,
        companionId: companion.id,
        p256dh: payload.keys.p256dh,
        auth: payload.keys.auth,
        userAgent,
        revokedAt: null,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json({
      subscription,
      message: "Push notifications enabled.",
    });
  }),
);

notificationsRouter.post(
  "/fcm-tokens",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = fcmTokenSchema.parse(req.body);
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);
    if (!companion) {
      throw new HttpError(404, "Partner profile not found.");
    }

    const token = await prisma.fcmDeviceToken.upsert({
      where: { token: payload.token },
      create: {
        userId: authUser.id,
        companionId: companion.id,
        token: payload.token,
        platform: payload.platform,
        appPackage: payload.appPackage,
        appVersion: payload.appVersion,
      },
      update: {
        userId: authUser.id,
        companionId: companion.id,
        platform: payload.platform,
        appPackage: payload.appPackage,
        appVersion: payload.appVersion,
        revokedAt: null,
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json({
      token,
      message: "App notifications are active on this device.",
    });
  }),
);

notificationsRouter.delete(
  "/fcm-tokens",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = deleteFcmTokenSchema.parse(req.body ?? {});
    const revoked = await prisma.fcmDeviceToken.updateMany({
      where: {
        userId: authUser.id,
        token: payload.token,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    res.json({
      revoked: revoked.count,
      message: "App notifications disabled on this device.",
    });
  }),
);

notificationsRouter.delete(
  "/push-subscriptions",
  requireAuth,
  requireRole([Role.PARTNER]),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const payload = deletePushSubscriptionSchema.parse(req.body ?? {});
    const companion = await prisma.companion.findFirst({ where: { userId: authUser.id } });
    assertPartnerDashboardAccess(companion);

    const revoked = await prisma.pushSubscription.updateMany({
      where: {
        userId: authUser.id,
        revokedAt: null,
        ...(payload.endpoint ? { endpoint: payload.endpoint } : {}),
      },
      data: {
        revokedAt: new Date(),
      },
    });

    res.json({
      revoked: revoked.count,
      message: "Push notifications disabled.",
    });
  }),
);
