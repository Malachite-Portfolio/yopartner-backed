import type { NextFunction, Request, Response } from "express";
import { Role, UserModerationStatus } from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";
import { env } from "../config/env";
import { firebaseAdminAuth, isFirebaseAdminConfigured } from "../config/firebaseAdmin";
import { prisma } from "../db/prisma";

function isPartnerApplicationSubmit(req: Request) {
  return req.method === "POST" && req.baseUrl === "/api/partner" && req.path === "/applications";
}

function logPartnerSubmitAuth(req: Request, message: string, meta: Record<string, unknown>) {
  if (!isPartnerApplicationSubmit(req)) return;
  console.info(`[auth] partner submit ${message}`, meta);
}

function logPartnerSubmitAuthWarning(req: Request, message: string, meta: Record<string, unknown>) {
  if (!isPartnerApplicationSubmit(req)) return;
  console.info(`[auth] partner submit ${message}`, meta);
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logPartnerSubmitAuthWarning(req, "missing bearer token", {
      authHeaderPresent: Boolean(authHeader),
      tokenType: "missing",
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing bearer token." });
    return;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    logPartnerSubmitAuthWarning(req, "empty bearer token", {
      authHeaderPresent: true,
      tokenType: "unknown",
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid bearer token." });
    return;
  }

  if (!firebaseAdminAuth || !isFirebaseAdminConfigured()) {
    logPartnerSubmitAuthWarning(req, "firebase admin unavailable", {
      authHeaderPresent: true,
      tokenType: "unknown",
      firebaseAdminConfigured: isFirebaseAdminConfigured(),
    });
    res.status(503).json({ error: "SERVICE_UNAVAILABLE", message: "Firebase admin not configured." });
    return;
  }

  let decoded: DecodedIdToken;
  try {
    decoded = await firebaseAdminAuth.verifyIdToken(idToken);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code ?? "") : "";
    if (code === "auth/project-not-found") {
      res.status(503).json({ error: "SERVICE_UNAVAILABLE", message: "Firebase admin not configured." });
      return;
    }
    logPartnerSubmitAuthWarning(req, "firebase token rejected", {
      authHeaderPresent: true,
      tokenType: "firebase",
      code: code || "unknown",
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }

  if (decoded.aud !== env.FIREBASE_ADMIN_PROJECT_ID) {
    logPartnerSubmitAuthWarning(req, "firebase token audience mismatch", {
      authHeaderPresent: true,
      tokenType: "firebase",
      firebaseUid: decoded.uid,
      tokenAudience: decoded.aud,
      expectedAudience: env.FIREBASE_ADMIN_PROJECT_ID,
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }

  const phoneNumber = decoded.phone_number;
  if (!phoneNumber) {
    logPartnerSubmitAuthWarning(req, "firebase token missing phone", {
      authHeaderPresent: true,
      tokenType: "firebase",
      firebaseUid: decoded.uid,
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Phone number not present in token." });
    return;
  }

  try {
    logPartnerSubmitAuth(req, "firebase token verified", {
      authHeaderPresent: true,
      tokenType: "firebase",
      firebaseUid: decoded.uid,
      phonePresent: true,
    });

    const { user, sessionPhoneNumber } = await prisma.$transaction(async (tx) => {
      const existingByUid = await tx.user.findUnique({
        where: { firebaseUid: decoded.uid },
        include: { walletAccount: true },
      });
      const existingByPhone = await tx.user.findUnique({
        where: { phoneNumber },
        include: { walletAccount: true },
      });

      if (existingByUid && existingByPhone && existingByUid.id !== existingByPhone.id) {
        logPartnerSubmitAuthWarning(req, "uid phone account conflict", {
          authHeaderPresent: true,
          tokenType: "firebase",
          firebaseUid: decoded.uid,
          uidUserId: existingByUid.id,
          phoneUserId: existingByPhone.id,
          resolvedUserId: existingByUid.id,
        });
        return { user: existingByUid, sessionPhoneNumber: phoneNumber };
      }

      if (existingByUid) {
        const user =
          existingByUid.phoneNumber === phoneNumber
            ? existingByUid
            : await tx.user.update({
                where: { id: existingByUid.id },
                data: { phoneNumber },
                include: { walletAccount: true },
              });
        return { user, sessionPhoneNumber: phoneNumber };
      }

      if (existingByPhone) {
        const user =
          existingByPhone.firebaseUid === decoded.uid
            ? existingByPhone
            : await tx.user.update({
                where: { id: existingByPhone.id },
                data: { firebaseUid: decoded.uid },
                include: { walletAccount: true },
              });
        return { user, sessionPhoneNumber: phoneNumber };
      }

      const user = await tx.user.create({
        data: {
          firebaseUid: decoded.uid,
          phoneNumber,
          role: Role.USER,
          walletAccount: { create: {} },
        },
        include: { walletAccount: true },
      });
      return { user, sessionPhoneNumber: phoneNumber };
    });

    if (!user.walletAccount) {
      await prisma.walletAccount.create({
        data: { userId: user.id },
      });
    }

    if (user.isBlocked && user.moderationStatus === UserModerationStatus.BANNED) {
      res.status(403).json({ error: "ACCOUNT_REMOVED", message: "This account has been removed from active platform access." });
      return;
    }

    req.authUser = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      phoneNumber: sessionPhoneNumber,
      role: user.role,
    };

    logPartnerSubmitAuth(req, "resolved user", {
      authHeaderPresent: true,
      tokenType: "firebase",
      firebaseUid: decoded.uid,
      partnerUserId: user.id,
    });

    next();
  } catch (error) {
    logPartnerSubmitAuthWarning(req, "user resolution failed", {
      authHeaderPresent: true,
      tokenType: "firebase",
      firebaseUid: decoded.uid,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown auth resolution error",
    });
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "Could not resolve your login account. Please login again." });
  }
};
