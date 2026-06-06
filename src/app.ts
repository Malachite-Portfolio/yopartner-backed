import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { healthRouter } from "./routes/health.routes";
import { authRouter } from "./routes/auth.routes";
import { companionsRouter } from "./routes/companions.routes";
import { partnerRouter } from "./routes/partner.routes";
import { bookingsRouter } from "./routes/bookings.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { reviewsRouter } from "./routes/reviews.routes";
import { walletRouter } from "./routes/wallet.routes";
import { adminRouter } from "./routes/admin.routes";
import { adminAuthRouter } from "./routes/adminAuth.routes";
import { agoraRouter } from "./routes/agora.routes";
import { usersRouter } from "./routes/users.routes";
import { paymentsRouter } from "./routes/payments.routes";
import { luckyWheelRouter } from "./routes/luckyWheel.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { notFoundHandler } from "./middlewares/notFound";
import { errorHandler } from "./middlewares/errorHandler";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",").map((v) => v.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/", (_req, res) => {
  res.json({
    service: "YoPartner Backend",
    status: "online",
  });
});

app.use("/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/companions", companionsRouter);
app.use("/api/partner", partnerRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/users", usersRouter);
app.use("/api/lucky-wheel", luckyWheelRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/admin", adminRouter);
app.use("/api/agora", agoraRouter);
app.use("/api/payments", paymentsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
