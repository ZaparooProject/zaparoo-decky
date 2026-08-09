import type { CoreNotification, DatabaseStatus } from "./types";
import { isRecord, parseDatabaseStatus } from "./validation";

const STATUS_INVALIDATION_METHODS = new Set([
  "auth.link.status",
  "backup.state",
  "clients.paired",
  "inbox.added",
  "media.started",
  "media.stopped",
  "profiles.active",
  "profiles.data",
  "readers.added",
  "readers.removed",
  "tokens.added",
  "tokens.removed",
  "ui.changed",
]);

export function indexingStatusFromNotification(
  notification: CoreNotification,
): DatabaseStatus | undefined {
  if (notification.method !== "media.indexing" || !isRecord(notification.params)) return undefined;

  return parseDatabaseStatus(notification.params);
}

export function notificationInvalidatesStatus(notification: CoreNotification): boolean {
  return STATUS_INVALIDATION_METHODS.has(notification.method);
}
