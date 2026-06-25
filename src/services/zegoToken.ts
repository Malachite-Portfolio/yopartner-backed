import { createCipheriv, randomBytes } from "node:crypto";

type ZegoTokenPayload = {
  room_id: string;
  privilege: {
    1: 0 | 1;
    2: 0 | 1;
  };
  stream_id_list: string[] | null;
};

function writeUInt64BE(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function writeUInt16BE(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

export function generateZegoToken04(input: {
  appId: number;
  userId: string;
  serverSecret: string;
  effectiveTimeInSeconds: number;
  payload: ZegoTokenPayload;
}) {
  if (!Number.isInteger(input.appId) || input.appId <= 0) throw new Error("ZEGO App ID is invalid.");
  if (!input.userId) throw new Error("ZEGO user ID is required.");
  if (Buffer.byteLength(input.serverSecret) !== 32) throw new Error("ZEGO server secret must be 32 bytes.");
  if (!Number.isInteger(input.effectiveTimeInSeconds) || input.effectiveTimeInSeconds <= 0) {
    throw new Error("ZEGO token expiry is invalid.");
  }

  const createTime = Math.floor(Date.now() / 1000);
  const expire = createTime + input.effectiveTimeInSeconds;
  const tokenInfo = {
    app_id: input.appId,
    user_id: input.userId,
    nonce: randomBytes(4).readInt32BE(0),
    ctime: createTime,
    expire,
    payload: JSON.stringify(input.payload),
  };
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(input.serverSecret), iv);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokenInfo)), cipher.final()]);
  const tokenBuffer = Buffer.concat([
    writeUInt64BE(expire),
    writeUInt16BE(iv.length),
    iv,
    writeUInt16BE(encrypted.length),
    encrypted,
  ]);
  return {
    token: `04${tokenBuffer.toString("base64")}`,
    expiresAt: expire,
  };
}
