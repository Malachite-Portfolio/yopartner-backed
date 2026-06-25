import { Router } from "express";
import { RtcRole, RtcTokenBuilder, RtmTokenBuilder } from "agora-token";
import { z } from "zod";
import { env } from "../config/env";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/http";

const rtcTokenSchema = z.object({
  channelName: z.string().min(1),
  uid: z.number().int().nonnegative(),
  expiresInSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
});

const chatTokenSchema = z.object({
  account: z.string().min(1),
  expiresInSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
});

export const agoraRouter = Router();

agoraRouter.post(
  "/token/rtc",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (env.CALL_PROVIDER !== "agora") {
      throw new HttpError(410, "Agora RTC is disabled. Use the configured call provider.");
    }
    if (!env.NEXT_PUBLIC_AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
      throw new HttpError(503, "Agora RTC config is missing.");
    }
    const body = rtcTokenSchema.parse(req.body);
    const ttl = body.expiresInSeconds ?? 3600;
    const expireAt = Math.floor(Date.now() / 1000) + ttl;
    const token = RtcTokenBuilder.buildTokenWithUid(
      env.NEXT_PUBLIC_AGORA_APP_ID,
      env.AGORA_APP_CERTIFICATE,
      body.channelName,
      body.uid,
      RtcRole.PUBLISHER,
      expireAt,
      expireAt,
    );
    res.json({
      token,
      appId: env.NEXT_PUBLIC_AGORA_APP_ID,
      channelName: body.channelName,
      uid: body.uid,
      expiresAt: expireAt,
    });
  }),
);

agoraRouter.post(
  "/token/chat",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.NEXT_PUBLIC_AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
      throw new HttpError(503, "Agora Chat config is missing.");
    }
    const body = chatTokenSchema.parse(req.body);
    const ttl = body.expiresInSeconds ?? 3600;
    const expireAt = Math.floor(Date.now() / 1000) + ttl;
    const token = RtmTokenBuilder.buildToken(
      env.NEXT_PUBLIC_AGORA_APP_ID,
      env.AGORA_APP_CERTIFICATE,
      body.account,
      expireAt,
    );
    res.json({
      token,
      account: body.account,
      appKey: env.AGORA_CHAT_APP_KEY ?? "",
      orgName: env.AGORA_CHAT_ORG_NAME ?? "",
      appName: env.AGORA_CHAT_APP_NAME ?? "",
      expiresAt: expireAt,
    });
  }),
);
