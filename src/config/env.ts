import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().default("8080"),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default("*"),
  FIREBASE_ADMIN_PROJECT_ID: z.string().optional().default(""),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().optional().default(""),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().optional().default(""),
  FIREBASE_STORAGE_BUCKET: z.string().optional().default(""),
  ADMIN_UID_ALLOWLIST: z.string().optional(),
  ADMIN_PHONE_ALLOWLIST: z.string().optional(),
  ADMIN_LOGIN_ID: z.string().optional(),
  ADMIN_LOGIN_PASSWORD: z.string().optional(),
  ADMIN_JWT_SECRET: z.string().optional(),
  NEXT_PUBLIC_AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  AGORA_CHAT_APP_KEY: z.string().optional(),
  AGORA_CHAT_ORG_NAME: z.string().optional(),
  AGORA_CHAT_APP_NAME: z.string().optional(),
  CALL_PROVIDER: z.enum(["agora", "zegocloud"]).default("zegocloud"),
  ZEGO_APP_ID: z.string().optional().default(""),
  ZEGO_SERVER_SECRET: z.string().optional().default(""),
  ZEGO_TOKEN_EXPIRE_SECONDS: z.string().optional().default("3600"),
  ZEGO_TOKEN_ENDPOINT: z.string().optional().default("/api/calls/zego-token"),
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  ENABLE_WEB_PUSH_NOTIFICATIONS: z.string().optional().default("false"),
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  VAPID_SUBJECT: z.string().optional().default("mailto:support@yopartner.com"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errors = parsedEnv.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment variables:\n${errors}`);
}

export const env = {
  ...parsedEnv.data,
  PORT: Number(parsedEnv.data.PORT),
  ZEGO_APP_ID: Number(parsedEnv.data.ZEGO_APP_ID || 0),
  ZEGO_TOKEN_EXPIRE_SECONDS: Number(parsedEnv.data.ZEGO_TOKEN_EXPIRE_SECONDS || 3600),
  FIREBASE_ADMIN_PRIVATE_KEY: parsedEnv.data.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
};
