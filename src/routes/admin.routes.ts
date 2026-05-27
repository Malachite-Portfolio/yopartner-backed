import { Router } from "express";
import {
  CompanionStatus,
  PartnerApplicationStatus,
  PayoutStatus,
  Prisma,
  Role,
  SessionStatus,
  TransactionStatus,
  TransactionType,
  VerificationStatus,
} from "@prisma/client";
import { requireAdminAccess } from "../middlewares/adminAccess";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";
import { createCode, HttpError } from "../utils/http";

export const adminRouter = Router();
const STALE_ACTIVE_SESSION_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES: SessionStatus[] = [SessionStatus.ACCEPTED, SessionStatus.LIVE];

adminRouter.use(requireAdminAccess);

const DEMO_PARTNER_FIREBASE_UID = "demo-host-4455667788";
const shouldExcludeDemoPartner =
  process.env.NEXT_PUBLIC_CLIENT_DEMO_ENABLED !== "true" &&
  process.env.CLIENT_DEMO_ENABLED !== "true";

function parseTransactionType(value: unknown): TransactionType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === TransactionType.RECHARGE ||
    normalized === TransactionType.BOOKING ||
    normalized === TransactionType.REFUND ||
    normalized === TransactionType.ADMIN_CREDIT
  ) {
    return normalized as TransactionType;
  }
  return null;
}

function parseTransactionStatus(value: unknown): TransactionStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === TransactionStatus.SUCCESS ||
    normalized === TransactionStatus.PENDING ||
    normalized === TransactionStatus.FAILED
  ) {
    return normalized as TransactionStatus;
  }
  return null;
}

function parsePaidAmountFromReason(reason: string | null, fallbackAmount: number) {
  if (!reason) return Math.abs(fallbackAmount);
  const match = reason.match(/\bpay=(\d+)\b/i);
  if (!match) return Math.abs(fallbackAmount);
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Math.abs(fallbackAmount);
}

adminRouter.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    const [
      usersCount,
      companionsCount,
      pendingApplicationsCount,
      sessionsLiveCount,
      bookingsCount,
      rechargeTotal,
      pendingPayoutsCount,
      supportOpenCount,
    ] = await Promise.all([
      prisma.user.count({ where: { role: Role.USER } }),
      prisma.companion.count({ where: { status: CompanionStatus.ACTIVE } }),
      prisma.partnerApplication.count({ where: { status: PartnerApplicationStatus.UNDER_REVIEW } }),
      prisma.session.count({ where: { status: SessionStatus.LIVE } }),
      prisma.booking.count(),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.RECHARGE, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
      }),
      prisma.payout.count({ where: { status: PayoutStatus.REQUESTED } }),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
    ]);

    res.json({
      stats: {
        usersCount,
        companionsCount,
        pendingApplicationsCount,
        sessionsLiveCount,
        bookingsCount,
        rechargeTotal: rechargeTotal._sum.amount ?? 0,
        pendingPayoutsCount,
        supportOpenCount,
      },
    });
  }),
);

adminRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      include: { walletAccount: true, bookings: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ users });
  }),
);

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!user) throw new HttpError(404, "User not found.");
    const walletDelta = typeof req.body.walletDelta === "number" ? req.body.walletDelta : 0;

    const updatedUser = await prisma.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: user.id },
        data: {
          ...(typeof req.body.name === "string" ? { name: req.body.name } : {}),
          ...(typeof req.body.isBlocked === "boolean" ? { isBlocked: req.body.isBlocked } : {}),
        },
      });
      if (walletDelta !== 0) {
        const wallet = await tx.walletAccount.update({
          where: { userId: user.id },
          data: { balance: { increment: walletDelta } },
        });
        await tx.walletTransaction.create({
          data: {
            transactionCode: createCode("TXN"),
            walletAccountId: wallet.id,
            type: TransactionType.ADMIN_CREDIT,
            amount: walletDelta,
            status: TransactionStatus.SUCCESS,
            reason: "Admin wallet credit adjustment",
          },
        });
      }
      return nextUser;
    });

    res.json({ user: updatedUser });
  }),
);

