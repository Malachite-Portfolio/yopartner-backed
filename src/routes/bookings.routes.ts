import { Router } from "express";
import { BookingStatus, ServiceType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { assertPartnerCanReceiveRequests, assertUserCanStartSession } from "../utils/moderation";
import { getFixedSessionRate } from "../config/platformPricing";

const createBookingSchema = z.object({
  companionId: z.string().min(1),
  serviceType: z.enum(["chat", "audio", "video"]),
});

export const bookingsRouter = Router();

bookingsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const bookings = await prisma.booking.findMany({
      where: { userId: authUser.id },
      include: { companion: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  }),
);

bookingsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const body = createBookingSchema.parse(req.body);
    const requester = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true },
    });
    if (!requester) throw new HttpError(404, "User not found.");
    assertUserCanStartSession(requester);

    const companion = await prisma.companion.findUnique({ where: { id: body.companionId } });
    if (companion) assertPartnerCanReceiveRequests(companion);
    if (!companion || companion.status !== "ACTIVE") {
      throw new HttpError(404, "Partner not available.");
    }

    const serviceType =
      body.serviceType === "chat"
        ? ServiceType.CHAT
        : body.serviceType === "audio"
          ? ServiceType.AUDIO
          : ServiceType.VIDEO;

    const amount = getFixedSessionRate(serviceType);

    const wallet = await prisma.walletAccount.findUnique({ where: { userId: authUser.id } });
    if (!wallet) throw new HttpError(400, "Wallet account not found.");
    if (wallet.balance < amount) throw new HttpError(400, "Insufficient wallet balance.");

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          bookingCode: createCode("BK"),
          userId: authUser.id,
          companionId: companion.id,
          serviceType,
          amount,
          status: BookingStatus.CONFIRMED,
        },
      });
      await tx.walletAccount.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } },
      });
      await tx.walletTransaction.create({
        data: {
          transactionCode: createCode("TXN"),
          walletAccountId: wallet.id,
          bookingId: created.id,
          type: "BOOKING",
          amount: -amount,
          status: "SUCCESS",
          reason: `Booking ${created.bookingCode} created`,
        },
      });
      return created;
    });

    res.status(201).json({ booking });
  }),
);

bookingsRouter.patch(
  "/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const booking = await prisma.booking.findFirst({
      where: { id: String(req.params.id), userId: authUser.id },
      include: { user: { include: { walletAccount: true } } },
    });
    if (!booking) throw new HttpError(404, "Booking not found.");
    if (booking.status === BookingStatus.CANCELLED) {
      res.json({ booking });
      return;
    }

    const wallet = booking.user.walletAccount;
    if (!wallet) throw new HttpError(400, "Wallet account not found.");

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CANCELLED },
      });
      await tx.walletAccount.update({
        where: { id: wallet.id },
        data: { balance: { increment: booking.amount } },
      });
      await tx.walletTransaction.create({
        data: {
          transactionCode: createCode("TXN"),
          walletAccountId: wallet.id,
          bookingId: booking.id,
          type: "REFUND",
          amount: booking.amount,
          status: "SUCCESS",
          reason: `Refund for cancelled booking ${booking.bookingCode}`,
        },
      });
      return next;
    });

    res.json({ booking: updated });
  }),
);
