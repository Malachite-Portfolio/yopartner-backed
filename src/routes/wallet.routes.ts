import { Router } from "express";
import { TransactionStatus, TransactionType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";

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
    const wallet = await prisma.walletAccount.findUnique({
      where: { userId: authUser.id },
    });
    if (!wallet) throw new HttpError(404, "Wallet account not found.");
    res.json({ wallet });
  }),
);

walletRouter.get(
  "/transactions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const authUser = req.authUser!;
    const wallet = await prisma.walletAccount.findUnique({
      where: { userId: authUser.id },
    });
    if (!wallet) throw new HttpError(404, "Wallet account not found.");
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
    const body = createOrderSchema.parse(req.body);
    const wallet = await prisma.walletAccount.findUnique({
      where: { userId: authUser.id },
    });
    if (!wallet) throw new HttpError(404, "Wallet account not found.");

    const transaction = await prisma.walletTransaction.create({
      data: {
        transactionCode: createCode("TXN"),
        walletAccountId: wallet.id,
        type: TransactionType.RECHARGE,
        amount: body.amount,
        status: TransactionStatus.PENDING,
        gateway: "RAZORPAY_LATER",
        reason: "Recharge order created",
      },
    });

    res.status(201).json({
      transaction,
      gatewayPayload: {
        amount: body.amount,
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
    const authUser = req.authUser!;
    const body = verifyOrderSchema.parse(req.body);
    const wallet = await prisma.walletAccount.findUnique({
      where: { userId: authUser.id },
    });
    if (!wallet) throw new HttpError(404, "Wallet account not found.");

    const transaction = await prisma.walletTransaction.findFirst({
      where: {
        transactionCode: body.transactionCode,
        walletAccountId: wallet.id,
        type: TransactionType.RECHARGE,
      },
    });
    if (!transaction) throw new HttpError(404, "Recharge transaction not found.");
    if (transaction.status === TransactionStatus.SUCCESS) {
      res.json({ transaction, wallet });
      return;
    }

    const [updatedTransaction, updatedWallet] = await prisma.$transaction([
      prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.SUCCESS,
          referenceId: body.gatewayReferenceId,
        },
      }),
      prisma.walletAccount.update({
        where: { id: wallet.id },
        data: { balance: { increment: transaction.amount } },
      }),
    ]);

    res.json({
      transaction: updatedTransaction,
      wallet: updatedWallet,
    });
  }),
);