adminRouter.get(
  "/companions",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        ...(shouldExcludeDemoPartner
          ? {
              user: {
                firebaseUid: {
                  not: DEMO_PARTNER_FIREBASE_UID,
                },
              },
            }
          : {}),
      },
      include: { user: true, sessions: true },
      orderBy: { createdAt: "desc" },
    });
    const companionIds = companions.map((companion) => companion.id);
    const staleThreshold = new Date(Date.now() - STALE_ACTIVE_SESSION_MS);
    if (companionIds.length > 0) {
      await prisma.session.updateMany({
        where: {
          companionId: { in: companionIds },
          status: { in: ACTIVE_SESSION_STATUSES },
          endedAt: null,
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status: SessionStatus.EXPIRED,
          endedAt: new Date(),
        },
      });
    }
    const busySessions = companionIds.length
      ? await prisma.session.findMany({
          where: {
            companionId: { in: companionIds },
            status: { in: ACTIVE_SESSION_STATUSES },
            endedAt: null,
            updatedAt: { gte: staleThreshold },
          },
          select: { companionId: true },
        })
      : [];
    const busySet = new Set(busySessions.map((session) => session.companionId));

    res.json({
      companions: companions.map((companion) => {
        const isBusy = busySet.has(companion.id);
        const effectiveStatus = !companion.isOnline ? "OFFLINE" : isBusy ? "BUSY" : "ONLINE";
        return {
          ...companion,
          isBusy,
          effectiveStatus,
        };
      }),
    });
  }),
);

adminRouter.patch(
  "/companions/:id",
  asyncHandler(async (req, res) => {
    const companion = await prisma.companion.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.displayName === "string" ? { displayName: req.body.displayName } : {}),
        ...(typeof req.body.city === "string" ? { city: req.body.city } : {}),
        ...(typeof req.body.category === "string" ? { category: req.body.category } : {}),
        ...(typeof req.body.status === "string"
          ? { status: req.body.status as CompanionStatus }
          : {}),
        ...(typeof req.body.verificationStatus === "string"
          ? { verificationStatus: req.body.verificationStatus as VerificationStatus }
          : {}),
      },
    });
    res.json({ companion });
  }),
);

