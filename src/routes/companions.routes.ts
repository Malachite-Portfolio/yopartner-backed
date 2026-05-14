import { Router } from "express";
import { CompanionStatus } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { prisma } from "../db/prisma";

export const companionsRouter = Router();

companionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const online = req.query.online === "true";

    const companions = await prisma.companion.findMany({
      where: {
        status: CompanionStatus.ACTIVE,
        ...(online ? { isOnline: true } : {}),
        ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: "insensitive" } },
                { tagline: { contains: search, mode: "insensitive" } },
                { city: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ isOnline: "desc" }, { rating: "desc" }],
    });

    res.json({ companions });
  }),
);

companionsRouter.get(
  "/featured",
  asyncHandler(async (_req, res) => {
    const companions = await prisma.companion.findMany({
      where: { status: CompanionStatus.ACTIVE },
      orderBy: [{ rating: "desc" }],
      take: 12,
    });
    res.json({ companions });
  }),
);

companionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const companion = await prisma.companion.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!companion || companion.status !== CompanionStatus.ACTIVE) {
      res.status(404).json({ error: "NOT_FOUND", message: "Companion not found." });
      return;
    }
    res.json({ companion });
  }),
);
