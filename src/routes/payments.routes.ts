import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { HttpError } from "../utils/http";

const webhookSchema = z.object({
  transactionCode: z.string().min(1),
  status: z.enum(["SUCCESS", "FAILED"]),
  gatewayReferenceId: z.string().optional(),
});

export const paymentsRouter = Router();

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
