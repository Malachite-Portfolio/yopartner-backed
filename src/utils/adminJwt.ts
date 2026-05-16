import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type AdminJwtPayload = {
  role: "ADMIN";
  loginId: string;
};

export function areAdminCredentialsConfigured() {
  return Boolean(env.ADMIN_LOGIN_ID && env.ADMIN_LOGIN_PASSWORD);
}

export function isAdminJwtConfigured() {
  return Boolean(env.ADMIN_JWT_SECRET && env.ADMIN_JWT_SECRET.trim().length > 0);
}

export function issueAdminJwt(payload: AdminJwtPayload, expiresIn: "12h" | "24h" = "12h") {
  if (!isAdminJwtConfigured()) {
    throw new Error("ADMIN_JWT_SECRET is not configured.");
  }
  return jwt.sign(payload, env.ADMIN_JWT_SECRET as string, { expiresIn });
}

export function verifyAdminJwt(token: string): AdminJwtPayload {
  if (!isAdminJwtConfigured()) {
    throw new Error("ADMIN_JWT_SECRET is not configured.");
  }
  const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET as string);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid admin token.");
  }

  const role = String((decoded as Record<string, unknown>).role ?? "").toUpperCase();
  const loginId = String((decoded as Record<string, unknown>).loginId ?? "");
  if (role !== "ADMIN" || !loginId) {
    throw new Error("Invalid admin token payload.");
  }

  return {
    role: "ADMIN",
    loginId,
  };
}
