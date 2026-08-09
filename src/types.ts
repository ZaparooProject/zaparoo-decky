export interface VersionInfo {
  version: string;
  platform: string;
}

export interface ReaderInfo {
  id: string;
  readerId: string;
  driver: string;
  info: string;
  capabilities: string[];
  connected: boolean;
}

export interface TokenInfo {
  scanTime: string;
  type: string;
  uid: string;
  text: string;
  data: string;
  readerId?: string;
}

export interface ActiveMedia {
  zapScript: string;
  systemId: string;
  systemName: string;
  mediaName: string;
  mediaPath: string;
  slot?: string;
}

export interface DatabaseStatus {
  exists: boolean;
  indexing: boolean;
  optimizing: boolean;
  paused: boolean;
  throttled?: boolean;
  totalFiles?: number;
  totalMedia?: number;
  totalSteps?: number;
  currentStep?: number;
  currentStepDisplay?: string;
}

export interface InboxMessage {
  id: number;
  title: string;
  body?: string;
  severity: 0 | 1 | 2;
  category?: string;
  profileId?: number;
  createdAt: string;
}

export interface PairedClient {
  clientId: string;
  clientName: string;
  role: "admin" | "member";
  createdAt: number;
  lastSeenAt: number;
}

export interface ClientPairing {
  pin: string;
  expiresAt: number;
}

export interface OnlineLink {
  status: "none" | "pending" | "approved" | "failed" | "cancelled";
  userCode?: string;
  verificationUrl?: string;
  verificationUrlComplete?: string;
  expiresAt?: string;
  error?: string;
}

export interface RemoteBackupStatus {
  availability: "available" | "unavailable" | "unknown";
  deviceName?: string;
  linkedAt?: string;
  lastStatus: string;
  schedule?: string;
  linked: boolean;
  enabled: boolean;
}

export interface BackupStatus {
  activeOperation?: string;
  remote: RemoteBackupStatus;
}

export interface CoreSettings {
  audioScanFeedback: boolean;
  encryption: boolean;
  playtimeSyncEnabled?: boolean;
  backupRemoteEnabled?: boolean;
  backupRemoteSchedule?: "daily" | "weekly" | "manual";
  readersAutoDetect: boolean;
  readersScanExitDelay: number;
  readersScanMode: "tap" | "hold";
}

export type OnlineSettingsUpdate = Partial<
  Pick<CoreSettings, "backupRemoteEnabled" | "backupRemoteSchedule" | "playtimeSyncEnabled">
>;

export type ReaderSettingsUpdate = Partial<
  Pick<
    CoreSettings,
    "audioScanFeedback" | "readersAutoDetect" | "readersScanExitDelay" | "readersScanMode"
  >
>;

export interface CoreNotification {
  jsonrpc?: string;
  method: string;
  params?: unknown;
}

export type BootstrapPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "installing"
  | "service"
  | "starting"
  | "complete"
  | "failed";

export interface BootstrapProgress {
  phase: BootstrapPhase;
  busy: boolean;
  message: string;
  error?: string;
  version?: string;
}

export interface BootstrapStatus {
  supported: boolean;
  connected: boolean;
  binaryInstalled: boolean;
  serviceInstalled: boolean;
  serviceActive: boolean;
  action: "none" | "install" | "start" | "unsupported";
  reason?: string;
  version?: VersionInfo;
  progress: BootstrapProgress;
}

export interface PluginStatus {
  connected: boolean;
  error?: string;
  version?: VersionInfo;
  readers?: { readers: ReaderInfo[] };
  tokens?: { active: TokenInfo[]; last?: TokenInfo };
  media?: { database: DatabaseStatus; active: ActiveMedia[] };
  settings?: CoreSettings;
  clients?: { clients: PairedClient[] };
  backup?: BackupStatus;
  inbox?: { messages: InboxMessage[] };
  errors?: Record<string, string>;
}