adminRouter.get(
  "/applications",
  asyncHandler(async (_req, res) => {
    const applications = await prisma.partnerApplication.findMany({
      include: { applicantUser: true, companion: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ applications });
  }),
);

adminRouter.get(
  "/applications/:id",
  asyncHandler(async (req, res) => {
    const application = await prisma.partnerApplication.findUnique({
      where: { id: String(req.params.id) },
      include: {
        applicantUser: {
          select: {
            id: true,
            firebaseUid: true,
            phoneNumber: true,
            name: true,
            role: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        companion: {
          select: {
            id: true,
            userId: true,
            displayName: true,
            city: true,
            category: true,
            languages: true,
            servicesOffered: true,
            chatPrice: true,
            audioPrice: true,
            videoPrice: true,
            status: true,
            verificationStatus: true,
            isOnline: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!application) throw new HttpError(404, "Application not found.");
    res.json({ application });
  }),
);

adminRouter.patch(
  "/applications/:id",
  asyncHandler(async (req, res) => {
    const rawStatus = typeof req.body.status === "string" ? req.body.status.trim().toUpperCase() : "";
    const status =
      rawStatus === PartnerApplicationStatus.APPROVED ||
      rawStatus === PartnerApplicationStatus.REJECTED ||
      rawStatus === PartnerApplicationStatus.NEEDS_INFO
        ? (rawStatus as PartnerApplicationStatus)
        : undefined;
    if (!status) {
      throw new HttpError(400, "status must be APPROVED, REJECTED, or NEEDS_INFO.");
    }
    const application = await prisma.partnerApplication.findUnique({ where: { id: String(req.params.id) } });
    if (!application) throw new HttpError(404, "Application not found.");

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.partnerApplication.update({
        where: { id: application.id },
        data: {
          status,
          ...(typeof req.body.adminNote === "string" ? { adminNote: req.body.adminNote } : {}),
        },
      });

      if (status === PartnerApplicationStatus.APPROVED) {
        await tx.user.update({
          where: { id: application.applicantUserId },
          data: { role: Role.PARTNER },
        });

        const companion =
          application.companionId
            ? await tx.companion.findUnique({ where: { id: application.companionId } })
            : null;

        if (companion) {
          await tx.companion.update({
            where: { id: companion.id },
            data: {
              status: CompanionStatus.ACTIVE,
              verificationStatus: VerificationStatus.VERIFIED,
            },
          });
        } else {
          const createdCompanion = await tx.companion.create({
            data: {
              userId: application.applicantUserId,
              displayName: application.fullName,
              tagline: application.profileTagline,
              city: application.bornCity,
              category: application.categories[0] ?? null,
              languages: application.languagesKnown,
              servicesOffered: application.servicesOffered,
              chatPrice: application.chatPrice,
              audioPrice: application.audioPrice,
              videoPrice: application.videoPrice,
              status: CompanionStatus.ACTIVE,
              verificationStatus: VerificationStatus.VERIFIED,
            },
          });
          await tx.partnerApplication.update({
            where: { id: application.id },
            data: { companionId: createdCompanion.id },
          });
        }
      } else {
        if (application.companionId) {
          await tx.companion.update({
            where: { id: application.companionId },
            data: {
              status: CompanionStatus.UNDER_REVIEW,
              verificationStatus: VerificationStatus.PENDING,
            },
          });
        }
      }
      return next;
    });

    res.json({ application: updated });
  }),
);

adminRouter.get(
  "/bookings",
  asyncHandler(async (_req, res) => {
    const bookings = await prisma.booking.findMany({
      include: { user: true, companion: true, session: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  }),
);

adminRouter.patch(
  "/bookings/:id",
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
        ...(typeof req.body.companionId === "string" ? { companionId: req.body.companionId } : {}),
      },
    });
    res.json({ booking });
  }),
);

adminRouter.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    const sessions = await prisma.session.findMany({
      include: { user: true, companion: true, booking: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ sessions });
  }),
);

adminRouter.patch(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const session = await prisma.session.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status as SessionStatus } : {}),
        ...(typeof req.body.safetyFlag === "boolean" ? { safetyFlag: req.body.safetyFlag } : {}),
        ...(typeof req.body.safetyNote === "string" ? { safetyNote: req.body.safetyNote } : {}),
      },
    });
    res.json({ session });
  }),
);

