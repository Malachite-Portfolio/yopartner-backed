import { app } from "./app";
import { env } from "./config/env";
import { isFirebaseAdminConfigured } from "./config/firebaseAdmin";
import { prisma } from "./db/prisma";

const start = async () => {
  console.log("[config] firebase admin project id configured:", Boolean(env.FIREBASE_ADMIN_PROJECT_ID));
  console.log("[config] firebase admin client email configured:", Boolean(env.FIREBASE_ADMIN_CLIENT_EMAIL));
  console.log("[config] firebase admin private key configured:", Boolean(env.FIREBASE_ADMIN_PRIVATE_KEY));
  console.log("[config] firebase admin ready:", isFirebaseAdminConfigured());

  await prisma.$connect();

  app.listen(env.PORT, () => {
    console.log(`YoPartner backend listening on port ${env.PORT}`);
  });
};

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
