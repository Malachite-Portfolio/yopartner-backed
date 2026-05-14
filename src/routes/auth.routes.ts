import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";

export const authRouter = Router();

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: { walletAccount: true },
    });
    res.json({ user });
  }),
);
