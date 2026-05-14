import type { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/prisma";

const uidAllowlist = (env.ADMIN_UID_ALLOWLIST ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const phoneAllowlist = (env.ADMIN_PHONE_ALLOWLIST ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export const requireRole = (roles: Role[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Not authenticated." });
      return;
    }

    if (
      authUser.role !== Role.ADMIN &&
      (uidAllowlist.includes(authUser.firebaseUid) || phoneAllowlist.includes(authUser.phoneNumber))
    ) {
      await prisma.user.update({
        where: { id: authUser.id },
        data: { role: Role.ADMIN },
      });
      authUser.role = Role.ADMIN;
    }

    if (!roles.includes(authUser.role)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Access denied." });
      return;
    }

    next();
  };
};
