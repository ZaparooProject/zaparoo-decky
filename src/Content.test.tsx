import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapStatus, PluginStatus } from "./types";

const mocks = vi.hoisted(() => ({
  cancelOnlineLink: vi.fn(),
  getBootstrapStatus: vi.fn(),
  getStatus: vi.fn(),
  installCore: vi.fn(),
  securityPromptDismissed: vi.fn(),
  startCore: vi.fn(),
  startOnlineLink: vi.fn(),
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
  return { QRCodeSVG: () => React.createElement("qrcode") };
});

vi.mock("./api", () => ({
  cancelClientPairing: vi.fn().mockResolvedValue(undefined),
  cancelMediaDatabaseUpdate: vi.fn().mockResolvedValue(undefined),
  cancelOnlineLink: mocks.cancelOnlineLink,
  cancelWrite: vi.fn().mockResolvedValue(undefined),
  dismissInboxMessage: vi.fn().mockResolvedValue(undefined),
  dismissSecurityPrompt: vi.fn().mockResolvedValue(undefined),
  getBootstrapStatus: mocks.getBootstrapStatus,
  getOnlineLinkStatus: vi.fn(),
  getStatus: mocks.getStatus,
  installCore: mocks.installCore,
  resumeMediaDatabaseUpdate: vi.fn().mockResolvedValue(undefined),
  setEncryption: vi.fn().mockResolvedValue(undefined),
  securityPromptDismissed: mocks.securityPromptDismissed,
  startClientPairing: vi.fn(),
  startCore: mocks.startCore,
  startOnlineLink: mocks.startOnlineLink,
  stopMedia: vi.fn().mockResolvedValue(undefined),
  subscribeBootstrapProgress: mocks.subscribeBootstrap,
  subscribeCoreConnection: mocks.subscribeConnection,
  subscribeCoreNotifications: mocks.subscribe,
  unlinkOnline: vi.fn().mockResolvedValue(undefined),
  updateMediaDatabase: vi.fn().mockResolvedValue(undefined),
  updateOnlineSettings: vi.fn().mockResolvedValue(undefined),
  updateReaderSettings: vi.fn().mockResolvedValue(undefined),
  writeTag: vi.fn().mockResolvedValue(undefined),
}));

import { Content } from "./Content";

function bootstrapStatus(overrides: Partial<BootstrapStatus> = {}): BootstrapStatus {
  return {
    supported: true,
    connected: true,
    binaryInstalled: true,
    serviceInstalled: true,
    serviceActive: true,
    hardwareInstalled: true,
    action: "none",
    progress: { phase: "idle", busy: false, message: "" },
    ...overrides,
  };
}

function completeStatus(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    connected: true,
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
  vi.clearAllMocks();
  mocks.cancelOnlineLink.mockResolvedValue(undefined);
  mocks.getBootstrapStatus.mockResolvedValue(bootstrapStatus());
  mocks.installCore.mockResolvedValue(undefined);
  mocks.startCore.mockResolvedValue(undefined);
  mocks.securityPromptDismissed.mockResolvedValue(true);
  mocks.startOnlineLink.mockResolvedValue({
    status: "pending",
    userCode: "ABCD-1234",
    verificationUrl: "https://online.zaparoo.com/link",
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

  it("shows bootstrap progress and NFC setup guidance", async () => {
    mocks.getBootstrapStatus.mockResolvedValue(bootstrapStatus({ hardwareInstalled: false }));
    const renderer = await renderStatus(completeStatus());

    expect(text(renderer.root)).toContain("sudo ~/.local/bin/zaparoo -install hardware");
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

  it("closes an open Inbox modal when Content unmounts", async () => {
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
    expect(mocks.closeModal).toHaveBeenCalledOnce();
  });

  it("cancels an open Online link when Content unmounts", async () => {
    const renderer = await renderStatus(completeStatus());
    const linkButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Link device"));
    if (linkButton === undefined) throw new Error("Online link button not found");

    await act(async () => linkButton.props.onClick());
    expect(mocks.showModal).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
    expect(mocks.closeModal).toHaveBeenCalledOnce();
    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
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
        userCode: "ABCD-1234",
        verificationUrl: "https://online.zaparoo.com/link",
      }),
    );

    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(mocks.cancelOnlineLink).toHaveBeenCalledOnce();
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
