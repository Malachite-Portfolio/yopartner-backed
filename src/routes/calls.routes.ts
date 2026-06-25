import { ServiceType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/http";
import { generateCallProviderToken, selectedCallProvider } from "../services/callProvider";

const tokenRequestSchema = z.object({
  callSessionId: z.string().min(1),
});

export const callsRouter = Router();

function sanitizeZegoId(value: string, prefix: string) {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 64);
  return sanitized || prefix;
}

callsRouter.post(
  "/zego-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const { callSessionId } = tokenRequestSchema.parse(req.body ?? {});
    const session = await prisma.session.findFirst({
      where: {
        id: callSessionId,
        OR: [{ userId: authUser.id }, { companion: { is: { userId: authUser.id } } }],
      },
      include: { user: true, companion: true },
    });
    if (!session) throw new HttpError(404, "Call session not found.");
    if (session.serviceType === ServiceType.CHAT) {
      throw new HttpError(400, "ZEGOCLOUD token is only available for audio/video sessions.");
    }

    const requesterRole = authUser.id === session.userId ? "user" : "host";
    const roomId = sanitizeZegoId(session.id, "call_room");
    const userId = sanitizeZegoId(`${requesterRole}_${authUser.id}`, `${requesterRole}_participant`);
    const userName =
      requesterRole === "user"
        ? session.user.name || "YoPartner User"
        : session.companion.displayName || "YoPartner Host";

    console.info("[call-provider] token requested", {
      provider: selectedCallProvider(),
      callSessionId: session.id,
      roomId,
      requesterRole,
    });

    try {
      const generated = generateCallProviderToken({ roomId, userId });
      console.info("[call-provider] token generated", {
        provider: selectedCallProvider(),
        callSessionId: session.id,
        roomId,
        requesterRole,
        success: true,
      });
      res.json({
        appId: env.ZEGO_APP_ID,
        roomId,
        callID: roomId,
        userId,
        userName,
        token: generated.token,
        expiresAt: generated.expiresAt,
      });
    } catch (error) {
      console.error("[call-provider] token generation failed", {
        provider: selectedCallProvider(),
        callSessionId: session.id,
        roomId,
        requesterRole,
        success: false,
        message: error instanceof Error ? error.message : "Unknown token generation error",
      });
      throw new HttpError(503, "ZEGOCLOUD calling is not configured.");
    }
  }),
);
