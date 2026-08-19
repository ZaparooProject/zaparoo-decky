import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapStatus, LogUpload, PluginStatus } from "./types";

const mocks = vi.hoisted(() => ({
  cancelClientPairing: vi.fn(),
  cancelOnlineLink: vi.fn(),
  claimClientPairing: vi.fn(),
  claimOnlineLink: vi.fn(),
  completeClientPairing: vi.fn(),
  dismissSecurityPrompt: vi.fn(),
  expireClientPairing: vi.fn(),
  getBootstrapStatus: vi.fn(),
  getStatus: vi.fn(),
  installCore: vi.fn(),
  securityPromptDismissed: vi.fn(),
  startClientPairing: vi.fn(),
  startCore: vi.fn(),
  startOnlineLink: vi.fn(),
  stopMedia: vi.fn(),
  uploadLogs: vi.fn(),
  showModal: vi.fn(),
  closeModal: vi.fn(),
  router: { MainRunningApp: undefined as unknown },
  connectionListener: undefined as ((connected: boolean) => void) | undefined,
  bootstrapListener: undefined as ((progress: unknown) => void) | undefined,
  subscribe: vi.fn(),
  subscribeBootstrap: vi.fn(),
  subscribeConnection: vi.fn(),
  unsubscribe: vi.fn(),
  unsubscribeBootstrap: vi.fn(),
  unsubscribeConnection: vi.fn(),
}));

vi.mock("@decky/api", () => ({
  toaster: { toast: vi.fn() },
  useQuickAccessVisible: () => true,
}));

vi.mock("@decky/ui", async () => {
  const React = await import("react");
  const component = (tag: string) =>
    ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
      React.createElement(tag, props, children);
  return {
    ButtonItem: component("button"),
    ConfirmModal: component("dialog"),
    DropdownItem: component("dropdown"),
    Field: component("field"),
    Navigation: { NavigateToExternalWeb: vi.fn(), CloseSideMenus: vi.fn() },
    PanelSection: component("section"),
    PanelSectionRow: component("row"),
    Router: mocks.router,
    showModal: mocks.showModal,
    ToggleField: component("toggle"),
  };
});

vi.mock("qrcode.react", async () => {
  const React = await import("react");
  return {
    QRCodeSVG: (props: Record<string, unknown>) => React.createElement("svg", props),
  };
});

vi.mock("./api", () => ({
  cancelClientPairing: mocks.cancelClientPairing,
  cancelMediaDatabaseUpdate: vi.fn().mockResolvedValue(undefined),
  cancelOnlineLink: mocks.cancelOnlineLink,
  cancelWrite: vi.fn().mockResolvedValue(undefined),
  claimClientPairing: mocks.claimClientPairing,
  claimOnlineLink: mocks.claimOnlineLink,
  completeClientPairing: mocks.completeClientPairing,
  dismissInboxMessage: vi.fn().mockResolvedValue(undefined),
  dismissSecurityPrompt: mocks.dismissSecurityPrompt,
  expireClientPairing: mocks.expireClientPairing,
  getBootstrapStatus: mocks.getBootstrapStatus,
  getOnlineLinkStatus: vi.fn(),
  getStatus: mocks.getStatus,
  installCore: mocks.installCore,
  resumeMediaDatabaseUpdate: vi.fn().mockResolvedValue(undefined),
  securityPromptDismissed: mocks.securityPromptDismissed,
  startClientPairing: mocks.startClientPairing,
  startCore: mocks.startCore,
  startOnlineLink: mocks.startOnlineLink,
  stopMedia: mocks.stopMedia,
  subscribeBootstrapProgress: mocks.subscribeBootstrap,
  subscribeCoreConnection: mocks.subscribeConnection,
  subscribeCoreNotifications: mocks.subscribe,
  unlinkOnline: vi.fn().mockResolvedValue(undefined),
  updateMediaDatabase: vi.fn().mockResolvedValue(undefined),
  updateOnlineSettings: vi.fn().mockResolvedValue(undefined),
  updateReaderSettings: vi.fn().mockResolvedValue(undefined),
  uploadLogs: mocks.uploadLogs,
  writeTag: vi.fn().mockResolvedValue(undefined),
}));

