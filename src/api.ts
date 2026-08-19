import { addEventListener, callable, removeEventListener } from "@decky/api";
import type {
  BootstrapProgress,
  BootstrapStatus,
  ClientPairing,
  CoreNotification,
  LogUpload,
  OnlineLink,
  OnlineSettingsUpdate,
  PluginStatus,
  ReaderSettingsUpdate,
} from "./types";
import {
  normalizeBootstrapProgress,
  normalizeBootstrapStatus,
  normalizeClientPairing,
  normalizeCoreNotification,
  normalizeLogUpload,
  normalizeOnlineLink,
  normalizePluginStatus,
} from "./validation";

const getStatusCall = callable<[], unknown>("get_status");
const getBootstrapStatusCall = callable<[], unknown>("get_bootstrap_status");
const startClientPairingCall = callable<[secure: boolean], unknown>("start_client_pairing");
const uploadLogsCall = callable<[], unknown>("upload_logs");
const startOnlineLinkCall = callable<[], unknown>("start_online_link");
const getOnlineLinkStatusCall = callable<[workflowId: number], unknown>("get_online_link_status");

export async function getStatus(): Promise<PluginStatus> {
  return normalizePluginStatus(await getStatusCall());
}
export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  return normalizeBootstrapStatus(await getBootstrapStatusCall());
}
export const installCore = callable<[], unknown>("install_core");
export const startCore = callable<[], unknown>("start_core");
export const stopMedia = callable<[], void>("stop_media");
export const writeTag = callable<[text: string, readerId?: string], void>("write_tag");
export const cancelWrite = callable<[readerId?: string], void>("cancel_write");
export const securityPromptDismissed = callable<[], boolean>("security_prompt_dismissed");
export const dismissSecurityPrompt = callable<[], void>("dismiss_security_prompt");
export async function startClientPairing(secure: boolean): Promise<ClientPairing> {
  return normalizeClientPairing(await startClientPairingCall(secure));
}
export const claimClientPairing = callable<[workflowId: number], void>("claim_client_pairing");
export const cancelClientPairing = callable<[workflowId: number], void>("cancel_client_pairing");
export const completeClientPairing = callable<[workflowId: number], void>("complete_client_pairing");
export const expireClientPairing = callable<[workflowId: number], void>("expire_client_pairing");
export async function uploadLogs(): Promise<LogUpload> {
  return normalizeLogUpload(await uploadLogsCall());
}
export async function startOnlineLink(): Promise<OnlineLink> {
  return normalizeOnlineLink(await startOnlineLinkCall());
}
export async function getOnlineLinkStatus(workflowId: number): Promise<OnlineLink> {
  return normalizeOnlineLink(await getOnlineLinkStatusCall(workflowId));
}
export const claimOnlineLink = callable<[workflowId: number], void>("claim_online_link");
export const cancelOnlineLink = callable<[workflowId: number], void>("cancel_online_link");
export const unlinkOnline = callable<[], void>("unlink_online");
export const dismissInboxMessage = callable<[messageId: number], void>("dismiss_inbox_message");
export const updateOnlineSettings = callable<[params: OnlineSettingsUpdate], void>(
  "update_online_settings",
);
export const updateReaderSettings = callable<[params: ReaderSettingsUpdate], void>("update_reader_settings");
export const updateMediaDatabase = callable<[], void>("update_media_database");
export const cancelMediaDatabaseUpdate = callable<[], void>("cancel_media_database_update");
export const resumeMediaDatabaseUpdate = callable<[], void>("resume_media_database_update");

const CORE_NOTIFICATION_EVENT = "core_notification";
const CORE_CONNECTION_EVENT = "core_connection";
const BOOTSTRAP_PROGRESS_EVENT = "bootstrap_progress";

export function subscribeCoreNotifications(listener: (notification: CoreNotification) => void): () => void {
  const registered = addEventListener<[unknown]>(CORE_NOTIFICATION_EVENT, (value) => {
    const notification = normalizeCoreNotification(value);
    if (notification !== undefined) listener(notification);
  });
  return () => removeEventListener(CORE_NOTIFICATION_EVENT, registered);
}

export function subscribeCoreConnection(listener: (connected: boolean) => void): () => void {
  const registered = addEventListener<[unknown]>(CORE_CONNECTION_EVENT, (value) => {
    if (typeof value === "boolean") listener(value);
  });
  return () => removeEventListener(CORE_CONNECTION_EVENT, registered);
}

export function subscribeBootstrapProgress(
  listener: (progress: BootstrapProgress) => void,
): () => void {
  const registered = addEventListener<[unknown]>(BOOTSTRAP_PROGRESS_EVENT, (value) => {
    try {
      listener(normalizeBootstrapProgress(value));
    } catch (error) {
      console.error("Ignored invalid Zaparoo bootstrap progress", error);
    }
  });
  return () => removeEventListener(BOOTSTRAP_PROGRESS_EVENT, registered);
}
