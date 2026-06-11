import type { NextFunction, Request, Response } from "express";
import { Role, UserModerationStatus } from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";
import { env } from "../config/env";
import { firebaseAdminAuth, isFirebaseAdminConfigured } from "../config/firebaseAdmin";
import { prisma } from "../db/prisma";

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing bearer token." });
    return;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid bearer token." });
    return;
  }

  if (!firebaseAdminAuth || !isFirebaseAdminConfigured()) {
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
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }

  if (decoded.aud !== env.FIREBASE_ADMIN_PROJECT_ID) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }

  const phoneNumber = decoded.phone_number;
  if (!phoneNumber) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Phone number not present in token." });
    return;
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const existingByUid = await tx.user.findUnique({
        where: { firebaseUid: decoded.uid },
      });
      if (existingByUid) {
        return tx.user.update({
          where: { id: existingByUid.id },
          data: { phoneNumber },
          include: { walletAccount: true },
        });
      }

      const existingByPhone = await tx.user.findUnique({
        where: { phoneNumber },
      });
      if (existingByPhone) {
        return tx.user.update({
          where: { id: existingByPhone.id },
          data: { firebaseUid: decoded.uid },
          include: { walletAccount: true },
        });
      }

      return tx.user.create({
        data: {
          firebaseUid: decoded.uid,
          phoneNumber,
          role: Role.USER,
          walletAccount: { create: {} },
        },
        include: { walletAccount: true },
      });
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
      phoneNumber: user.phoneNumber,
      role: user.role,
    };

    next();
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[auth] failed to resolve user from firebase token", error);
    }
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "Unable to verify user session." });
  }
};
