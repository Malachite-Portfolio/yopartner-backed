import type { Request, Response, NextFunction } from "express";

export const asyncHandler =
  <TReq extends Request = Request, TRes extends Response = Response>(
    fn: (req: TReq, res: TRes, next: NextFunction) => Promise<void>,
  ) =>
  (req: TReq, res: TRes, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
