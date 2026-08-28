import type { DatabaseStatus, InboxMessage, RemoteBackupStatus, TokenInfo, UpdateStatus } from "./types";

export function readerCountLabel(count: number): string {
  if (count === 0) return "None connected";
  if (count === 1) return "1 connected";
  return `${count} connected`;
}

export function formatPairingPIN(pin: string): string {
  return /^\d{6}$/.test(pin) ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

export function pairingCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil(expiresAt - now / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function inboxSeverityLabel(severity: InboxMessage["severity"]): string {
  if (severity === 2) return "Error";
  if (severity === 1) return "Warning";
  return "Info";
}

export function onlineAccountLabel(remote?: RemoteBackupStatus, unavailable = false): string {
  if (unavailable) return "Unavailable";
  if (!remote?.linked) return "Not linked";
  return remote.deviceName ? `Linked as ${remote.deviceName}` : "Linked";
}

export function databaseStatusLabel(database?: DatabaseStatus): string {
  if (database?.paused) return "Paused";
  if (database?.optimizing) return "Optimizing (ready to use)";
  if (database?.indexing) return "Updating";
  if (database?.exists) return "Ready";
  return "Not ready";
}

export function databaseProgressPercent(database?: DatabaseStatus): number | undefined {
  if (
    database?.currentStep === undefined ||
    database.totalSteps === undefined ||
    database.totalSteps <= 0
  ) {
    return undefined;
  }
  return Math.round(Math.min(1, Math.max(0, database.currentStep / database.totalSteps)) * 100);
}

export function databaseProgressLabel(database?: DatabaseStatus): string | undefined {
  const percent = databaseProgressPercent(database);
  if (percent === undefined || database?.currentStep === undefined || database.totalSteps === undefined) {
    return undefined;
  }
  return `${database.currentStep} of ${database.totalSteps} (${percent}%)`;
}

export function lastScannedID(token?: TokenInfo): string | undefined {
  if (!token?.uid || token.uid === "__api__" || token.uid === token.text) return undefined;
  return token.uid;
}

// updateStatusLabel is the line shown beside the Core version.
//
// Ordered by what already happened to the device: an update that failed and was
// undone matters more than one that is waiting, which matters more than one
// merely available. A successful update says nothing, because the version shown
// next to it is already the announcement.
export function updateStatusLabel(update?: UpdateStatus): string {
  if (!update) return "Unknown";

  if (update.eligibility === "development") return "Development build";
  if (update.eligibility === "managed") return "Managed externally";
  if (update.eligibility === "unsupported") return "Not supported here";

  switch (update.lastResult?.outcome) {
    case "rolledBack":
      return `Update to ${update.lastResult.toVersion ?? "a new version"} was rolled back`;
    case "rollbackBlocked":
      return "Update failed and could not be undone";
    case "recoveryRequired":
      return "An interrupted update needs attention";
  }

  if (update.updateAvailable) {
    if (update.blockedBy) return `${update.latestVersion} available - ${update.blockedBy.message}`;
    if (update.rolloutHeld) return `${update.latestVersion} available, rolling out gradually`;
    return `${update.latestVersion} available`;
  }
  return update.autoInstall ? "Up to date, installs automatically" : "Up to date";
}

// updateActionLabel names the button. Core only installs on its own when the
// owner turned that on, so the button is the ordinary way an update happens and
// should say which of the two things it is about to do.
export function updateActionLabel(update?: UpdateStatus): string {
  return update?.updateAvailable ? "Install Update" : "Check for Updates";
}

// updateActionDisabled reports whether the button can do anything at all.
export function updateActionDisabled(update?: UpdateStatus): boolean {
  if (!update) return true;
  if (["development", "managed", "unsupported"].includes(update.eligibility ?? "")) return true;
  return Boolean(update.updateAvailable && update.blockedBy && !update.blockedBy.forceable);
}
