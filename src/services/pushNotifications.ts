import webpush, { WebPushError } from "web-push";
import { ServiceType } from "@prisma/client";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { firebaseAdminMessaging } from "../config/firebaseAdmin";

type PushSession = {
  id: string;
  companionId: string;
  serviceType: ServiceType;
  callerLabel?: string | null;
};

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type StoredFcmToken = {
  id: string;
  token: string;
};

let vapidConfigured = false;
let warnedMissingFirebaseMessaging = false;

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

function notificationChannel(serviceType: ServiceType) {
  if (serviceType === ServiceType.AUDIO || serviceType === ServiceType.VIDEO) return "incoming-calls";
  return "chat-messages";
}

function notificationUrl(serviceType: ServiceType, sessionId: string) {
  if (serviceType === ServiceType.AUDIO) return `/partner/audio-call/${sessionId}`;
  if (serviceType === ServiceType.VIDEO) return `/partner/video-call/${sessionId}`;
  return `/partner/chat/${sessionId}`;
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

function isDeadFcmTokenError(code: string | undefined) {
  return code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token";
}

function safePushError(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: error instanceof Error ? error.message : String(error || "Unknown push error") };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    message: typeof candidate.message === "string" ? candidate.message : "Push request failed",
  };
}

function messagePreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

async function sendNativeFcmToPartnerTokens(params: {
  companionId: string;
  title: string;
  body: string;
  channel: string;
  data: Record<string, string>;
}) {
  if (!firebaseAdminMessaging) {
    if (!warnedMissingFirebaseMessaging) {
      warnedMissingFirebaseMessaging = true;
      console.warn("[push] Firebase Admin messaging is not configured; native push skipped");
    }
    return;
  }

  const tokens = await prisma.fcmDeviceToken.findMany({
    where: {
      companionId: params.companionId,
      revokedAt: null,
      platform: "android",
    },
    select: {
      id: true,
      token: true,
    },
  });
  if (tokens.length === 0) {
    console.info("[push] no active native tokens", {
      companionId: params.companionId,
      channel: params.channel,
    });
    return;
  }

  const chunkSize = 500;
  for (let start = 0; start < tokens.length; start += chunkSize) {
    const chunk: StoredFcmToken[] = tokens.slice(start, start + chunkSize);
    const response = await firebaseAdminMessaging.sendEachForMulticast({
      tokens: chunk.map((item) => item.token),
      data: {
        ...params.data,
        title: params.title,
        body: params.body,
        channel: params.channel,
      },
      android: {
        priority: "high",
      },
    });
    if (response.successCount > 0) {
      console.info("[push] FCM notification sent", {
        companionId: params.companionId,
        channel: params.channel,
        successCount: response.successCount,
        failureCount: response.failureCount,
      });
    }

    await Promise.all(
      response.responses.map(async (result, index) => {
        if (result.success) return;
        const token = chunk[index];
        const errorCode = result.error?.code;
        if (isDeadFcmTokenError(errorCode)) {
          await prisma.fcmDeviceToken.updateMany({
            where: { id: token.id },
            data: { revokedAt: new Date() },
          });
          return;
        }
        console.error("[push] FCM notification failed", {
          tokenId: token.id,
          companionId: params.companionId,
          errorCode,
          error: safePushError(result.error),
        });
      }),
    );
  }
}

export async function sendIncomingRequestPush(session: PushSession) {
  const title = notificationTitle(session.serviceType);
  const channel = notificationChannel(session.serviceType);
  const url = notificationUrl(session.serviceType, session.id);
  const body = session.callerLabel?.trim() || "A member is calling";

  void sendNativeFcmToPartnerTokens({
    companionId: session.companionId,
    title,
    body,
    channel,
    data: {
      type: "PARTNER_INCOMING_REQUEST",
      requestId: session.id,
      sessionId: session.id,
      callId: session.id,
      serviceType: session.serviceType,
      url,
    },
  }).catch((error) => {
    console.error("[push] incoming request FCM dispatch failed", {
      sessionId: session.id,
      companionId: session.companionId,
      error: safePushError(error),
    });
  });

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
    title,
    body,
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

export async function sendPartnerChatMessagePush(params: {
  sessionId: string;
  companionId: string;
  messageId: string;
  messageBody: string;
  senderLabel?: string | null;
}) {
  const preview = messagePreview(params.messageBody) || "New message";
  await sendNativeFcmToPartnerTokens({
    companionId: params.companionId,
    title: params.senderLabel?.trim() || "New message",
    body: preview,
    channel: "chat-messages",
    data: {
      type: "PARTNER_CHAT_MESSAGE",
      sessionId: params.sessionId,
      messageId: params.messageId,
      serviceType: ServiceType.CHAT,
      url: `/partner/chat/${params.sessionId}`,
    },
  });
}
