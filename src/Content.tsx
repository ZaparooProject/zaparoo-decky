import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  Navigation,
  PanelSection,
  Router,
  PanelSectionRow,
  showModal,
  ToggleField,
} from "@decky/ui";
import { toaster, useQuickAccessVisible } from "@decky/api";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelClientPairing,
  cancelMediaDatabaseUpdate,
  cancelOnlineLink,
  cancelWrite,
  dismissInboxMessage,
  dismissSecurityPrompt,
  getBootstrapStatus,
  getOnlineLinkStatus,
  getStatus,
  installCore,
  resumeMediaDatabaseUpdate,
  setEncryption,
  securityPromptDismissed,
  startClientPairing,
  startCore,
  startOnlineLink,
  stopMedia,
  subscribeBootstrapProgress,
  subscribeCoreConnection,
  subscribeCoreNotifications,
  unlinkOnline,
  updateMediaDatabase,
  updateOnlineSettings,
  updateReaderSettings,
  writeTag,
} from "./api";
import { coreCompatibility, MINIMUM_CORE_VERSION } from "./compatibility";
import {
  databaseProgressLabel,
  databaseProgressPercent,
  databaseStatusLabel,
  formatPairingPIN,
  inboxSeverityLabel,
  lastScannedID,
  onlineAccountLabel,
  pairingCountdown,
  readerCountLabel,
} from "./display";
import { indexingStatusFromNotification, notificationInvalidatesStatus } from "./notifications";
import { hasNewClient } from "./pairing";
import {
  isNonSteamGameID,
  steamGameFromValues,
  steamGamePageAppID,
  steamMediaValue,
} from "./steam";
import type {
  BootstrapStatus,
  ClientPairing,
  InboxMessage,
  OnlineLink,
  OnlineSettingsUpdate,
  PluginStatus,
  ReaderInfo,
  ReaderSettingsUpdate,
} from "./types";

const CONNECTED_RECONCILE_MS = 30_000;
const DISCONNECTED_POLL_MS = 5_000;
const NOTIFICATION_REFRESH_DELAY_MS = 100;
let securityPromptDeferred = false;

const BACKUP_SCHEDULE_OPTIONS = [
  { data: "daily", label: "Daily" },
  { data: "weekly", label: "Weekly" },
  { data: "manual", label: "Manual only" },
];

function ClientPairingDialog({
  pairing,
  initialClientIDs,
  revertEncryptionOnFailure,
  onFinished,
}: {
  pairing: ClientPairing;
  initialClientIDs: ReadonlySet<string>;
  revertEncryptionOnFailure: boolean;
  onFinished: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const resolved = useRef(false);

  const finish = useCallback(async (paired: boolean, cancelApproval: boolean) => {
    if (resolved.current) return;
    resolved.current = true;
    if (cancelApproval) {
      try {
        await cancelClientPairing();
      } catch (error) {
        console.error("Could not cancel Zaparoo client pairing", error);
      }
    }
    if (!paired && revertEncryptionOnFailure) {
      try {
        await setEncryption(false);
      } catch (error) {
        console.error("Could not restore Zaparoo encryption setting", error);
      }
    }
    onFinished();
  }, [onFinished, revertEncryptionOnFailure]);

  useEffect(() => {
    const countdown = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= pairing.expiresAt * 1_000) void finish(false, false);
    }, 1_000);
    const poll = window.setInterval(() => {
      void getStatus()
        .then((current) => {
          if (current.clients && hasNewClient(current.clients.clients, initialClientIDs)) {
            void finish(true, false);
          }
        })
        .catch((error) => console.error("Could not check Zaparoo client pairing", error));
    }, 2_000);
    const unsubscribe = subscribeCoreNotifications((notification) => {
      if (notification.method === "clients.paired") void finish(true, false);
    });
    return () => {
      window.clearInterval(countdown);
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [finish, initialClientIDs, pairing.expiresAt]);

  return (
    <ConfirmModal
      strTitle="Pair Client"
      strDescription={
        <div style={{ textAlign: "center" }}>
          <div>Enter this PIN in Zaparoo App:</div>
          <div style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "3px", marginTop: "10px" }}>
            {formatPairingPIN(pairing.pin)}
          </div>
          <div style={{ marginTop: "8px", opacity: 0.75 }}>
            Expires in {pairingCountdown(pairing.expiresAt, now)}
          </div>
        </div>
      }
      bAlertDialog
      strOKButtonText="Cancel"
      onOK={() => void finish(false, true)}
      onCancel={() => void finish(false, true)}
    />
  );
}

