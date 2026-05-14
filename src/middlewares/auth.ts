import type { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { firebaseAdminAuth } from "../config/firebaseAdmin";
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

  try {
    const decoded = await firebaseAdminAuth.verifyIdToken(idToken);
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

    req.authUser = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      phoneNumber: user.phoneNumber,
      role: user.role,
    };

    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
  }
};
