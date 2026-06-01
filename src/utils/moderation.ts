import { Companion, PartnerModerationStatus, User, UserModerationStatus } from "@prisma/client";
import { HttpError } from "./http";

type TemporaryStatus = "RESTRICTED" | "TEMP_BANNED";
type TemporaryPartnerStatus = "RESTRICTED" | "TEMP_BANNED";

function isPast(date: Date | null | undefined) {
  return Boolean(date && date.getTime() <= Date.now());
}

export function resolveUserModerationStatus(user: Pick<User, "moderationStatus" | "moderationExpiresAt">) {
  const status = user.moderationStatus;
  if ((status === UserModerationStatus.RESTRICTED || status === UserModerationStatus.TEMP_BANNED) && isPast(user.moderationExpiresAt)) {
    return UserModerationStatus.ACTIVE;
  }
  return status;
}

export function resolvePartnerModerationStatus(
  companion: Pick<Companion, "moderationStatus" | "moderationExpiresAt">,
) {
  const status = companion.moderationStatus;
  if ((status === PartnerModerationStatus.RESTRICTED || status === PartnerModerationStatus.TEMP_BANNED) && isPast(companion.moderationExpiresAt)) {
    return PartnerModerationStatus.ACTIVE;
  }
  return status;
}

export function parseTemporaryExpiry(input: unknown) {
  if (!input) return null;
  const date = input instanceof Date ? input : new Date(String(input));
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "expiresAt must be a valid datetime.");
  }
  return date;
}

export function assertUserCanStartSession(user: Pick<User, "moderationStatus" | "moderationExpiresAt">) {
  const status = resolveUserModerationStatus(user);
  if (status !== UserModerationStatus.ACTIVE) {
    throw new HttpError(403, "Your account is restricted from starting new sessions.");
  }
}

export function assertUserCanSendGifts(user: Pick<User, "moderationStatus" | "moderationExpiresAt">) {
  const status = resolveUserModerationStatus(user);
  if (status === UserModerationStatus.BANNED || status === UserModerationStatus.TEMP_BANNED) {
    throw new HttpError(403, "Your account is blocked from sending gifts.");
  }
}

export function assertUserCanAddMoney(user: Pick<User, "moderationStatus" | "moderationExpiresAt">) {
  const status = resolveUserModerationStatus(user);
  if (status === UserModerationStatus.BANNED || status === UserModerationStatus.TEMP_BANNED) {
    throw new HttpError(403, "Your account is blocked from wallet recharge.");
  }
}

export function assertPartnerCanReceiveRequests(
  companion: Pick<Companion, "moderationStatus" | "moderationExpiresAt">,
) {
  const status = resolvePartnerModerationStatus(companion);
  if (status !== PartnerModerationStatus.ACTIVE) {
    throw new HttpError(403, "Partner is not available for new requests.");
  }
}

export function assertPartnerDashboardAccess(
  companion: Pick<Companion, "moderationStatus" | "moderationExpiresAt"> | null,
) {
  if (!companion) return;
  const status = resolvePartnerModerationStatus(companion);
  if (status === PartnerModerationStatus.BANNED || status === PartnerModerationStatus.TEMP_BANNED) {
    throw new HttpError(403, "Partner dashboard is blocked for this account.");
  }
}

export function toUserBlocked(status: UserModerationStatus) {
  return status !== UserModerationStatus.ACTIVE;
}

export function toPartnerOffline(status: PartnerModerationStatus) {
  return status === PartnerModerationStatus.BANNED || status === PartnerModerationStatus.TEMP_BANNED;
}

export function isUserTemporaryStatus(status: UserModerationStatus): status is TemporaryStatus {
  return status === UserModerationStatus.RESTRICTED || status === UserModerationStatus.TEMP_BANNED;
}

export function isPartnerTemporaryStatus(status: PartnerModerationStatus): status is TemporaryPartnerStatus {
  return status === PartnerModerationStatus.RESTRICTED || status === PartnerModerationStatus.TEMP_BANNED;
}
