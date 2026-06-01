import { Router } from "express";
import { createHmac } from "node:crypto";
import { TransactionStatus, TransactionType } from "@prisma/client";
import { z } from "zod";
import { env } from "../config/env";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { HttpError } from "../utils/http";
import { assertUserCanAddMoney } from "../utils/moderation";

const gstRate = 0.18;
const razorpayOrdersUrl = "https://api.razorpay.com/v1/orders";

const rechargePlanMap: Record<string, { amount: number; bonusRate: number }> = {
  "100": { amount: 100, bonusRate: 0.05 },
  "200": { amount: 200, bonusRate: 0.05 },
  "300": { amount: 300, bonusRate: 0.05 },
  "400": { amount: 400, bonusRate: 0.05 },
  "500": { amount: 500, bonusRate: 0.1 },
  "2000": { amount: 2000, bonusRate: 0.2 },
};

const razorpayOrderSchema = z.object({
  amount: z.number().int().positive(),
  walletCredit: z.number().int().positive(),
  gstAmount: z.number().int().nonnegative(),
  bonusAmount: z.number().int().nonnegative(),
  planId: z.string().trim().min(1).optional(),
});

const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1),
  razorpay_payment_id: z.string().trim().min(1),
  razorpay_signature: z.string().trim().min(1),
  amount: z.number().int().positive(),
  walletCredit: z.number().int().positive(),
  gstAmount: z.number().int().nonnegative(),
  bonusAmount: z.number().int().nonnegative(),
  planId: z.string().trim().min(1).optional(),
});

const webhookSchema = z.object({
  transactionCode: z.string().min(1),
  status: z.enum(["SUCCESS", "FAILED"]),
  gatewayReferenceId: z.string().optional(),
});

export const paymentsRouter = Router();

function ensureRazorpayConfigured() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, "Razorpay is not configured.");
  }
}

function roundToRupee(value: number) {
  return Math.round(value);
}

function assertRechargeQuote(input: z.infer<typeof razorpayOrderSchema>) {
  if (input.planId) {
    const plan = rechargePlanMap[input.planId];
    if (!plan) throw new HttpError(400, "Invalid recharge plan.");

    const expectedBonus = roundToRupee(plan.amount * plan.bonusRate);
    const expectedGst = roundToRupee(plan.amount * gstRate);
    const expectedPay = plan.amount + expectedGst;
    const expectedCredit = plan.amount + expectedBonus;

    if (
      input.amount !== expectedPay ||
      input.walletCredit !== expectedCredit ||
      input.gstAmount !== expectedGst ||
      input.bonusAmount !== expectedBonus
    ) {
      throw new HttpError(400, "Recharge amount mismatch. Please refresh and try again.");
    }

    return {
      baseAmount: plan.amount,
      payAmount: expectedPay,
      walletCredit: expectedCredit,
      gstAmount: expectedGst,
      bonusAmount: expectedBonus,
    };
  }

  if (input.bonusAmount !== 0) {
    throw new HttpError(400, "Bonus is only available for supported plans.");
  }

  const inferredBaseAmount = input.walletCredit - input.bonusAmount;
  if (inferredBaseAmount <= 0) {
    throw new HttpError(400, "Invalid wallet credit amount.");
  }

  const expectedGst = roundToRupee(inferredBaseAmount * gstRate);
  const expectedPay = inferredBaseAmount + expectedGst;

  if (input.gstAmount !== expectedGst || input.amount !== expectedPay) {
    throw new HttpError(400, "Recharge amount mismatch. Please refresh and try again.");
  }

  return {
    baseAmount: inferredBaseAmount,
    payAmount: expectedPay,
    walletCredit: input.walletCredit,
    gstAmount: input.gstAmount,
    bonusAmount: 0,
  };
}

