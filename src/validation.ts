import type {
  ActiveMedia,
  BackupStatus,
  BootstrapProgress,
  BootstrapStatus,
  ClientPairing,
  CoreNotification,
  CoreSettings,
  DatabaseStatus,
  InboxMessage,
  OnlineLink,
  PairedClient,
  PluginStatus,
  ReaderInfo,
  RemoteBackupStatus,
  TokenInfo,
  VersionInfo,
} from "./types";

const MAX_COLLECTION_ITEMS = 512;
const MAX_SHORT_TEXT_LENGTH = 4_096;
const MAX_BODY_LENGTH = 65_536;
const MAX_ZAP_SCRIPT_LENGTH = 65_536;
const BOOTSTRAP_PHASES = new Set<BootstrapProgress["phase"]>([
  "idle",
  "checking",
  "downloading",
  "verifying",
  "installing",
  "service",
  "starting",
  "complete",
  "failed",
]);
const BOOTSTRAP_ACTIONS = new Set<BootstrapStatus["action"]>([
  "none",
  "install",
  "start",
  "unsupported",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = MAX_SHORT_TEXT_LENGTH): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function requiredBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength = MAX_SHORT_TEXT_LENGTH,
): string | undefined | null {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return stringValue(value, maxLength) ?? null;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined | null {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return nonNegativeNumber(value) ?? null;
}

function parseArray<T>(
  value: unknown,
  parser: (item: unknown) => T | undefined,
  maxItems = MAX_COLLECTION_ITEMS,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const parsed: T[] = [];
  for (const item of value) {
    const result = parser(item);
    if (result === undefined) return undefined;
    parsed.push(result);
  }
  return parsed;
}

function parseStringArray(value: unknown, maxItems = 64): string[] | undefined {
  return parseArray(value, (item) => stringValue(item, 256), maxItems);
}

function parseVersion(value: unknown): VersionInfo | undefined {
  if (!isRecord(value)) return undefined;
  const version = stringValue(value.version, 128);
  const platform = stringValue(value.platform, 128);
  return version !== undefined && platform !== undefined ? { version, platform } : undefined;
}

function parseReader(value: unknown): ReaderInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id, 1_024);
  const readerId = stringValue(value.readerId, 256);
  const driver = stringValue(value.driver, 256);
  const info = stringValue(value.info, 1_024);
  const capabilities = parseStringArray(value.capabilities, 32);
  const connected = requiredBoolean(value.connected);
  if (
    id === undefined ||
    readerId === undefined ||
    driver === undefined ||
    info === undefined ||
    capabilities === undefined ||
    connected === undefined
  ) {
    return undefined;
  }
  return { id, readerId, driver, info, capabilities, connected };
}

function parseToken(value: unknown): TokenInfo | undefined {
  if (!isRecord(value)) return undefined;
  const scanTime = stringValue(value.scanTime, 128);
  const type = stringValue(value.type, 256);
  const uid = stringValue(value.uid, 4_096);
  const text = stringValue(value.text, MAX_ZAP_SCRIPT_LENGTH);
  const data = stringValue(value.data, MAX_BODY_LENGTH);
  const readerId = optionalString(value, "readerId", 256);
  if (
    scanTime === undefined ||
    type === undefined ||
    uid === undefined ||
    text === undefined ||
    data === undefined ||
    readerId === null
  ) {
    return undefined;
  }
  return { scanTime, type, uid, text, data, ...(readerId === undefined ? {} : { readerId }) };
}

export function parseDatabaseStatus(value: unknown): DatabaseStatus | undefined {
  if (!isRecord(value)) return undefined;
  const exists = requiredBoolean(value.exists);
  const indexing = requiredBoolean(value.indexing);
  const optimizing = requiredBoolean(value.optimizing);
  const paused = requiredBoolean(value.paused);
  const throttled = value.throttled === undefined ? undefined : requiredBoolean(value.throttled);
  const totalFiles = optionalNumber(value, "totalFiles");
  const totalMedia = optionalNumber(value, "totalMedia");
  const totalSteps = optionalNumber(value, "totalSteps");
  const currentStep = optionalNumber(value, "currentStep");
  const currentStepDisplay = optionalString(value, "currentStepDisplay");
  if (
    exists === undefined ||
    indexing === undefined ||
    optimizing === undefined ||
    paused === undefined ||
    (value.throttled !== undefined && throttled === undefined) ||
    totalFiles === null ||
    totalMedia === null ||
    totalSteps === null ||
    currentStep === null ||
    currentStepDisplay === null
  ) {
    return undefined;
  }
  return {
    exists,
    indexing,
    optimizing,
    paused,
    ...(throttled === undefined ? {} : { throttled }),
    ...(totalFiles === undefined ? {} : { totalFiles }),
    ...(totalMedia === undefined ? {} : { totalMedia }),
    ...(totalSteps === undefined ? {} : { totalSteps }),
    ...(currentStep === undefined ? {} : { currentStep }),
    ...(currentStepDisplay === undefined ? {} : { currentStepDisplay }),
  };
}

