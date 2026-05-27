import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/http";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  void next;
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: "REQUEST_FAILED", message: err.message });
    return;
  }

  console.error("[errorHandler] unexpected error", err);
  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR",
    message: "Unexpected server error.",
  });
};
