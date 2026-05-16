import type { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { env } from "../config/env";
import { firebaseAdminAuth } from "../config/firebaseAdmin";
import { prisma } from "../db/prisma";
import { verifyAdminJwt } from "../utils/adminJwt";

const uidAllowlist = (env.ADMIN_UID_ALLOWLIST ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const phoneAllowlist = (env.ADMIN_PHONE_ALLOWLIST ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export const requireAdminAccess = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing bearer token." });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid bearer token." });
    return;
  }

  try {
    const payload = verifyAdminJwt(token);
    req.authUser = {
      id: `admin:${payload.loginId}`,
      firebaseUid: `admin:${payload.loginId}`,
      phoneNumber: payload.loginId,
      role: Role.ADMIN,
      authType: "admin_jwt",
      adminLoginId: payload.loginId,
    };
    next();
    return;
  } catch {
    // Ignore and continue to Firebase flow.
  }

  try {
    const decoded = await firebaseAdminAuth.verifyIdToken(token);
    const phoneNumber = decoded.phone_number;
    if (!phoneNumber) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Phone number not present in token." });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
    });

    const user =
      existingUser ??
      (await prisma.user.create({
        data: {
          firebaseUid: decoded.uid,
          phoneNumber,
          role: Role.USER,
          walletAccount: { create: {} },
        },
      }));

    let effectiveRole = user.role;
    if (
      user.role !== Role.ADMIN &&
      (uidAllowlist.includes(decoded.uid) || phoneAllowlist.includes(phoneNumber))
    ) {
      await prisma.user.update({
        where: { id: user.id },
        data: { role: Role.ADMIN },
      });
      effectiveRole = Role.ADMIN;
    }

    if (effectiveRole !== Role.ADMIN) {
      res.status(403).json({ error: "FORBIDDEN", message: "Access denied." });
      return;
    }

    req.authUser = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      phoneNumber: user.phoneNumber,
      role: effectiveRole,
      authType: "firebase",
    };

    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
  }
};