function parseActiveMedia(value: unknown): ActiveMedia | undefined {
  if (!isRecord(value)) return undefined;
  const zapScript = stringValue(value.zapScript, MAX_ZAP_SCRIPT_LENGTH);
  const systemId = stringValue(value.systemId);
  const systemName = stringValue(value.systemName);
  const mediaName = stringValue(value.mediaName);
  const mediaPath = stringValue(value.mediaPath, MAX_BODY_LENGTH);
  const slot = optionalString(value, "slot", 128);
  if (
    zapScript === undefined ||
    systemId === undefined ||
    systemName === undefined ||
    mediaName === undefined ||
    mediaPath === undefined ||
    slot === null
  ) {
    return undefined;
  }
  return {
    zapScript,
    systemId,
    systemName,
    mediaName,
    mediaPath,
    ...(slot === undefined ? {} : { slot }),
  };
}

function parseSettings(value: unknown): CoreSettings | undefined {
  if (!isRecord(value)) return undefined;
  const audioScanFeedback = requiredBoolean(value.audioScanFeedback);
  const encryption = requiredBoolean(value.encryption);
  const readersAutoDetect = requiredBoolean(value.readersAutoDetect);
  const readersScanExitDelay = nonNegativeNumber(value.readersScanExitDelay);
  const readersScanMode = value.readersScanMode;
  const playtimeSyncEnabled =
    value.playtimeSyncEnabled === undefined ? undefined : requiredBoolean(value.playtimeSyncEnabled);
  const backupRemoteEnabled =
    value.backupRemoteEnabled === undefined ? undefined : requiredBoolean(value.backupRemoteEnabled);
  const backupRemoteSchedule = value.backupRemoteSchedule;
  if (
    audioScanFeedback === undefined ||
    encryption === undefined ||
    readersAutoDetect === undefined ||
    readersScanExitDelay === undefined ||
    (readersScanMode !== "tap" && readersScanMode !== "hold") ||
    (value.playtimeSyncEnabled !== undefined && playtimeSyncEnabled === undefined) ||
    (value.backupRemoteEnabled !== undefined && backupRemoteEnabled === undefined) ||
    (backupRemoteSchedule !== undefined &&
      backupRemoteSchedule !== "daily" &&
      backupRemoteSchedule !== "weekly" &&
      backupRemoteSchedule !== "manual")
  ) {
    return undefined;
  }
  return {
    audioScanFeedback,
    encryption,
    readersAutoDetect,
    readersScanExitDelay,
    readersScanMode,
    ...(playtimeSyncEnabled === undefined ? {} : { playtimeSyncEnabled }),
    ...(backupRemoteEnabled === undefined ? {} : { backupRemoteEnabled }),
    ...(backupRemoteSchedule === undefined ? {} : { backupRemoteSchedule }),
  };
}

function parseClient(value: unknown): PairedClient | undefined {
  if (!isRecord(value)) return undefined;
  const clientId = stringValue(value.clientId, 512);
  const clientName = stringValue(value.clientName, 1_024);
  const role = value.role;
  const createdAt = nonNegativeNumber(value.createdAt);
  const lastSeenAt = nonNegativeNumber(value.lastSeenAt);
  if (
    clientId === undefined ||
    clientName === undefined ||
    (role !== "admin" && role !== "member") ||
    createdAt === undefined ||
    lastSeenAt === undefined
  ) {
    return undefined;
  }
  return { clientId, clientName, role, createdAt, lastSeenAt };
}

function parseRemoteBackup(value: unknown): RemoteBackupStatus | undefined {
  if (!isRecord(value)) return undefined;
  const availabilityValue = value.availability ?? "unknown";
  const availability =
    availabilityValue === "available" ||
    availabilityValue === "unavailable" ||
    availabilityValue === "unknown"
      ? availabilityValue
      : undefined;
  const deviceName = optionalString(value, "deviceName", 1_024);
  const linkedAt = optionalString(value, "linkedAt", 128);
  const schedule = optionalString(value, "schedule", 128);
  const lastStatus = stringValue(value.lastStatus, 128);
  const linked = value.linked === undefined ? false : requiredBoolean(value.linked);
  const enabled = requiredBoolean(value.enabled);
  if (
    availability === undefined ||
    deviceName === null ||
    linkedAt === null ||
    schedule === null ||
    lastStatus === undefined ||
    linked === undefined ||
    enabled === undefined
  ) {
    return undefined;
  }
  return {
    availability,
    lastStatus,
    linked,
    enabled,
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(linkedAt === undefined ? {} : { linkedAt }),
    ...(schedule === undefined ? {} : { schedule }),
  };
}