function InboxDialog({
  initialMessages,
  onChanged,
  onClose,
}: {
  initialMessages: InboxMessage[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [index, setIndex] = useState(0);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const message = messages[index];

  if (!message) return null;

  const dismiss = async () => {
    setDismissing(true);
    setError(undefined);
    try {
      await dismissInboxMessage(message.id);
      const remaining = messages.filter((item) => item.id !== message.id);
      onChanged();
      if (remaining.length === 0) {
        onClose();
        return;
      }
      setMessages(remaining);
      setIndex((current) => Math.min(current, remaining.length - 1));
    } catch (dismissError) {
      setError(String(dismissError));
    } finally {
      setDismissing(false);
    }
  };

  return (
    <ConfirmModal
      strTitle={message.title}
      strDescription={
        <div>
          <div style={{ fontSize: "12px", opacity: 0.75 }}>
            {inboxSeverityLabel(message.severity)} | {new Date(message.createdAt).toLocaleString()} | {index + 1} of {messages.length}
          </div>
          {message.body && (
            <div style={{ marginTop: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {message.body}
            </div>
          )}
          {error && <div style={{ marginTop: "12px" }}>Could not dismiss notification: {error}</div>}
        </div>
      }
      strOKButtonText="Dismiss"
      strCancelButtonText="Close"
      strMiddleButtonText={messages.length > 1 ? "Next" : undefined}
      bOKDisabled={dismissing}
      bCancelDisabled={dismissing}
      bMiddleDisabled={dismissing}
      onOK={() => void dismiss()}
      onCancel={onClose}
      onMiddleButton={() => {
        setError(undefined);
        setIndex((current) => (current + 1) % messages.length);
      }}
    />
  );
}

function OnlineLinkDetails({ link }: { link: OnlineLink }) {
  const [now, setNow] = useState(() => Date.now());
  const qrValue = link.verificationUrlComplete || link.verificationUrl;
  const displayURL = link.verificationUrl?.replace(/^https?:\/\//, "");
  const expiresAt = link.expiresAt ? Date.parse(link.expiresAt) / 1_000 : undefined;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div style={{ fontSize: "13px", textAlign: "center" }}>
      {qrValue && (
        <div style={{ background: "white", display: "inline-flex", padding: "5px" }}>
          <QRCodeSVG value={qrValue} size={136} marginSize={2} title="Zaparoo Online device link" />
        </div>
      )}
      <div style={{ fontWeight: 600, marginTop: "6px" }}>{displayURL}</div>
      {link.userCode && (
        <div style={{ fontSize: "20px", fontWeight: 700, letterSpacing: "2px", marginTop: "4px" }}>
          {link.userCode}
        </div>
      )}
      {expiresAt !== undefined && (
        <div style={{ marginTop: "3px", opacity: 0.75 }}>Expires in {pairingCountdown(expiresAt, now)}</div>
      )}
      <div style={{ marginTop: "7px", opacity: 0.75 }}>
        Linking uploads nothing until an Online feature is enabled.
      </div>
    </div>
  );
}

type GameIDAppStore = Partial<typeof window.appStore> & {
  GetAppOverviewByGameID?(appID: number): { display_name?: string } | undefined;
};

function currentGame(): ReturnType<typeof steamGameFromValues> {
  try {
    const running = Router?.MainRunningApp;
    if (running) {
      const game = steamGameFromValues(running.appid, running.display_name);
      if (game) return game;
    }
  } catch {
    // Fall through to read-only viewed-page detection when Steam's running-app API is unavailable.
  }

  const appID = steamGamePageAppID(window.location.href);
  if (!appID) return undefined;
  try {
    const appStore = window.appStore as GameIDAppStore | undefined;
    const numericAppID = Number(appID);
    const overview = Number.isSafeInteger(numericAppID)
      ? appStore?.GetAppOverviewByGameID?.(numericAppID)
      : undefined;
    return steamGameFromValues(appID, overview?.display_name);
  } catch {
    return steamGameFromValues(appID, undefined);
  }
}

function readerKey(reader: ReaderInfo): string {
  return reader.readerId || reader.id;
}

function readerLabel(reader: ReaderInfo): string {
  return reader.info || reader.driver || readerKey(reader);
}

function openWebUI(): void {
  Navigation.NavigateToExternalWeb("http://127.0.0.1:7497/app/");
  Navigation.CloseSideMenus();
}

function StatusLine({ label, value, breakAll = false }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <PanelSectionRow>
      <div
        data-zaparoo-status-line
        style={{
          alignItems: "start",
          boxSizing: "border-box",
          columnGap: 12,
          display: "grid",
          gridTemplateColumns: "max-content minmax(0, 1fr)",
          width: "100%",
        }}
      >
        <span style={{ whiteSpace: "nowrap" }}>{label}</span>
        <span
          style={{
            minWidth: 0,
            opacity: 0.8,
            overflowWrap: "anywhere",
            textAlign: "right",
            whiteSpace: "normal",
            wordBreak: breakAll ? "break-all" : "normal",
          }}
        >
          {value}
        </span>
      </div>
    </PanelSectionRow>
  );
}

function DatabaseProgressBar({ percent }: { percent: number }) {
  return (
    <PanelSectionRow>
      <div
        aria-label="Media database update progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        role="progressbar"
        style={{
          background: "rgba(255, 255, 255, 0.16)",
          borderRadius: 4,
          height: 8,
          marginBottom: 8,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <div
          style={{
            background: "#1a9fff",
            borderRadius: 4,
            height: "100%",
            transition: "width 200ms ease",
            width: `${percent}%`,
          }}
        />
      </div>
    </PanelSectionRow>
  );
}

export function Content() {
  const visible = useQuickAccessVisible();
  const [status, setStatus] = useState<PluginStatus>({ connected: false });
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedReader, setSelectedReader] = useState<string | undefined>();
  const [writing, setWriting] = useState(false);
  const [gameWriting, setGameWriting] = useState(false);
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [securityPromptIsDismissed, setSecurityPromptIsDismissed] = useState<boolean | undefined>();
  const [onlineLink, setOnlineLink] = useState<OnlineLink | undefined>();
  const [onlineError, setOnlineError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const writeCancelled = useRef(false);
  const gameWriteCancelled = useRef(false);
  const securityPromptShown = useRef(false);
  const onlineLinkModal = useRef<ReturnType<typeof showModal> | undefined>(undefined);
  const pairingModal = useRef<ReturnType<typeof showModal> | undefined>(undefined);
  const inboxModal = useRef<ReturnType<typeof showModal> | undefined>(undefined);
  const securityModal = useRef<ReturnType<typeof showModal> | undefined>(undefined);
  const confirmationModal = useRef<ReturnType<typeof showModal> | undefined>(undefined);
  const onlineLinkPolling = useRef(false);
  const notificationRefreshTimer = useRef<number | undefined>(undefined);
  const statusRef = useRef(status);
  const mounted = useRef(false);
  statusRef.current = status;

  const refresh = useCallback(async () => {
    const [statusResult, bootstrapResult] = await Promise.allSettled([
      getStatus(),
      getBootstrapStatus(),
    ]);
    if (!mounted.current) return;
    setStatus(
      statusResult.status === "fulfilled"
        ? statusResult.value
        : { connected: false, error: String(statusResult.reason) },
    );
    if (bootstrapResult.status === "fulfilled") {
      setBootstrap(bootstrapResult.value);
    } else {
      console.error("Could not load Zaparoo bootstrap status", bootstrapResult.reason);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const delay = status.connected ? CONNECTED_RECONCILE_MS : DISCONNECTED_POLL_MS;
    const timer = window.setInterval(() => void refresh(), delay);
    return () => window.clearInterval(timer);
  }, [refresh, status.connected, visible]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (!visible) return;
      if (notificationRefreshTimer.current !== undefined) {
        window.clearTimeout(notificationRefreshTimer.current);
      }
      notificationRefreshTimer.current = window.setTimeout(() => {
        notificationRefreshTimer.current = undefined;
        void refresh();
      }, NOTIFICATION_REFRESH_DELAY_MS);
    };

    const unsubscribeNotifications = subscribeCoreNotifications((notification) => {
      const indexing = indexingStatusFromNotification(notification);
      if (indexing) {
        if (!statusRef.current.media) {
          scheduleRefresh();
          return;
        }
        setStatus((current) =>
          current.media ? { ...current, media: { ...current.media, database: indexing } } : current,
        );
        return;
      }
      if (notification.method === "media.indexing" || notificationInvalidatesStatus(notification)) {
        scheduleRefresh();
      }
    });

    const unsubscribeConnection = subscribeCoreConnection((connected) => {
      if (!connected) {
        if (mounted.current) {
          setStatus({ connected: false, error: "Zaparoo Core disconnected. Reconnecting..." });
        }
        return;
      }
      if (visible) void refresh();
    });
    const unsubscribeBootstrap = subscribeBootstrapProgress((progress) => {
      if (mounted.current) {
        setBootstrap((current) => (current ? { ...current, progress } : current));
      }
      if (progress.phase === "complete" && visible) void refresh();
    });

    return () => {
      unsubscribeNotifications();
      unsubscribeConnection();
      unsubscribeBootstrap();
      if (notificationRefreshTimer.current !== undefined) {
        window.clearTimeout(notificationRefreshTimer.current);
        notificationRefreshTimer.current = undefined;
      }
    };
  }, [refresh, visible]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const cancelPairing = pairingModal.current !== undefined;
      const cancelLink = onlineLinkModal.current !== undefined;
      pairingModal.current?.Close();
      inboxModal.current?.Close();
      securityModal.current?.Close();
      confirmationModal.current?.Close();
      onlineLinkModal.current?.Close();
      pairingModal.current = undefined;
      inboxModal.current = undefined;
      securityModal.current = undefined;
      confirmationModal.current = undefined;
      onlineLinkModal.current = undefined;
      if (cancelPairing) {
        void cancelClientPairing().catch((error) =>
          console.error("Could not cancel Zaparoo client pairing during cleanup", error),
        );
      }
      if (cancelLink) {
        void cancelOnlineLink().catch((error) =>
          console.error("Could not cancel Zaparoo Online link during cleanup", error),
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!visible || securityPromptIsDismissed !== undefined) return;
    void securityPromptDismissed()
      .then((dismissed) => {
        if (mounted.current) setSecurityPromptIsDismissed(dismissed);
      })
      .catch((error) => {
        console.error("Could not read Zaparoo security prompt setting", error);
        if (mounted.current) setSecurityPromptIsDismissed(true);
      });
  }, [securityPromptIsDismissed, visible]);

  const readers = status.readers?.readers.filter((reader) => reader.connected) ?? [];
  const writers = readers.filter((reader) => reader.capabilities.includes("write"));
  const clients = status.clients?.clients ?? [];
  const inboxMessages = status.inbox?.messages ?? [];
  const lastToken = status.tokens?.last;
  const tokenID = lastScannedID(lastToken);
  const activeMedia = status.media?.active.find((media) => !media.slot || media.slot === "primary");
  const database = status.media?.database;
  const game = status.media && !activeMedia ? currentGame() : undefined;
  const remoteBackup = status.backup?.remote;
  const onlineLinked = remoteBackup?.linked === true;
  const cloudBackupAvailable = remoteBackup?.availability === "available";
  const compatibility = coreCompatibility(status.version?.version ?? "");
  const notificationBadgeColor = inboxMessages.some((message) => message.severity === 2)
    ? "#d94141"
    : inboxMessages.some((message) => message.severity === 1)
      ? "#d99a2b"
      : "#3faeec";
  useEffect(() => {
    if (writers.length === 0) {
      setSelectedReader(undefined);
      return;
    }
    const firstWriter = writers[0];
    if (
      firstWriter &&
      (!selectedReader || !writers.some((reader) => readerKey(reader) === selectedReader))
    ) {
      setSelectedReader(readerKey(firstWriter));
    }
  }, [selectedReader, writers]);

  useEffect(() => {
    if (!onlineLink) return;
    let stopped = false;
    const poll = async () => {
      if (onlineLinkPolling.current) return;
      onlineLinkPolling.current = true;
      try {
        const result = await getOnlineLinkStatus();
        if (stopped || result.status === "pending") return;
        setOnlineLink(undefined);
        onlineLinkModal.current?.Close();
        onlineLinkModal.current = undefined;
        if (result.status === "approved") {
          setOnlineError(undefined);
          await refresh();
        } else {
          setOnlineError(result.error || "Device linking did not complete.");
        }
      } catch (error) {
        console.error("Could not check Zaparoo Online link status", error);
      } finally {
        onlineLinkPolling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [onlineLink, refresh]);

  const runCoreBootstrap = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      if (mounted.current) {
        setBootstrap((current) =>
          current
            ? {
                ...current,
                progress: {
                  phase: "failed",
                  busy: false,
                  message: String(error),
                  error: String(error),
                },
              }
            : current,
        );
      }
    } finally {
      await refresh();
    }
  };

  const confirmCoreInstall = () => {
    if (confirmationModal.current !== undefined || bootstrap?.progress.busy) return;
    const modal = showModal(
      <ConfirmModal
        strTitle="Install Zaparoo Core?"
        strDescription={
          <div>
            Downloads latest compatible SteamOS release from Zaparoo's GitHub repository, verifies
            its SHA-256 digest, installs it to <code>~/.local/bin/zaparoo</code>, and enables a
            systemd user service.
            <br />
            <br />
            NFC hardware support is not installed automatically and requires a separate sudo
            command in Desktop Mode.
          </div>
        }
        strOKButtonText="Install Core"
        strCancelButtonText="Cancel"
        onOK={() => {
          modal.Close();
          confirmationModal.current = undefined;
          void runCoreBootstrap(installCore);
        }}
        onCancel={() => {
          modal.Close();
          confirmationModal.current = undefined;
        }}
      />,
    );
    confirmationModal.current = modal;
  };

  const saveReaderSettings = async (params: ReaderSettingsUpdate) => {
    setBusy("reader-settings");
    setActionError(undefined);
    try {
      await updateReaderSettings(params);
    } catch (error) {
      if (mounted.current) setActionError(`Could not save reader setting: ${String(error)}`);
    } finally {
      await refresh();
      if (mounted.current) setBusy(null);
    }
  };

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      if (mounted.current) setActionError(`${name} failed: ${String(error)}`);
    } finally {
      await refresh();
      if (mounted.current) setBusy(null);
    }
  };

  const saveOnlineSettings = async (params: OnlineSettingsUpdate) => {
    setBusy("online-settings");
    setOnlineError(undefined);
    try {
      await updateOnlineSettings(params);
    } catch (error) {
      if (mounted.current) setOnlineError(String(error));
    } finally {
      await refresh();
      if (mounted.current) setBusy(null);
    }
  };

  const stopOnlineLink = async () => {
    setOnlineLink(undefined);
    onlineLinkModal.current?.Close();
    onlineLinkModal.current = undefined;
    try {
      await cancelOnlineLink();
    } catch (error) {
      console.error("Could not cancel Zaparoo Online device link", error);
    }
  };

  const beginOnlineLink = async () => {
    setBusy("online-link");
    setOnlineError(undefined);
    try {
      const link = await startOnlineLink();
      if (!mounted.current) {
        await cancelOnlineLink();
        return;
      }
      if (link.status !== "pending" || (!link.verificationUrlComplete && !link.verificationUrl)) {
        throw new Error(link.error || "Core returned an invalid device link.");
      }
      setOnlineLink(link);
      onlineLinkModal.current = showModal(
        <ConfirmModal
          strTitle="Link with Zaparoo Online"
          strDescription={<OnlineLinkDetails link={link} />}
          bAlertDialog
          strOKButtonText="Cancel"
          onOK={() => void stopOnlineLink()}
          onCancel={() => void stopOnlineLink()}
        />,
      );
    } catch (error) {
      if (mounted.current) setOnlineError(String(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const confirmOnlineUnlink = () => {
    if (confirmationModal.current !== undefined) return;
    const modal = showModal(
      <ConfirmModal
        strTitle="Unlink from Zaparoo Online?"
        strDescription="Automatic cloud backups will stop until this device is linked again."
        strOKButtonText="Unlink"
        strCancelButtonText="Cancel"
        bDestructiveWarning
        onOK={() => {
          modal.Close();
          confirmationModal.current = undefined;
          void runAction("online-unlink", unlinkOnline);
        }}
        onCancel={() => {
          modal.Close();
          confirmationModal.current = undefined;
        }}
      />,
    );
    confirmationModal.current = modal;
  };

  const openInbox = () => {
    if (inboxModal.current !== undefined) return;
    const modal = showModal(
      <InboxDialog
        initialMessages={inboxMessages}
        onChanged={() => void refresh()}
        onClose={() => {
          modal.Close();
          inboxModal.current = undefined;
        }}
      />,
    );
    inboxModal.current = modal;
  };

  const beginWrite = async () => {
    if (!activeMedia?.zapScript) return;
    writeCancelled.current = false;
    setWriting(true);
    try {
      await writeTag(activeMedia.zapScript, selectedReader);
      if (mounted.current && !writeCancelled.current) {
        toaster.toast({ title: "Zaparoo", body: "Tag written" });
      }
    } catch (error) {
      if (mounted.current && !writeCancelled.current) {
        toaster.toast({ title: "Write to Tag failed", body: String(error), critical: true });
      }
    } finally {
      if (mounted.current) setWriting(false);
      await refresh();
    }
  };

  const cancelCurrentWrite = async () => {
    writeCancelled.current = true;
    try {
      await cancelWrite(selectedReader);
    } catch (error) {
      console.error("Could not cancel Zaparoo tag write", error);
    }
  };

  const beginGameWrite = async () => {
    if (!game) return;
    gameWriteCancelled.current = false;
    setGameWriting(true);
    try {
      await writeTag(
        steamMediaValue(game.appID, isNonSteamGameID(game.appID), game.name),
        selectedReader,
      );
      if (mounted.current && !gameWriteCancelled.current) {
        toaster.toast({ title: "Zaparoo", body: "Tag written" });
      }
    } catch (error) {
      if (mounted.current && !gameWriteCancelled.current) {
        toaster.toast({ title: "Write to Tag failed", body: String(error), critical: true });
      }
    } finally {
      if (mounted.current) setGameWriting(false);
      await refresh();
    }
  };

  const cancelGameWrite = async () => {
    gameWriteCancelled.current = true;
    try {
      await cancelWrite(selectedReader);
    } catch (error) {
      console.error("Could not cancel Zaparoo Steam tag write", error);
    }
  };

  const beginClientPairing = async (secure = false) => {
    setBusy("pair-client");
    setPairingError(undefined);
    const enableEncryption = secure && status.settings?.encryption === false;
    try {
      if (enableEncryption) await setEncryption(true);
      const clientPairing = await startClientPairing();
      if (!mounted.current) {
        await cancelClientPairing();
        if (enableEncryption) await setEncryption(false);
        return;
      }
      const modal = showModal(
        <ClientPairingDialog
          pairing={clientPairing}
          initialClientIDs={new Set(clients.map((client) => client.clientId))}
          revertEncryptionOnFailure={enableEncryption}
          onFinished={() => {
            modal.Close();
            pairingModal.current = undefined;
            void refresh();
          }}
        />,
      );
      pairingModal.current = modal;
    } catch (error) {
      if (enableEncryption) {
        try {
          await setEncryption(false);
        } catch (restoreError) {
          console.error("Could not restore Zaparoo encryption setting", restoreError);
        }
      }
      if (mounted.current) setPairingError(String(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  useEffect(() => {
    if (
      !visible ||
      !status.connected ||
      !compatibility.supported ||
      !status.settings ||
      !status.clients ||
      clients.length > 0 ||
      status.settings.encryption ||
      securityPromptIsDismissed !== false ||
      securityPromptDeferred ||
      securityPromptShown.current
    ) {
      return;
    }

    securityPromptShown.current = true;
    const modal = showModal(
      <ConfirmModal
        strTitle="Secure Zaparoo?"
        strDescription={
          <div>
            Anyone on your network can currently send Zaparoo commands to this device.
            <br /><br />
            Secure it so only approved phones and apps can connect.
          </div>
        }
        strOKButtonText="Secure Now"
        strCancelButtonText="Not Now"
        strMiddleButtonText="Don't Ask Again"
        onOK={() => {
          securityPromptDeferred = true;
          modal.Close();
          securityModal.current = undefined;
          void beginClientPairing(true);
        }}
        onCancel={() => {
          securityPromptDeferred = true;
          modal.Close();
          securityModal.current = undefined;
        }}
        onMiddleButton={() => {
          modal.Close();
          securityModal.current = undefined;
          setSecurityPromptIsDismissed(true);
          void dismissSecurityPrompt().catch((error) => {
            console.error("Could not dismiss Zaparoo security prompt", error);
          });
        }}
      />,
    );
    securityModal.current = modal;
  }, [
    clients.length,
    compatibility.supported,
    securityPromptIsDismissed,
    status.clients,
    status.connected,
    status.settings,
    visible,
  ]);

  if (!status.connected) {
    const progress = bootstrap?.progress;
    return (
      <PanelSection title="Zaparoo Core">
        <StatusLine
          label="Status"
          value={progress?.busy ? progress.message : bootstrap ? "Not connected" : "Checking installation…"}
        />
        {bootstrap?.reason && <StatusLine label="Bootstrap" value={bootstrap.reason} />}
        {progress?.error && <StatusLine label="Install error" value={progress.error} breakAll />}
        {!progress?.busy && status.error && <StatusLine label="Details" value={status.error} breakAll />}
        {bootstrap?.action === "install" && (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={Boolean(progress?.busy)} onClick={confirmCoreInstall}>
              Install Core
            </ButtonItem>
          </PanelSectionRow>
        )}
        {bootstrap?.action === "start" && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={Boolean(progress?.busy)}
              onClick={() => void runCoreBootstrap(startCore)}
            >
              Start Core
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={Boolean(progress?.busy)} onClick={() => void refresh()}>
            Reconnect
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!compatibility.supported) {
    return (
      <PanelSection title="Zaparoo Core">
        <StatusLine label="Core version" value={status.version?.version ?? "Unknown"} />
        <StatusLine
          label="Compatibility"
          value={compatibility.message ?? `Core ${MINIMUM_CORE_VERSION} or newer required`}
        />
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={openWebUI}>Open Web UI</ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <>
      {activeMedia ? (
        <PanelSection title="Current media">
          <StatusLine label="Name" value={activeMedia.mediaName} />
          <StatusLine label="System" value={activeMedia.systemName} />
          {writers.length > 1 && (
            <PanelSectionRow>
              <DropdownItem
                label="Writer"
                rgOptions={writers.map((reader) => ({ data: readerKey(reader), label: readerLabel(reader) }))}
                selectedOption={selectedReader}
                onChange={(option) => setSelectedReader(String(option.data))}
              />
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={writers.length === 0 ? "No writable reader connected" : undefined}
              disabled={writers.length === 0 || writing}
              onClick={() => void beginWrite()}
            >
              {writing ? "Waiting for tag…" : "Write to Tag"}
            </ButtonItem>
          </PanelSectionRow>
          {writing && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => void cancelCurrentWrite()}>Cancel</ButtonItem>
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => void runAction("stop", stopMedia)}
            >
              Stop playing
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : game ? (
        <PanelSection title="Steam game">
          <StatusLine label="Name" value={game.name} />
          {writers.length > 1 && (
            <PanelSectionRow>
              <DropdownItem
                label="Writer"
                rgOptions={writers.map((reader) => ({ data: readerKey(reader), label: readerLabel(reader) }))}
                selectedOption={selectedReader}
                onChange={(option) => setSelectedReader(String(option.data))}
              />
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={writers.length === 0 ? "No writable reader connected" : undefined}
              disabled={writers.length === 0 || gameWriting}
              onClick={() => void beginGameWrite()}
            >
              {gameWriting ? "Waiting for tag…" : "Write to Tag"}
            </ButtonItem>
          </PanelSectionRow>
          {gameWriting && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => void cancelGameWrite()}>
                Cancel
              </ButtonItem>
            </PanelSectionRow>
          )}
        </PanelSection>
      ) : null}

      {actionError && (
        <PanelSection title="Error">
          <StatusLine label="Action" value={actionError} breakAll />
        </PanelSection>
      )}

      {status.errors?.inbox ? (
        <PanelSection title="Notifications">
          <StatusLine label="Status" value="Unavailable" />
        </PanelSection>
      ) : inboxMessages.length > 0 ? (
        <PanelSection title="Notifications">
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={openInbox}>
              <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
                <span>View notifications</span>
                <span
                  style={{
                    background: notificationBadgeColor,
                    borderRadius: "12px",
                    color: "white",
                    fontSize: "12px",
                    fontWeight: 700,
                    minWidth: "24px",
                    padding: "2px 7px",
                    textAlign: "center",
                  }}
                >
                  {inboxMessages.length}
                </span>
              </div>
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection title="Last scanned">
        {!status.tokens ? (
          <StatusLine label="Status" value="Unavailable" />
        ) : lastToken ? (
          <>
            <StatusLine label="Time" value={new Date(lastToken.scanTime).toLocaleString()} />
            {tokenID && <StatusLine label="ID" value={tokenID} breakAll />}
            <StatusLine label="Value" value={lastToken.text || "None"} breakAll />
          </>
        ) : (
          <StatusLine label="Status" value="None" />
        )}
      </PanelSection>

      <PanelSection title="Media database">
        <StatusLine label="Status" value={database ? databaseStatusLabel(database) : "Unavailable"} />
        {(database?.indexing || database?.paused) && database.currentStepDisplay && (
          <StatusLine label="Current" value={database.currentStepDisplay} />
        )}
        {(database?.indexing || database?.paused) && databaseProgressLabel(database) && (
          <StatusLine label="Progress" value={databaseProgressLabel(database) ?? ""} />
        )}
        {(database?.indexing || database?.paused) && databaseProgressPercent(database) !== undefined && (
          <DatabaseProgressBar percent={databaseProgressPercent(database) ?? 0} />
        )}
        {database?.totalMedia !== undefined && (
          <StatusLine label="Media titles" value={database.totalMedia.toLocaleString()} />
        )}
        {database && (
          <PanelSectionRow>
            {database.paused ? (
              <ButtonItem
                layout="below"
                disabled={busy !== null}
                onClick={() => void runAction("resume-db", resumeMediaDatabaseUpdate)}
              >
                Resume
              </ButtonItem>
            ) : database.indexing ? (
              <ButtonItem
                layout="below"
                disabled={busy !== null}
                onClick={() => void runAction("cancel-db", cancelMediaDatabaseUpdate)}
              >
                Cancel
              </ButtonItem>
            ) : (
              <ButtonItem
                layout="below"
                disabled={busy !== null}
                onClick={() => void runAction("update-db", updateMediaDatabase)}
              >
                Update media database
              </ButtonItem>
            )}
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Readers">
        <StatusLine
          label="Connected"
          value={status.readers ? readerCountLabel(readers.length) : "Unavailable"}
        />
        {bootstrap && !bootstrap.hardwareInstalled && (
          <StatusLine
            label="NFC setup"
            value="In Desktop Mode run: sudo ~/.local/bin/zaparoo -install hardware"
            breakAll
          />
        )}
        {status.settings ? (
          <>
            <PanelSectionRow>
              <DropdownItem
                label="Scan mode"
                rgOptions={[
                  { data: "tap", label: "Tap" },
                  { data: "hold", label: "Hold" },
                ]}
                selectedOption={status.settings.readersScanMode}
                disabled={busy !== null}
                onChange={(option) =>
                  void saveReaderSettings({ readersScanMode: String(option.data) as "tap" | "hold" })
                }
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Audio feedback on scan"
                checked={status.settings.audioScanFeedback}
                disabled={busy !== null}
                onChange={(enabled) => void saveReaderSettings({ audioScanFeedback: enabled })}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Auto-detect readers"
                checked={status.settings.readersAutoDetect}
                disabled={busy !== null}
                onChange={(enabled) => void saveReaderSettings({ readersAutoDetect: enabled })}
              />
            </PanelSectionRow>
          </>
        ) : (
          <StatusLine label="Controls" value="Settings unavailable" />
        )}
      </PanelSection>

      <PanelSection title="Clients">
        {status.clients ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => void beginClientPairing()}
            >
              Pair client
            </ButtonItem>
          </PanelSectionRow>
        ) : (
          <StatusLine label="Status" value="Unavailable" />
        )}
        {pairingError && <StatusLine label="Pairing error" value={pairingError} breakAll />}
      </PanelSection>

      <PanelSection title="Zaparoo Online">
        <StatusLine
          label="Account"
          value={onlineAccountLabel(remoteBackup, Boolean(status.errors?.backup))}
        />
        {!onlineLinked ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null || Boolean(status.errors?.backup)}
              onClick={() => void beginOnlineLink()}
            >
              Link device
            </ButtonItem>
          </PanelSectionRow>
        ) : (
          <>
            {status.settings ? (
              <>
                <PanelSectionRow>
                  <ToggleField
                    label="Sync play history"
                    checked={status.settings.playtimeSyncEnabled ?? false}
                    disabled={busy !== null}
                    onChange={(enabled) => void saveOnlineSettings({ playtimeSyncEnabled: enabled })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label="Automatic cloud backup"
                    description={
                      remoteBackup?.availability === "unknown"
                        ? "Checking Warp status…"
                        : cloudBackupAvailable
                          ? undefined
                          : status.settings.backupRemoteEnabled
                            ? "Backups paused. Active Zaparoo Warp required."
                            : "Requires active Zaparoo Warp subscription"
                    }
                    checked={status.settings.backupRemoteEnabled ?? false}
                    disabled={
                      busy !== null || (!cloudBackupAvailable && !status.settings.backupRemoteEnabled)
                    }
                    onChange={(enabled) => void saveOnlineSettings({ backupRemoteEnabled: enabled })}
                  />
                </PanelSectionRow>
                {status.settings.backupRemoteEnabled && (
                  <PanelSectionRow>
                    <DropdownItem
                      label="Backup schedule"
                      rgOptions={BACKUP_SCHEDULE_OPTIONS}
                      selectedOption={status.settings.backupRemoteSchedule ?? "daily"}
                      disabled={busy !== null}
                      onChange={(option) =>
                        void saveOnlineSettings({
                          backupRemoteSchedule: String(option.data) as "daily" | "weekly" | "manual",
                        })
                      }
                    />
                  </PanelSectionRow>
                )}
              </>
            ) : (
              <StatusLine label="Controls" value="Settings unavailable" />
            )}
            <PanelSectionRow>
              <ButtonItem layout="below" disabled={busy !== null} onClick={confirmOnlineUnlink}>
                Unlink account
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}
        {onlineError && <StatusLine label="Online error" value={onlineError} breakAll />}
      </PanelSection>

      <PanelSection title="About">
        <StatusLine label="Core version" value={status.version?.version ?? "Unknown"} />
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={openWebUI}
          >
            Open Web UI
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