import { Content } from "./Content";
import { resetLogUploadLifecycle } from "./logUploadLifecycle";
import { closeAllModals, startModalLifecycle } from "./modalLifecycle";

function bootstrapStatus(overrides: Partial<BootstrapStatus> = {}): BootstrapStatus {
  return {
    supported: true,
    connected: true,
    binaryInstalled: true,
    serviceInstalled: true,
    serviceActive: true,
    action: "none",
    progress: { phase: "idle", busy: false, message: "" },
    ...overrides,
  };
}

function completeStatus(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    connected: true,
    pluginVersion: "0.1.1-dev.test",
    version: { version: "2.17.0", platform: "steamos" },
    readers: { readers: [] },
    tokens: { active: [] },
    media: {
      database: { exists: true, indexing: false, optimizing: false, paused: false },
      active: [],
    },
    settings: {
      audioScanFeedback: true,
      encryption: true,
      readersAutoDetect: true,
      readersScanExitDelay: 0,
      readersScanMode: "tap",
    },
    clients: { clients: [] },
    backup: {
      remote: {
        availability: "unknown",
        lastStatus: "never",
        linked: false,
        enabled: false,
      },
    },
    inbox: { messages: [] },
    errors: {},
    ...overrides,
  };
}

function text(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}

async function renderStatus(status: PluginStatus): Promise<ReactTestRenderer> {
  mocks.getStatus.mockResolvedValue(status);
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Content />);
  });
  if (renderer === undefined) throw new Error("Content did not render");
  return renderer;
}

beforeEach(() => {
  closeAllModals();
  startModalLifecycle();
  resetLogUploadLifecycle();
  vi.clearAllMocks();
  mocks.cancelClientPairing.mockResolvedValue(undefined);
  mocks.cancelOnlineLink.mockResolvedValue(undefined);
  mocks.claimClientPairing.mockResolvedValue(undefined);
  mocks.claimOnlineLink.mockResolvedValue(undefined);
  mocks.completeClientPairing.mockResolvedValue(undefined);
  mocks.dismissSecurityPrompt.mockResolvedValue(undefined);
  mocks.expireClientPairing.mockResolvedValue(undefined);
  mocks.getBootstrapStatus.mockResolvedValue(bootstrapStatus());
  mocks.installCore.mockResolvedValue(undefined);
  mocks.startClientPairing.mockResolvedValue({
    pin: "123456",
    expiresAt: 1_800_000_000,
    workflowId: 1,
  });
  mocks.startCore.mockResolvedValue(undefined);
  mocks.securityPromptDismissed.mockResolvedValue(true);
  mocks.startOnlineLink.mockResolvedValue({
    status: "pending",
    workflowId: 2,
    userCode: "ABCD-1234",
    verificationUrl: "https://online.zaparoo.com/link",
  });
  mocks.stopMedia.mockResolvedValue(undefined);
  mocks.uploadLogs.mockResolvedValue({
    outcome: "success",
    url: "https://logs.zaparoo.org/abc123.log",
  });
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe);
  mocks.subscribeBootstrap.mockImplementation((listener: (progress: unknown) => void) => {
    mocks.bootstrapListener = listener;
    return mocks.unsubscribeBootstrap;
  });
  mocks.subscribeConnection.mockImplementation((listener: (connected: boolean) => void) => {
    mocks.connectionListener = listener;
    return mocks.unsubscribeConnection;
  });
  mocks.showModal.mockImplementation(() => ({ Close: mocks.closeModal }));
  mocks.router.MainRunningApp = undefined;
  vi.stubGlobal("window", {
    appStore: undefined,
    clearInterval,
    clearTimeout,
    location: { href: "https://steamloopback.host/routes/library/home" },
    setInterval,
    setTimeout,
  });
});