function parseBackup(value: unknown): BackupStatus | undefined {
  if (!isRecord(value)) return undefined;
  const remote = parseRemoteBackup(value.remote);
  const activeOperation = optionalString(value, "activeOperation", 128);
  if (remote === undefined || activeOperation === null) return undefined;
  return { remote, ...(activeOperation === undefined ? {} : { activeOperation }) };
}

function parseInboxMessage(value: unknown): InboxMessage | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonNegativeNumber(value.id);
  const title = stringValue(value.title);
  const body = optionalString(value, "body", MAX_BODY_LENGTH);
  const severity = value.severity;
  const category = optionalString(value, "category", 256);
  const profileId = optionalNumber(value, "profileId");
  const createdAt = stringValue(value.createdAt, 128);
  if (
    id === undefined ||
    !Number.isInteger(id) ||
    id <= 0 ||
    title === undefined ||
    body === null ||
    (severity !== 0 && severity !== 1 && severity !== 2) ||
    category === null ||
    profileId === null ||
    createdAt === undefined
  ) {
    return undefined;
  }
  return {
    id,
    title,
    severity,
    createdAt,
    ...(body === undefined ? {} : { body }),
    ...(category === undefined ? {} : { category }),
    ...(profileId === undefined ? {} : { profileId }),
  };
}

function parseErrors(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const errors: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    const message = stringValue(item);
    if (message !== undefined) errors[key] = message;
  }
  return errors;
}

export function normalizeBootstrapProgress(value: unknown): BootstrapProgress {
  if (!isRecord(value)) throw new Error("Decky backend returned invalid bootstrap progress");
  const phase = value.phase;
  const busy = requiredBoolean(value.busy);
  const message = stringValue(value.message);
  const error = optionalString(value, "error");
  const version = optionalString(value, "version", 128);
  if (
    typeof phase !== "string" ||
    !BOOTSTRAP_PHASES.has(phase as BootstrapProgress["phase"]) ||
    busy === undefined ||
    message === undefined ||
    error === null ||
    version === null
  ) {
    throw new Error("Decky backend returned invalid bootstrap progress");
  }
  return {
    phase: phase as BootstrapProgress["phase"],
    busy,
    message,
    ...(error === undefined ? {} : { error }),
    ...(version === undefined ? {} : { version }),
  };
}

export function normalizeBootstrapStatus(value: unknown): BootstrapStatus {
  if (!isRecord(value)) throw new Error("Decky backend returned invalid bootstrap status");
  const supported = requiredBoolean(value.supported);
  const connected = requiredBoolean(value.connected);
  const binaryInstalled = requiredBoolean(value.binaryInstalled);
  const serviceInstalled = requiredBoolean(value.serviceInstalled);
  const serviceActive = requiredBoolean(value.serviceActive);
  const action = value.action;
  const reason = optionalString(value, "reason");
  const version = value.version === undefined ? undefined : parseVersion(value.version);
  let progress: BootstrapProgress;
  try {
    progress = normalizeBootstrapProgress(value.progress);
  } catch {
    throw new Error("Decky backend returned invalid bootstrap status");
  }
  if (
    supported === undefined ||
    connected === undefined ||
    binaryInstalled === undefined ||
    serviceInstalled === undefined ||
    serviceActive === undefined ||
    typeof action !== "string" ||
    !BOOTSTRAP_ACTIONS.has(action as BootstrapStatus["action"]) ||
    reason === null ||
    (value.version !== undefined && version === undefined)
  ) {
    throw new Error("Decky backend returned invalid bootstrap status");
  }
  return {
    supported,
    connected,
    binaryInstalled,
    serviceInstalled,
    serviceActive,
    action: action as BootstrapStatus["action"],
    progress,
    ...(reason === undefined ? {} : { reason }),
    ...(version === undefined ? {} : { version }),
  };
}

