import { ServiceType } from "@prisma/client";

export const CHAT_RATE_PER_MESSAGE = 2.5;
export const CHAT_RATE_PER_MIN = CHAT_RATE_PER_MESSAGE;
export const AUDIO_RATE_PER_MIN = 18;
export const VIDEO_RATE_PER_MIN = 24;
export const HOME_VISIT_RATE_PER_HOUR = 2000;

export const WALLET_PLANS = [
  { pay: 49, get: 75 },
  { pay: 149, get: 200 },
  { pay: 249, get: 350 },
  { pay: 399, get: 525 },
  { pay: 499, get: 650 },
  { pay: 1999, get: 2500 },
] as const;

export function getFixedSessionRate(serviceType: ServiceType) {
  if (serviceType === ServiceType.CHAT) return CHAT_RATE_PER_MIN;
  if (serviceType === ServiceType.AUDIO) return AUDIO_RATE_PER_MIN;
  return VIDEO_RATE_PER_MIN;
}
