import type { Role } from "@prisma/client";

export type AuthUser = {
  id: string;
  firebaseUid: string;
  phoneNumber: string;
  role: Role;
  authType?: "firebase" | "admin_jwt";
  adminLoginId?: string;
};
