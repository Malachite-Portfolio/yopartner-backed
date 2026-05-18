import { cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { env } from "./env";

export function isFirebaseAdminConfigured() {
  return Boolean(
    env.FIREBASE_ADMIN_PROJECT_ID &&
      env.FIREBASE_ADMIN_CLIENT_EMAIL &&
      env.FIREBASE_ADMIN_PRIVATE_KEY,
  );
}

let app = null;
if (isFirebaseAdminConfigured()) {
  try {
    app =
      getApps().length > 0
        ? getApp()
        : initializeApp({
            credential: cert({
              projectId: env.FIREBASE_ADMIN_PROJECT_ID,
              clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
              privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY,
            }),
          });
  } catch (error) {
    app = null;
    if (process.env.NODE_ENV !== "production") {
      console.error("[firebaseAdmin] initialization failed", error);
    }
  }
}

export const firebaseAdminAuth = app ? getAuth(app) : null;
