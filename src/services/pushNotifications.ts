import webpush, { WebPushError } from "web-push";
import { ServiceType } from "@prisma/client";
import { prisma } from "../db/prisma";
import { env } from "../config/env";

type PushSession = {
  id: string;
  companionId: string;
  serviceType: ServiceType;
};

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let vapidConfigured = false;

export function isWebPushEnabled() {
  return env.ENABLE_WEB_PUSH_NOTIFICATIONS === "true";
}

export function isWebPushConfigured() {
  return Boolean(isWebPushEnabled() && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function configureVapid() {
  if (vapidConfigured || !isWebPushConfigured()) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

function notificationTitle(serviceType: ServiceType) {
  if (serviceType === ServiceType.AUDIO) return "Incoming audio call";
  if (serviceType === ServiceType.VIDEO) return "Incoming video call";
  return "Incoming chat request";
}

function toWebPushSubscription(subscription: StoredSubscription) {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };
}

function isDeadSubscriptionError(error: unknown) {
  if (error instanceof WebPushError) {
    return error.statusCode === 404 || error.statusCode === 410;
  }
  const statusCode = typeof error === "object" && error && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : 0;
  return statusCode === 404 || statusCode === 410;
}

export async function sendIncomingRequestPush(session: PushSession) {
  if (!isWebPushConfigured()) return;
  configureVapid();

  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      companionId: session.companionId,
      revokedAt: null,
    },
    select: {
      id: true,
      endpoint: true,
      p256dh: true,
      auth: true,
    },
  });
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    type: "PARTNER_INCOMING_REQUEST",
    requestId: session.id,
    title: notificationTitle(session.serviceType),
    body: "Tap to open YoPartner dashboard",
    url: "/partner/dashboard",
    tag: `yopartner-request-${session.id}`,
  });

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(subscription), payload);
      } catch (error) {
        if (isDeadSubscriptionError(error)) {
          await prisma.pushSubscription.updateMany({
            where: { id: subscription.id },
            data: { revokedAt: new Date() },
          });
          return;
        }
        console.error("[push] incoming request notification failed", {
          subscriptionId: subscription.id,
          sessionId: session.id,
          error,
        });
      }
    }),
  );
}
