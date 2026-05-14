import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode } from "../utils/http";

const profileSchema = z.object({
  name: z.string().min(2).optional(),
});

const supportSchema = z.object({
  subject: z.string().min(3),
  type: z.string().min(2),
  message: z.string().min(10),
  priority: z.string().optional(),
});

const reviewSchema = z.object({
  companionId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3),
});

export const usersRouter = Router();

usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: {
        walletAccount: true,
      },
    });
    res.json({ user });
  }),
);

usersRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
      },
    });
    res.json({ user });
  }),
);

usersRouter.post(
  "/support",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = supportSchema.parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: {
        ticketCode: createCode("TKT"),
        userId: authUser.id,
        subject: body.subject,
        type: body.type,
        message: body.message,
        priority: body.priority ?? "MEDIUM",
      },
    });
    res.status(201).json({ ticket });
  }),
);

usersRouter.post(
  "/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = reviewSchema.parse(req.body);
    const review = await prisma.review.create({
      data: {
        userId: authUser.id,
        companionId: body.companionId,
        rating: body.rating,
        comment: body.comment,
      },
    });
    res.status(201).json({ review });
  }),
);
