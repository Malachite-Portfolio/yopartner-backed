import { env } from "../config/env";
import { generateZegoToken04 } from "./zegoToken";

export type CallProviderTokenInput = {
  roomId: string;
  userId: string;
};

export function selectedCallProvider() {
  return env.CALL_PROVIDER;
}

export function generateCallProviderToken(input: CallProviderTokenInput) {
  if (env.CALL_PROVIDER !== "zegocloud") {
    throw new Error(`Call provider "${env.CALL_PROVIDER}" is disabled for this token endpoint.`);
  }
  if (!env.ZEGO_APP_ID || !env.ZEGO_SERVER_SECRET) {
    throw new Error("ZEGOCLOUD calling credentials are missing.");
  }
  return generateZegoToken04({
    appId: env.ZEGO_APP_ID,
    userId: input.userId,
    serverSecret: env.ZEGO_SERVER_SECRET,
    effectiveTimeInSeconds: env.ZEGO_TOKEN_EXPIRE_SECONDS,
    payload: {
      room_id: input.roomId,
      privilege: { 1: 1, 2: 1 },
      stream_id_list: null,
    },
  });
}