paymentsRouter.post(
  "/razorpay/order",
  requireAuth,
  asyncHandler(async (req, res) => {
    ensureRazorpayConfigured();
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true },
    });
    if (!user) throw new HttpError(404, "User not found.");
    assertUserCanAddMoney(user);
    const body = razorpayOrderSchema.parse(req.body);
    const quote = assertRechargeQuote(body);

    const wallet = await prisma.walletAccount.upsert({
      where: { userId: authUser.id },
      update: {},
      create: { userId: authUser.id },
    });

    const transaction = await prisma.walletTransaction.create({
      data: {
        transactionCode: `RZP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        walletAccountId: wallet.id,
        type: TransactionType.RECHARGE,
        amount: quote.walletCredit,
        status: TransactionStatus.PENDING,
        gateway: "RAZORPAY",
        reason: `Wallet recharge initiated (pay=${quote.payAmount}, gst=${quote.gstAmount}, bonus=${quote.bonusAmount}, plan=${body.planId ?? "custom"})`,
      },
    });

    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const razorpayResponse = await fetch(razorpayOrdersUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: quote.payAmount * 100,
        currency: "INR",
        receipt: transaction.transactionCode.slice(0, 40),
        notes: {
          transactionCode: transaction.transactionCode,
          userId: authUser.id,
          planId: body.planId ?? "custom",
          walletCredit: String(quote.walletCredit),
          gstAmount: String(quote.gstAmount),
          bonusAmount: String(quote.bonusAmount),
        },
      }),
    });

    const razorpayPayload = (await razorpayResponse.json().catch(() => ({}))) as {
      id?: string;
      amount?: number;
      error?: { description?: string };
    };

    if (!razorpayResponse.ok || !razorpayPayload.id || !razorpayPayload.amount) {
      await prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.FAILED,
          reason: `Razorpay order failed: ${razorpayPayload.error?.description ?? "unknown error"}`,
        },
      });
      throw new HttpError(502, razorpayPayload.error?.description ?? "Unable to create Razorpay order.");
    }

    await prisma.walletTransaction.update({
      where: { id: transaction.id },
      data: { referenceId: razorpayPayload.id },
    });

    res.status(201).json({
      success: true,
      orderId: razorpayPayload.id,
      amount: razorpayPayload.amount,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID,
      transactionCode: transaction.transactionCode,
    });
  }),
);

paymentsRouter.post(
  "/razorpay/verify",
  requireAuth,
  asyncHandler(async (req, res) => {
    ensureRazorpayConfigured();
    const authUser = req.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { moderationStatus: true, moderationExpiresAt: true },
    });
    if (!user) throw new HttpError(404, "User not found.");
    assertUserCanAddMoney(user);
    const body = razorpayVerifySchema.parse(req.body);
    const quote = assertRechargeQuote(body);

    const expectedSignature = createHmac("sha256", env.RAZORPAY_KEY_SECRET)
      .update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== body.razorpay_signature) {
      throw new HttpError(400, "Payment signature verification failed.");
    }

    const wallet = await prisma.walletAccount.upsert({
      where: { userId: authUser.id },
      update: {},
      create: { userId: authUser.id },
    });

    const duplicateCredit = await prisma.walletTransaction.findFirst({
      where: {
        type: TransactionType.RECHARGE,
        status: TransactionStatus.SUCCESS,
        referenceId: body.razorpay_payment_id,
      },
    });

    if (duplicateCredit) {
      throw new HttpError(409, "Payment already verified.");
    }

    const pendingTransaction = await prisma.walletTransaction.findFirst({
      where: {
        walletAccountId: wallet.id,
        type: TransactionType.RECHARGE,
        status: TransactionStatus.PENDING,
        referenceId: body.razorpay_order_id,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!pendingTransaction) {
      throw new HttpError(404, "Recharge transaction not found for this order.");
    }

    if (pendingTransaction.amount !== quote.walletCredit) {
      throw new HttpError(400, "Wallet credit mismatch for this order.");
    }

    const { updatedTransaction, updatedWallet } = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.walletTransaction.updateMany({
        where: {
          id: pendingTransaction.id,
          status: TransactionStatus.PENDING,
        },
        data: {
          status: TransactionStatus.SUCCESS,
          referenceId: body.razorpay_payment_id,
          reason: `Razorpay verified (order=${body.razorpay_order_id}, pay=${quote.payAmount}, gst=${quote.gstAmount}, bonus=${quote.bonusAmount}, plan=${body.planId ?? "custom"})`,
        },
      });

      if (updateResult.count === 0) {
        throw new HttpError(409, "Payment already verified.");
      }

      const updatedWallet = await tx.walletAccount.update({
        where: { id: wallet.id },
        data: { balance: { increment: quote.walletCredit } },
      });

      const updatedTransaction = await tx.walletTransaction.findUnique({
        where: { id: pendingTransaction.id },
      });

      if (!updatedTransaction) {
        throw new HttpError(404, "Recharge transaction not found after verification.");
      }

      return { updatedTransaction, updatedWallet };
    });

    res.json({
      success: true,
      transaction: updatedTransaction,
      wallet: updatedWallet,
    });
  }),
);

paymentsRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const body = webhookSchema.parse(req.body);
    const transaction = await prisma.walletTransaction.findUnique({
      where: { transactionCode: body.transactionCode },
      include: { walletAccount: true },
    });
    if (!transaction) throw new HttpError(404, "Transaction not found.");

    if (body.status === "SUCCESS" && transaction.status !== "SUCCESS") {
      await prisma.$transaction([
        prisma.walletTransaction.update({
          where: { id: transaction.id },
          data: {
            status: "SUCCESS",
            referenceId: body.gatewayReferenceId,
          },
        }),
        prisma.walletAccount.update({
          where: { id: transaction.walletAccountId },
          data: { balance: { increment: transaction.amount } },
        }),
      ]);
    } else if (body.status === "FAILED") {
      await prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", referenceId: body.gatewayReferenceId },
      });
    }

    res.json({ success: true });
  }),
);
