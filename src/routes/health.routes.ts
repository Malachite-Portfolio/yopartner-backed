import { Router } from "express";
import { env } from "../config/env";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "yopartner-backed",
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});