adminRouter.get(
  "/wallet/transactions",
  asyncHandler(async (_req, res) => {
    const transactions = await prisma.walletTransaction.findMany({
      include: { walletAccount: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ transactions });
  }),
);

adminRouter.get(
  "/wallet/summary",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const type = parseTransactionType(req.query.type);
    const status = parseTransactionStatus(req.query.status);

    const where: Prisma.WalletTransactionWhereInput = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { transactionCode: { contains: search, mode: "insensitive" } },
        { referenceId: { contains: search, mode: "insensitive" } },
        { walletAccount: { user: { phoneNumber: { contains: search, mode: "insensitive" } } } },
        { walletAccount: { user: { name: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [transactions, rechargedAgg, spentAgg, refundsAgg, totalTransactions] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        include: {
          walletAccount: {
            include: {
              user: {
                select: {
                  name: true,
                  phoneNumber: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.RECHARGE, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
        _count: { id: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.BOOKING, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { type: TransactionType.REFUND, status: TransactionStatus.SUCCESS },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.count(),
    ]);

    const totalRecharged = rechargedAgg._sum.amount ?? 0;
    const totalSpent = Math.abs(spentAgg._sum.amount ?? 0);
    const totalRefunds = refundsAgg._sum.amount ?? 0;
    const rechargeCount = rechargedAgg._count.id ?? 0;
    const averageRecharge = rechargeCount > 0 ? Math.round(totalRecharged / rechargeCount) : 0;

    res.json({
      totalRecharged,
      totalSpent,
      totalRefunds,
      totalTransactions,
      averageRecharge,
      transactions: transactions.map((tx) => ({
        id: tx.id,
        transactionId: tx.transactionCode,
        userPhone: tx.walletAccount.user.phoneNumber,
        userName: tx.walletAccount.user.name,
        type: tx.type,
        amount: tx.amount,
        status: tx.status,
        gateway: tx.gateway,
        createdAt: tx.createdAt,
        paidAmount: parsePaidAmountFromReason(tx.reason, tx.amount),
        walletCredit: tx.type === TransactionType.RECHARGE && tx.status === TransactionStatus.SUCCESS
          ? Math.max(tx.amount, 0)
          : 0,
      })),
    });
  }),
);

adminRouter.get(
  "/payouts",
  asyncHandler(async (_req, res) => {
    const payouts = await prisma.payout.findMany({
      include: { companion: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ payouts });
  }),
);

adminRouter.patch(
  "/payouts/:id",
  asyncHandler(async (req, res) => {
    const payout = await prisma.payout.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status as PayoutStatus } : {}),
        ...(typeof req.body.rejectionReason === "string" ? { rejectionReason: req.body.rejectionReason } : {}),
        ...(req.body.status === PayoutStatus.PAID ? { processedAt: new Date() } : {}),
      },
    });
    res.json({ payout });
  }),
);

adminRouter.get(
  "/verification",
  asyncHandler(async (_req, res) => {
    const verifications = await prisma.verificationRecord.findMany({
      include: { companion: { include: { user: true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ verifications });
  }),
);

adminRouter.patch(
  "/verification/:id",
  asyncHandler(async (req, res) => {
    const verification = await prisma.verificationRecord.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.idVerification === "string"
          ? { idVerification: req.body.idVerification as VerificationStatus }
          : {}),
        ...(typeof req.body.policeVerification === "string"
          ? { policeVerification: req.body.policeVerification as VerificationStatus }
          : {}),
        ...(typeof req.body.psychometricTest === "string"
          ? { psychometricTest: req.body.psychometricTest as VerificationStatus }
          : {}),
        ...(typeof req.body.interviewStatus === "string"
          ? { interviewStatus: req.body.interviewStatus as VerificationStatus }
          : {}),
        ...(typeof req.body.trainingStatus === "string"
          ? { trainingStatus: req.body.trainingStatus as VerificationStatus }
          : {}),
        ...(typeof req.body.overallStatus === "string"
          ? { overallStatus: req.body.overallStatus as VerificationStatus }
          : {}),
      },
    });
    res.json({ verification });
  }),
);

adminRouter.get(
  "/reviews",
  asyncHandler(async (_req, res) => {
    const reviews = await prisma.review.findMany({
      include: { user: true, companion: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ reviews });
  }),
);

adminRouter.patch(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const review = await prisma.review.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.isApproved === "boolean" ? { isApproved: req.body.isApproved } : {}),
        ...(typeof req.body.isHidden === "boolean" ? { isHidden: req.body.isHidden } : {}),
        ...(typeof req.body.isFlagged === "boolean" ? { isFlagged: req.body.isFlagged } : {}),
      },
    });
    res.json({ review });
  }),
);

adminRouter.delete(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    await prisma.review.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/support",
  asyncHandler(async (_req, res) => {
    const tickets = await prisma.supportTicket.findMany({
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ tickets });
  }),
);

adminRouter.patch(
  "/support/:id",
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!ticket) throw new HttpError(404, "Support ticket not found.");
    const note = typeof req.body.note === "string" ? req.body.note : null;
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
        ...(typeof req.body.assignedTo === "string" ? { assignedTo: req.body.assignedTo } : {}),
        ...(note ? { internalNotes: [...ticket.internalNotes, note] } : {}),
      },
    });
    res.json({ ticket: updated });
  }),
);