export function normalizePluginStatus(value: unknown): PluginStatus {
  if (!isRecord(value) || value.connected !== true) {
    const error = isRecord(value) ? stringValue(value.error) : undefined;
    return { connected: false, error: error ?? "Invalid response from Decky backend" };
  }

  const version = parseVersion(value.version);
  if (version === undefined) {
    return { connected: false, error: "Core returned invalid version information" };
  }

  const errors = parseErrors(value.errors);
  const status: PluginStatus = { connected: true, version, errors };
  const sections: Array<[
    keyof Pick<PluginStatus, "readers" | "tokens" | "media" | "settings" | "clients" | "backup" | "inbox">,
    (section: unknown) => unknown,
  ]> = [
    ["readers", (section) => {
      if (!isRecord(section)) return undefined;
      const readers = parseArray(section.readers, parseReader, 64);
      return readers === undefined ? undefined : { readers };
    }],
    ["tokens", (section) => {
      if (!isRecord(section)) return undefined;
      const active = parseArray(section.active, parseToken, 64);
      const last = section.last === undefined || section.last === null ? undefined : parseToken(section.last);
      if (active === undefined || (section.last !== undefined && section.last !== null && last === undefined)) {
        return undefined;
      }
      return { active, ...(last === undefined ? {} : { last }) };
    }],
    ["media", (section) => {
      if (!isRecord(section)) return undefined;
      const database = parseDatabaseStatus(section.database);
      const active = parseArray(section.active, parseActiveMedia, 32);
      return database === undefined || active === undefined ? undefined : { database, active };
    }],
    ["settings", parseSettings],
    ["clients", (section) => {
      if (!isRecord(section)) return undefined;
      const clients = parseArray(section.clients, parseClient, 512);
      return clients === undefined ? undefined : { clients };
    }],
    ["backup", parseBackup],
    ["inbox", (section) => {
      if (!isRecord(section)) return undefined;
      const messages = parseArray(section.messages, parseInboxMessage, 512);
      return messages === undefined ? undefined : { messages };
    }],
  ];

  for (const [key, parser] of sections) {
    if (value[key] === undefined) {
      errors[key] ??= `Core ${key} status is unavailable`;
      continue;
    }
    const parsed = parser(value[key]);
    if (parsed === undefined) {
      errors[key] = `Core returned invalid ${key} status`;
      continue;
    }
    Object.assign(status, { [key]: parsed });
  }
  return status;
}

export function normalizeClientPairing(value: unknown): ClientPairing {
  if (!isRecord(value)) throw new Error("Core returned invalid client pairing details");
  const pin = stringValue(value.pin, 64);
  const expiresAt = nonNegativeNumber(value.expiresAt);
  if (pin === undefined || expiresAt === undefined) {
    throw new Error("Core returned invalid client pairing details");
  }
  return { pin, expiresAt };
}

function webURL(value: unknown): string | undefined {
  const candidate = stringValue(value, 4_096);
  if (candidate === undefined) return undefined;
  try {
    const protocol = new URL(candidate).protocol;
    return protocol === "https:" || protocol === "http:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeOnlineLink(value: unknown): OnlineLink {
  if (!isRecord(value)) throw new Error("Core returned invalid Online link details");
  const status = value.status;
  if (
    status !== "none" &&
    status !== "pending" &&
    status !== "approved" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new Error("Core returned invalid Online link details");
  }
  const userCode = optionalString(value, "userCode", 64);
  const verificationUrl = value.verificationUrl === undefined ? undefined : webURL(value.verificationUrl);
  const verificationUrlComplete =
    value.verificationUrlComplete === undefined ? undefined : webURL(value.verificationUrlComplete);
  const expiresAt = optionalString(value, "expiresAt", 128);
  const error = optionalString(value, "error");
  if (
    userCode === null ||
    (value.verificationUrl !== undefined && verificationUrl === undefined) ||
    (value.verificationUrlComplete !== undefined && verificationUrlComplete === undefined) ||
    expiresAt === null ||
    (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) ||
    error === null
  ) {
    throw new Error("Core returned invalid Online link details");
  }
  return {
    status,
    ...(userCode === undefined ? {} : { userCode }),
    ...(verificationUrl === undefined ? {} : { verificationUrl }),
    ...(verificationUrlComplete === undefined ? {} : { verificationUrlComplete }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(error === undefined ? {} : { error }),
  };
}

export function normalizeCoreNotification(value: unknown): CoreNotification | undefined {
  if (!isRecord(value)) return undefined;
  const method = stringValue(value.method, 256);
  const jsonrpc = optionalString(value, "jsonrpc", 16);
  if (method === undefined || jsonrpc === null) return undefined;
  return {
    method,
    ...(jsonrpc === undefined ? {} : { jsonrpc }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}