describe("Content", () => {
  it("shows plugin version beneath Core version", async () => {
    const renderer = await renderStatus(completeStatus());
    const rendered = text(renderer.root);

    expect(rendered.indexOf("Plugin version")).toBeGreaterThan(rendered.indexOf("Core version"));
    expect(rendered).toContain("0.1.1-dev.test");

    await act(async () => renderer.unmount());
  });

  it("shows disconnect immediately and refreshes when Core reconnects", async () => {
    const renderer = await renderStatus(completeStatus());

    mocks.getStatus.mockResolvedValue({ connected: false, error: "Core unavailable" });
    act(() => mocks.connectionListener?.(false));
    expect(text(renderer.root)).toContain("Zaparoo Core disconnected. Reconnecting...");
    await act(async () => Promise.resolve());
    expect(text(renderer.root)).toContain("Core unavailable");
    const disconnectedRefreshes = mocks.getStatus.mock.calls.length;

    mocks.getStatus.mockResolvedValue(completeStatus());
    await act(async () => {
      mocks.connectionListener?.(true);
      await Promise.resolve();
    });
    expect(mocks.getStatus.mock.calls.length).toBeGreaterThan(disconnectedRefreshes);
    expect(text(renderer.root)).not.toContain("Core unavailable");

    await act(async () => renderer.unmount());
  });

  it("confirms Core installation before starting bootstrap", async () => {
    mocks.getBootstrapStatus.mockResolvedValue(
      bootstrapStatus({
        connected: false,
        binaryInstalled: false,
        serviceInstalled: false,
        serviceActive: false,
        action: "install",
      }),
    );
    const renderer = await renderStatus({ connected: false, error: "Core unavailable" });
    const installButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Install Core"));
    if (installButton === undefined) throw new Error("Install Core button not found");

    act(() => installButton.props.onClick());
    expect(mocks.showModal).toHaveBeenCalledOnce();
    const modal = mocks.showModal.mock.calls[0]?.[0];
    await act(async () => modal.props.onOK());

    expect(mocks.installCore).toHaveBeenCalledOnce();
    expect(text(renderer.root)).toContain("Install Core");
    await act(async () => renderer.unmount());
  });

  it("starts an existing stopped Core without reinstalling", async () => {
    mocks.getBootstrapStatus.mockResolvedValue(
      bootstrapStatus({
        connected: false,
        serviceActive: false,
        action: "start",
      }),
    );
    const renderer = await renderStatus({ connected: false, error: "Core unavailable" });
    const startButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Start Core"));
    if (startButton === undefined) throw new Error("Start Core button not found");

    await act(async () => startButton.props.onClick());

    expect(mocks.startCore).toHaveBeenCalledOnce();
    expect(mocks.installCore).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("shows bootstrap progress", async () => {
    const renderer = await renderStatus(completeStatus());

    act(() => {
      mocks.connectionListener?.(false);
      mocks.bootstrapListener?.({
        phase: "downloading",
        busy: true,
        message: "Downloading Core 2.17.0",
        version: "2.17.0",
      });
    });
    expect(text(renderer.root)).toContain("Downloading Core 2.17.0");

    await act(async () => renderer.unmount());
    expect(mocks.unsubscribeBootstrap).toHaveBeenCalledOnce();
  });

  it("blocks operational controls on unsupported Core versions", async () => {
    const renderer = await renderStatus(
      completeStatus({ version: { version: "2.16.1", platform: "steamos" } }),
    );
    const rendered = text(renderer.root);

    expect(rendered).toContain("Core 2.17.0 or newer required");
    expect(rendered).not.toContain("Update media database");
    expect(rendered).not.toContain("Pair client");

    await act(async () => renderer.unmount());
  });

  it("keeps status labels on one line and wraps values", async () => {
    const renderer = await renderStatus(completeStatus());
    const statusLine = renderer.root.findAll(
      (node) => node.props["data-zaparoo-status-line"] === true,
    )[0];
    if (statusLine === undefined) throw new Error("Status line not found");

    expect(statusLine.props.style).toMatchObject({
      display: "grid",
      gridTemplateColumns: "max-content minmax(0, 1fr)",
      width: "100%",
    });
    const [label, value] = statusLine.findAllByType("span");
    expect(label?.props.style.whiteSpace).toBe("nowrap");
    expect(value?.props.style).toMatchObject({
      minWidth: 0,
      overflowWrap: "anywhere",
      whiteSpace: "normal",
    });

    await act(async () => renderer.unmount());
  });

  it("removes implicit separators from every interactive section control", async () => {
    const unlinkedRenderer = await renderStatus(completeStatus());
    const linkedStatus = completeStatus();
    if (linkedStatus.backup === undefined || linkedStatus.settings === undefined) {
      throw new Error("Online fixtures are unavailable");
    }
    linkedStatus.backup.remote.linked = true;
    linkedStatus.backup.remote.availability = "available";
    linkedStatus.settings.backupRemoteEnabled = true;
    linkedStatus.settings.backupRemoteSchedule = "daily";
    const linkedRenderer = await renderStatus(linkedStatus);

    for (const renderer of [unlinkedRenderer, linkedRenderer]) {
      const controls = renderer.root.findAll((node) =>
        ["button", "dropdown", "toggle"].includes(String(node.type)),
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) expect(control.props.bottomSeparator).toBe("none");
    }

    await act(async () => unlinkedRenderer.unmount());
    await act(async () => linkedRenderer.unmount());
  });

  it("shows a failed Warp check as unavailable instead of checking forever", async () => {
    const status = completeStatus();
    if (status.backup === undefined || status.settings === undefined) {
      throw new Error("Online fixtures are unavailable");
    }
    status.backup.remote.linked = true;
    status.backup.remote.availability = "unknown";
    status.backup.remote.availabilityCheckedAt = "2026-08-19T03:02:01Z";
    const renderer = await renderStatus(status);
    const backupToggle = renderer.root
      .findAll((node) => String(node.type) === "toggle")
      .find((toggle) => toggle.props.label === "Automatic cloud backup");

    expect(backupToggle?.props.description).toBe(
      "Warp status unavailable. Check network connection.",
    );

    await act(async () => renderer.unmount());
  });

  it("hides exit delay in hold scan mode", async () => {
    const status = completeStatus();
    if (status.settings === undefined) throw new Error("Settings fixture is unavailable");
    status.settings.readersScanMode = "hold";
    const renderer = await renderStatus(status);

    const dropdownLabels = renderer.root
      .findAll((node) => typeof node.props.label === "string")
      .map((dropdown) => dropdown.props.label);
    expect(dropdownLabels).toContain("Scan mode");
    expect(dropdownLabels).not.toContain("Exit delay");

    await act(async () => renderer.unmount());
  });

  it("renders unavailable sections without fabricated controls", async () => {
    const status = completeStatus({
      errors: {
        readers: "invalid",
        tokens: "invalid",
        media: "invalid",
        settings: "invalid",
        clients: "invalid",
        inbox: "invalid",
      },
    });
    delete status.readers;
    delete status.tokens;
    delete status.media;
    delete status.settings;
    delete status.clients;
    delete status.inbox;
    const renderer = await renderStatus(status);
    const rendered = text(renderer.root);

    expect(rendered).toContain("Unavailable");
    expect(rendered).toContain("Settings unavailable");
    expect(rendered).not.toContain("Update media database");
    expect(rendered).not.toContain("Pair client");

    await act(async () => renderer.unmount());
  });

  it("keeps an open Inbox modal when Quick Access content unmounts", async () => {
    const renderer = await renderStatus(
      completeStatus({
        inbox: {
          messages: [
            {
              id: 1,
              title: "Test",
              severity: 0,
              createdAt: "2026-08-09T00:00:00Z",
            },
          ],
        },
      }),
    );
    const inboxButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("View notifications"));
    if (inboxButton === undefined) throw new Error("Inbox button not found");

    act(() => inboxButton.props.onClick());
    expect(mocks.showModal).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
    expect(mocks.closeModal).not.toHaveBeenCalled();
  });

  it("keeps an active pairing modal open when Quick Access content unmounts", async () => {
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    await act(async () => pairButton.props.onClick());
    expect(mocks.showModal).toHaveBeenCalledOnce();
    expect(mocks.claimClientPairing).toHaveBeenCalledWith(1);

    await act(async () => renderer.unmount());
    expect(mocks.closeModal).not.toHaveBeenCalled();
    expect(mocks.cancelClientPairing).not.toHaveBeenCalled();
  });

  it("closes and cancels pairing when workflow claim is already terminal", async () => {
    mocks.claimClientPairing.mockRejectedValueOnce(new Error("pairing workflow expired"));
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    await act(async () => pairButton.props.onClick());

    expect(mocks.closeModal).toHaveBeenCalledOnce();
    expect(mocks.cancelClientPairing).toHaveBeenCalledWith(1);
    expect(text(renderer.root)).toContain("pairing workflow expired");
    await act(async () => renderer.unmount());
  });

  it("retains pairing modal when claim acknowledgement and cancellation are ambiguous", async () => {
    mocks.claimClientPairing.mockRejectedValueOnce(new Error("claim response lost"));
    mocks.cancelClientPairing.mockRejectedValueOnce(new Error("cancel response lost"));
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    await act(async () => pairButton.props.onClick());

    expect(mocks.cancelClientPairing).toHaveBeenCalledOnce();
    expect(mocks.closeModal).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain("ownership is uncertain");
    await act(async () => renderer.unmount());
    closeAllModals();
  });

  it("keeps pairing modal actionable when cancellation fails", async () => {
    mocks.cancelClientPairing.mockRejectedValueOnce(new Error("cancel failed"));
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    await act(async () => pairButton.props.onClick());
    const modal = mocks.showModal.mock.calls[0]?.[0];
    let modalRenderer: ReactTestRenderer | undefined;
    act(() => {
      modalRenderer = create(modal);
    });
    if (modalRenderer === undefined) throw new Error("Pairing modal did not render");
    const dialog = modalRenderer.root.findByType("dialog");

    await act(async () => dialog.props.onOK());
    expect(mocks.closeModal).not.toHaveBeenCalled();
    let errorDetails: ReactTestRenderer | undefined;
    act(() => {
      errorDetails = create(dialog.props.strDescription);
    });
    if (errorDetails === undefined) throw new Error("Pairing error did not render");
    expect(text(errorDetails.root)).toContain("cancel failed");

    await act(async () => dialog.props.onOK());
    expect(mocks.cancelClientPairing).toHaveBeenCalledTimes(2);
    expect(mocks.cancelClientPairing).toHaveBeenLastCalledWith(1);
    expect(mocks.closeModal).toHaveBeenCalledOnce();

    await act(async () => errorDetails?.unmount());
    await act(async () => modalRenderer?.unmount());
    await act(async () => renderer.unmount());
  });

  it("rolls back pairing when modal ownership cannot be established", async () => {
    mocks.showModal.mockImplementationOnce(() => {
      throw new Error("modal failed");
    });
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    await act(async () => pairButton.props.onClick());

    expect(mocks.startClientPairing).toHaveBeenCalledWith(false);
    expect(mocks.cancelClientPairing).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("cancels pairing that resolves after plugin dismount", async () => {
    let resolvePairing: ((value: unknown) => void) | undefined;
    mocks.startClientPairing.mockReturnValue(
      new Promise((resolve) => {
        resolvePairing = resolve;
      }),
    );
    const renderer = await renderStatus(completeStatus());
    const pairButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Pair client"));
    if (pairButton === undefined) throw new Error("Pair client button not found");

    act(() => pairButton.props.onClick());
    closeAllModals();
    await act(async () => {
      resolvePairing?.({ pin: "123456", expiresAt: 1_800_000_000, workflowId: 1 });
      await Promise.resolve();
    });

    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(mocks.cancelClientPairing).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("keeps security prompt actionable when dismissal persistence fails", async () => {
    mocks.securityPromptDismissed.mockResolvedValue(false);
    mocks.dismissSecurityPrompt.mockRejectedValueOnce(new Error("settings unavailable"));
    const status = completeStatus();
    if (status.settings === undefined) throw new Error("Settings fixture is unavailable");
    status.settings.encryption = false;
    const renderer = await renderStatus(status);
    const modal = mocks.showModal.mock.calls[0]?.[0];
    let modalRenderer: ReactTestRenderer | undefined;
    act(() => {
      modalRenderer = create(modal);
    });
    if (modalRenderer === undefined) throw new Error("Security modal did not render");
    const dialog = modalRenderer.root.findByType("dialog");

    await act(async () => dialog.props.onMiddleButton());
    expect(mocks.closeModal).not.toHaveBeenCalled();
    let errorDetails: ReactTestRenderer | undefined;
    act(() => {
      errorDetails = create(dialog.props.strDescription);
    });
    if (errorDetails === undefined) throw new Error("Security error did not render");
    expect(text(errorDetails.root)).toContain("settings unavailable");

    await act(async () => dialog.props.onMiddleButton());
    expect(mocks.dismissSecurityPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.closeModal).toHaveBeenCalledOnce();

    await act(async () => errorDetails?.unmount());
    await act(async () => modalRenderer?.unmount());
    await act(async () => renderer.unmount());
  });

  it("can continue secure pairing from a modal after Quick Access content unmounts", async () => {
    mocks.securityPromptDismissed.mockResolvedValue(false);
    const status = completeStatus();
    if (status.settings === undefined) throw new Error("Settings fixture is unavailable");
    status.settings.encryption = false;
    const renderer = await renderStatus(status);
    expect(mocks.showModal).toHaveBeenCalledOnce();
    const securityModal = mocks.showModal.mock.calls[0]?.[0];

    let securityRenderer: ReactTestRenderer | undefined;
    act(() => {
      securityRenderer = create(securityModal);
    });
    if (securityRenderer === undefined) throw new Error("Security modal did not render");

    await act(async () => renderer.unmount());
    await act(async () => {
      securityRenderer?.root.findByType("dialog").props.onOK();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.startClientPairing).toHaveBeenCalledWith(true);
    expect(mocks.showModal).toHaveBeenCalledTimes(2);
    expect(mocks.cancelClientPairing).not.toHaveBeenCalled();
    await act(async () => securityRenderer?.unmount());
  });

  it("keeps Online linking modal active when Quick Access content unmounts", async () => {
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());
    expect(mocks.showModal).toHaveBeenCalledOnce();
    expect(mocks.claimOnlineLink).toHaveBeenCalledWith(2);

    const modal = mocks.showModal.mock.calls[0]?.[0];
    await act(async () => renderer.unmount());
    expect(mocks.closeModal).not.toHaveBeenCalled();
    expect(mocks.cancelOnlineLink).not.toHaveBeenCalled();

    let modalRenderer: ReactTestRenderer | undefined;
    act(() => {
      modalRenderer = create(modal);
    });
    if (modalRenderer === undefined) throw new Error("Online link modal did not render");
    const dialog = modalRenderer.root.findByType("dialog");
    await act(async () => dialog.props.onOK());
    expect(mocks.closeModal).toHaveBeenCalledOnce();
    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
    await act(async () => modalRenderer?.unmount());
  });

  it("closes and cancels Online linking when workflow claim is already terminal", async () => {
    mocks.claimOnlineLink.mockRejectedValueOnce(new Error("Online workflow expired"));
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());

    expect(mocks.closeModal).toHaveBeenCalledOnce();
    expect(mocks.cancelOnlineLink).toHaveBeenCalledWith(2);
    expect(text(renderer.root)).toContain("Online workflow expired");
    await act(async () => renderer.unmount());
  });

  it("retains Online modal when claim acknowledgement and cancellation are ambiguous", async () => {
    mocks.claimOnlineLink.mockRejectedValueOnce(new Error("claim response lost"));
    mocks.cancelOnlineLink.mockRejectedValueOnce(new Error("cancel response lost"));
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());

    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
    expect(mocks.closeModal).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain("ownership is uncertain");
    await act(async () => renderer.unmount());
    closeAllModals();
  });

  it("keeps Online linking modal actionable when cancellation fails", async () => {
    mocks.cancelOnlineLink.mockRejectedValueOnce(new Error("cancel failed"));
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());
    const modal = mocks.showModal.mock.calls[0]?.[0];
    let modalRenderer: ReactTestRenderer | undefined;
    act(() => {
      modalRenderer = create(modal);
    });
    if (modalRenderer === undefined) throw new Error("Online link modal did not render");
    const dialog = modalRenderer.root.findByType("dialog");

    await act(async () => dialog.props.onOK());
    expect(mocks.closeModal).not.toHaveBeenCalled();
    let errorDetails: ReactTestRenderer | undefined;
    act(() => {
      errorDetails = create(dialog.props.strDescription);
    });
    if (errorDetails === undefined) throw new Error("Online link error did not render");
    expect(text(errorDetails.root)).toContain("cancel failed");

    await act(async () => dialog.props.onOK());
    expect(mocks.cancelOnlineLink).toHaveBeenCalledTimes(2);
    expect(mocks.cancelOnlineLink).toHaveBeenLastCalledWith(2);
    expect(mocks.closeModal).toHaveBeenCalledOnce();

    await act(async () => errorDetails?.unmount());
    await act(async () => modalRenderer?.unmount());
    await act(async () => renderer.unmount());
  });

  it("keeps Online linking actionable when modal closure fails", async () => {
    mocks.closeModal.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());
    const modal = mocks.showModal.mock.calls[0]?.[0];
    let modalRenderer: ReactTestRenderer | undefined;
    act(() => {
      modalRenderer = create(modal);
    });
    if (modalRenderer === undefined) throw new Error("Online link modal did not render");
    const dialog = modalRenderer.root.findByType("dialog");

    await act(async () => dialog.props.onOK());
    expect(mocks.cancelOnlineLink).toHaveBeenCalledWith(2);
    let errorDetails: ReactTestRenderer | undefined;
    act(() => {
      errorDetails = create(dialog.props.strDescription);
    });
    if (errorDetails === undefined) throw new Error("Online link error did not render");
    expect(text(errorDetails.root)).toContain("close failed");

    await act(async () => dialog.props.onOK());
    expect(mocks.closeModal).toHaveBeenCalledTimes(2);

    closeAllModals();
    await act(async () => errorDetails?.unmount());
    await act(async () => modalRenderer?.unmount());
    await act(async () => renderer.unmount());
  });

  it("rolls back Online linking when modal ownership cannot be established", async () => {
    mocks.startOnlineLink.mockResolvedValue({ status: "pending", workflowId: 2 });
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());

    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
    expect(mocks.showModal).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("does not open a link modal when request finishes after unmount", async () => {
    let resolveLink: ((value: unknown) => void) | undefined;
    mocks.startOnlineLink.mockReturnValue(
      new Promise((resolve) => {
        resolveLink = resolve;
      }),
    );
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    act(() => linkButton.props.onClick());
    await act(async () => renderer.unmount());
    await act(async () =>
      resolveLink?.({
        status: "pending",
        workflowId: 2,
        userCode: "ABCD-1234",
        verificationUrl: "https://online.zaparoo.com/link",
      }),
    );

    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
  });

  it("displays action failures in a modal beside the triggered action", async () => {
    mocks.stopMedia.mockRejectedValueOnce(new Error("stop failed"));
    const status = completeStatus();
    if (status.media === undefined) throw new Error("Media fixture is unavailable");
    status.media.active = [{
      zapScript: "**launch.system:nes",
      systemId: "NES",
      systemName: "Nintendo Entertainment System",
      mediaName: "Test Game",
      mediaPath: "/games/test.nes",
    }];
    const renderer = await renderStatus(status);
    const stopButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Stop playing"));
    if (stopButton === undefined) throw new Error("Stop button not found");

    await act(async () => stopButton.props.onClick());

    expect(mocks.showModal).toHaveBeenCalledOnce();
    const modal = mocks.showModal.mock.calls[0]?.[0];
    expect(modal.props.strTitle).toBe("Action Failed");
    let details: ReactTestRenderer | undefined;
    act(() => {
      details = create(modal.props.strDescription);
    });
    if (details === undefined) throw new Error("Action error did not render");
    expect(text(details.root)).toContain("stop failed");

    await act(async () => details?.unmount());
    await act(async () => renderer.unmount());
  });

  it("recovers a successful log upload after Quick Access content remount", async () => {
    let resolveUpload: ((value: LogUpload) => void) | undefined;
    mocks.uploadLogs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    const firstRenderer = await renderStatus(completeStatus());
    const uploadButton = firstRenderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Upload logs"));
    if (uploadButton === undefined) throw new Error("Upload logs button not found");

    act(() => uploadButton.props.onClick());
    await act(async () => firstRenderer.unmount());
    resolveUpload?.({ outcome: "success", url: "https://logs.zaparoo.org/recovered.log" });
    await Promise.resolve();
    expect(mocks.showModal).not.toHaveBeenCalled();

    const secondRenderer = await renderStatus(completeStatus());
    expect(mocks.uploadLogs).toHaveBeenCalledOnce();
    expect(mocks.showModal).toHaveBeenCalledOnce();
    expect(mocks.showModal.mock.calls[0]?.[0].props.strTitle).toBe("Core Logs Uploaded");

    await act(async () => secondRenderer.unmount());
  });

  it("uploads Core logs and displays URL with QR code", async () => {
    const renderer = await renderStatus(completeStatus());
    const uploadButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Upload logs"));
    if (uploadButton === undefined) throw new Error("Upload logs button not found");
    expect(uploadButton.props.description).toBeUndefined();

    await act(async () => uploadButton.props.onClick());

    expect(mocks.uploadLogs).toHaveBeenCalledOnce();
    expect(mocks.showModal).toHaveBeenCalledOnce();
    const modal = mocks.showModal.mock.calls[0]?.[0];
    expect(modal.props.strTitle).toBe("Core Logs Uploaded");
    let details: ReactTestRenderer | undefined;
    act(() => {
      details = create(modal.props.strDescription);
    });
    if (details === undefined) throw new Error("Log upload details did not render");
    expect(text(details.root)).toContain("https://logs.zaparoo.org/abc123.log");
    expect(details.root.findByType("svg").props.value).toBe(
      "https://logs.zaparoo.org/abc123.log",
    );

    await act(async () => details?.unmount());
    await act(async () => renderer.unmount());
  });

  it("distinguishes unknown log upload outcomes from definite failures", async () => {
    mocks.uploadLogs.mockResolvedValueOnce({
      outcome: "unknown",
      error: "Service may have received the log",
    });
    const renderer = await renderStatus(completeStatus());
    const uploadButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Upload logs"));
    if (uploadButton === undefined) throw new Error("Upload logs button not found");

    await act(async () => uploadButton.props.onClick());

    const modal = mocks.showModal.mock.calls[0]?.[0];
    expect(modal.props.strTitle).toBe("Upload Outcome Unknown");
    let details: ReactTestRenderer | undefined;
    act(() => {
      details = create(modal.props.strDescription);
    });
    if (details === undefined) throw new Error("Unknown upload outcome did not render");
    expect(text(details.root)).toContain("may have received Core log");
    expect(text(details.root)).toContain("Wait before retrying");

    await act(async () => details?.unmount());
    await act(async () => renderer.unmount());
  });

  it("displays log upload failures in a modal", async () => {
    mocks.uploadLogs.mockRejectedValueOnce(new Error("Core request failed"));
    const renderer = await renderStatus(completeStatus());
    const uploadButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Upload logs"));
    if (uploadButton === undefined) throw new Error("Upload logs button not found");

    await act(async () => uploadButton.props.onClick());

    expect(mocks.showModal).toHaveBeenCalledOnce();
    const modal = mocks.showModal.mock.calls[0]?.[0];
    expect(modal.props.strTitle).toBe("Log Upload Failed");
    let details: ReactTestRenderer | undefined;
    act(() => {
      details = create(modal.props.strDescription);
    });
    if (details === undefined) throw new Error("Log upload error did not render");
    expect(text(details.root)).toContain("Core request failed");

    await act(async () => details?.unmount());
    await act(async () => renderer.unmount());
  });

  it("falls back safely when Steam app lookup throws", async () => {
    vi.stubGlobal("window", {
      appStore: {
        GetAppOverviewByGameID: () => {
          throw new Error("Steam API changed");
        },
      },
      clearInterval,
      clearTimeout,
      location: { href: "https://steamloopback.host/routes/library/app/1145360" },
      setInterval,
      setTimeout,
    });
    const renderer = await renderStatus(completeStatus());

    expect(text(renderer.root)).toContain("App 1145360");
    await act(async () => renderer.unmount());
  });
});
