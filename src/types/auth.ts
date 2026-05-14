import type { Role } from "@prisma/client";

export type AuthUser = {
  id: string;
  firebaseUid: string;
  phoneNumber: string;
  role: Role;
};
