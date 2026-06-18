import { Router } from "express";
import { TransactionStatus, TransactionType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";
import { assertUserCanAddMoney } from "../utils/moderation";
import { WALLET_PLANS } from "../config/platformPricing";

const createOrderSchema = z.object({
  amount: z.number().int().positive(),
});

const verifyOrderSchema = z.object({
  transactionCode: z.string().min(1),
  gatewayReferenceId: z.string().min(1),
});

export const walletRouter = Router();

walletRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const wallet = await prisma.walletAccount.upsert({
      where: { userId: authUser.id },
      update: {},
      create: { userId: authUser.id },
    });
    res.json({
      id: wallet.id,
      userId: wallet.userId,
      balance: wallet.balance,
      currency: "INR",
      wallet,
    });
  }),
);

walletRouter.get(
  "/transactions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const wallet = await prisma.walletAccount.upsert({
      where: { userId: authUser.id },
      update: {},
      create: { userId: authUser.id },
    });
    const transactions = await prisma.walletTransaction.findMany({
      where: { walletAccountId: wallet.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ transactions });
  }),
);

walletRouter.post(
  "/recharge-order",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true },
    });
    if (!user) throw new HttpError(404, "User not found.");
    assertUserCanAddMoney(user);
    const body = createOrderSchema.parse(req.body);
    const wallet = await prisma.walletAccount.findUnique({
      where: { userId: authUser.id },
    });
    if (!wallet) throw new HttpError(404, "Wallet account not found.");
    const plan = WALLET_PLANS.find((item) => item.pay === body.amount);
    if (!plan) throw new HttpError(400, "Select a valid recharge plan.");

    const transaction = await prisma.walletTransaction.create({
      data: {
        transactionCode: createCode("TXN"),
        walletAccountId: wallet.id,
        type: TransactionType.RECHARGE,
        amount: plan.get,
        status: TransactionStatus.PENDING,
        gateway: "RAZORPAY_LATER",
        reason: `Recharge order created (pay=${plan.pay}, bonus=${plan.get - plan.pay}, plan=${plan.pay})`,
      },
    });

    res.status(201).json({
      transaction,
      gatewayPayload: {
        amount: plan.pay,
        currency: "INR",
        receipt: transaction.transactionCode,
      },
    });
  }),
);

walletRouter.post(
  "/verify-recharge",
  requireAuth,
  asyncHandler(async (req, res) => {
    void req;
    void res;
    verifyOrderSchema.parse(req.body);
    throw new HttpError(410, "Legacy recharge verification is disabled. Use Razorpay verification endpoint.");
  }),
);
