import { Router } from "express";
import { env } from "../config/env";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAdminAccess } from "../middlewares/adminAccess";
import { areAdminCredentialsConfigured, issueAdminJwt, isAdminJwtConfigured } from "../utils/adminJwt";

export const adminAuthRouter = Router();

adminAuthRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const loginId = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!areAdminCredentialsConfigured() || !isAdminJwtConfigured()) {
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Admin credentials are not configured.",
      });
      return;
    }

    if (!loginId || !password) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "loginId and password are required.",
      });
      return;
    }

    if (loginId !== env.ADMIN_LOGIN_ID || password !== env.ADMIN_LOGIN_PASSWORD) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid admin credentials.",
      });
      return;
    }

    const token = issueAdminJwt(
      {
        role: "ADMIN",
        loginId: env.ADMIN_LOGIN_ID as string,
      },
      "12h",
    );

    res.json({
      token,
      admin: {
        role: "ADMIN",
        loginId: env.ADMIN_LOGIN_ID,
      },
    });
  }),
);

adminAuthRouter.get(
  "/me",
  requireAdminAccess,
  asyncHandler(async (req, res) => {
    const loginId = req.authUser?.adminLoginId ?? req.authUser?.phoneNumber ?? "";
    res.json({
      admin: {
        role: "ADMIN",
        loginId,
      },
    });
  }),
);
