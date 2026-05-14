import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./db/prisma";

const start = async () => {
  await prisma.$connect();

  app.listen(env.PORT, () => {
    console.log(`YoPartner backend listening on port ${env.PORT}`);
  });
};

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
