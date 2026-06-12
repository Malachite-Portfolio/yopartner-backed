import { CompanionAvailability, type Companion } from "@prisma/client";

const PARTNER_PRESENCE_STALE_MS = 90 * 1000;

type AvailabilityCompanion = Pick<
  Companion,
  "availability" | "availabilitySetByAdminAt" | "updatedAt"
>;

export function resolveCompanionAvailability(
  companion: AvailabilityCompanion,
  hasActiveSession = false,
) {
  if (companion.availability === CompanionAvailability.OFFLINE) {
    return CompanionAvailability.OFFLINE;
  }
  if (companion.availability === CompanionAvailability.BUSY || hasActiveSession) {
    return CompanionAvailability.BUSY;
  }

  const presenceFresh =
    Boolean(companion.availabilitySetByAdminAt) ||
    Date.now() - companion.updatedAt.getTime() <= PARTNER_PRESENCE_STALE_MS;
  return presenceFresh ? CompanionAvailability.ONLINE : CompanionAvailability.OFFLINE;
}

export function isCompanionOnlineForRequests(companion: AvailabilityCompanion) {
  return resolveCompanionAvailability(companion) === CompanionAvailability.ONLINE;
}

export function isCompanionListedOnline(
  companion: AvailabilityCompanion,
  hasActiveSession = false,
) {
  return resolveCompanionAvailability(companion, hasActiveSession) !== CompanionAvailability.OFFLINE;
}