adminRouter.get(
  "/settings/:key",
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const setting = await prisma.platformSetting.findUnique({ where: { key } });
    res.json({ setting });
  }),
);

adminRouter.put(
  "/settings/:key",
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const setting = await prisma.platformSetting.upsert({
      where: { key },
      update: { value: req.body ?? {} },
      create: { key, value: req.body ?? {} },
    });
    res.json({ setting });
  }),
);

adminRouter.get(
  "/media",
  asyncHandler(async (_req, res) => {
    const media = await prisma.mediaItem.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ media });
  }),
);

adminRouter.post(
  "/media",
  asyncHandler(async (req, res) => {
    const media = await prisma.mediaItem.create({
      data: {
        title: req.body.title,
        publisher: req.body.publisher,
        type: req.body.type,
        imageUrl: req.body.imageUrl,
        linkUrl: req.body.linkUrl,
        status: req.body.status ?? "DRAFT",
      },
    });
    res.status(201).json({ media });
  }),
);

adminRouter.patch(
  "/media/:id",
  asyncHandler(async (req, res) => {
    const media = await prisma.mediaItem.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.title === "string" ? { title: req.body.title } : {}),
        ...(typeof req.body.publisher === "string" ? { publisher: req.body.publisher } : {}),
        ...(typeof req.body.type === "string" ? { type: req.body.type } : {}),
        ...(typeof req.body.imageUrl === "string" ? { imageUrl: req.body.imageUrl } : {}),
        ...(typeof req.body.linkUrl === "string" ? { linkUrl: req.body.linkUrl } : {}),
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
      },
    });
    res.json({ media });
  }),
);

adminRouter.delete(
  "/media/:id",
  asyncHandler(async (req, res) => {
    await prisma.mediaItem.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/client-diaries",
  asyncHandler(async (_req, res) => {
    const diaries = await prisma.clientDiary.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ diaries });
  }),
);

adminRouter.post(
  "/client-diaries",
  asyncHandler(async (req, res) => {
    const diary = await prisma.clientDiary.create({
      data: {
        title: req.body.title,
        subtitle: req.body.subtitle,
        imageUrl: req.body.imageUrl,
        videoUrl: req.body.videoUrl,
        status: req.body.status ?? "DRAFT",
      },
    });
    res.status(201).json({ diary });
  }),
);

adminRouter.patch(
  "/client-diaries/:id",
  asyncHandler(async (req, res) => {
    const diary = await prisma.clientDiary.update({
      where: { id: String(req.params.id) },
      data: {
        ...(typeof req.body.title === "string" ? { title: req.body.title } : {}),
        ...(typeof req.body.subtitle === "string" ? { subtitle: req.body.subtitle } : {}),
        ...(typeof req.body.imageUrl === "string" ? { imageUrl: req.body.imageUrl } : {}),
        ...(typeof req.body.videoUrl === "string" ? { videoUrl: req.body.videoUrl } : {}),
        ...(typeof req.body.status === "string" ? { status: req.body.status } : {}),
      },
    });
    res.json({ diary });
  }),
);

adminRouter.delete(
  "/client-diaries/:id",
  asyncHandler(async (req, res) => {
    await prisma.clientDiary.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
  }),
);

adminRouter.get(
  "/reports/summary",
  asyncHandler(async (_req, res) => {
    const [sessionsByType, companionStats, userStats, payoutStats] = await Promise.all([
      prisma.session.groupBy({
        by: ["serviceType"],
        _count: { id: true },
      }),
      prisma.companion.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.user.groupBy({
        by: ["isBlocked"],
        _count: { id: true },
      }),
      prisma.payout.aggregate({
        _sum: { amount: true },
      }),
    ]);

    res.json({
      sessionsByType,
      companionStats,
      userStats,
      payoutAmountTotal: payoutStats._sum.amount ?? 0,
    });
  }),
);
