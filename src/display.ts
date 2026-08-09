import type { DatabaseStatus, InboxMessage, RemoteBackupStatus, TokenInfo } from "./types";

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
