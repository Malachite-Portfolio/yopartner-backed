import {
  CompanionStatus,
  PrismaClient,
  Role,
  ServiceType,
  VerificationStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_HOST_PHONE = "+914455667788";
const DEMO_HOST_UID = "demo-host-4455667788";

async function upsertDemoHost() {
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [
        { phoneNumber: DEMO_HOST_PHONE },
        { firebaseUid: DEMO_HOST_UID },
      ],
    },
  });

  const user = existingUser
    ? await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          phoneNumber: DEMO_HOST_PHONE,
          firebaseUid: DEMO_HOST_UID,
          name: "Client Demo Host",
          role: Role.PARTNER,
          isBlocked: false,
        },
      })
    : await prisma.user.create({
        data: {
          phoneNumber: DEMO_HOST_PHONE,
          firebaseUid: DEMO_HOST_UID,
          name: "Client Demo Host",
          role: Role.PARTNER,
          isBlocked: false,
        },
      });

  const companion = await prisma.companion.upsert({
    where: { userId: user.id },
    update: {
      displayName: "Client Demo Host",
      tagline: "Calm, friendly conversations for client preview",
      city: "Kolkata",
      category: "Communication & Emotional Support",
      languages: ["Hindi", "English"],
      servicesOffered: [ServiceType.CHAT, ServiceType.AUDIO, ServiceType.VIDEO],
      chatPrice: 10,
      audioPrice: 20,
      videoPrice: 40,
      rating: 5,
      status: CompanionStatus.ACTIVE,
      verificationStatus: VerificationStatus.VERIFIED,
      isOnline: true,
    },
    create: {
      userId: user.id,
      displayName: "Client Demo Host",
      tagline: "Calm, friendly conversations for client preview",
      city: "Kolkata",
      category: "Communication & Emotional Support",
      languages: ["Hindi", "English"],
      servicesOffered: [ServiceType.CHAT, ServiceType.AUDIO, ServiceType.VIDEO],
      chatPrice: 10,
      audioPrice: 20,
      videoPrice: 40,
      rating: 5,
      status: CompanionStatus.ACTIVE,
      verificationStatus: VerificationStatus.VERIFIED,
      isOnline: true,
    },
  });

  await prisma.walletAccount.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });

  console.log("Demo host upserted:", {
    phoneNumber: user.phoneNumber,
    firebaseUid: user.firebaseUid,
    companionId: companion.id,
    status: companion.status,
    servicesOffered: companion.servicesOffered,
  });
}

upsertDemoHost()
  .catch((error) => {
    console.error("Failed to seed demo host:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
