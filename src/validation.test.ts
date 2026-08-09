import { describe, expect, it } from "vitest";
import {
  normalizeBootstrapProgress,
  normalizeBootstrapStatus,
  normalizeClientPairing,
  normalizeCoreNotification,
  normalizeOnlineLink,
  normalizePluginStatus,
  parseDatabaseStatus,
} from "./validation";

function validStatus(): Record<string, unknown> {
  return {
    connected: true,
    version: { version: "2.17.0", platform: "steamos" },
    errors: {},
    readers: {
      readers: [
        {
          id: "/dev/ttyUSB0",
          readerId: "pn532-1",
          driver: "pn532",
          info: "PN532",
          capabilities: ["read", "write"],
          connected: true,
        },
      ],
    },
    tokens: { active: [], last: null },
    media: {
      database: {
        exists: true,
        indexing: false,
        optimizing: false,
        paused: false,
        totalMedia: 42,
      },
      active: [],
    },
    settings: {
      audioScanFeedback: true,
      encryption: true,
      readersAutoDetect: true,
      readersScanExitDelay: 0,
      readersScanMode: "tap",
      backupRemoteSchedule: "daily",
    },
    clients: { clients: [] },
    backup: {
      remote: {
        availability: "available",
        lastStatus: "success",
        linked: true,
        enabled: false,
      },
    },
    inbox: { messages: [] },
  };
}

describe("bootstrap validation", () => {
  it("accepts bounded bootstrap status and progress", () => {
    const status = normalizeBootstrapStatus({
      supported: true,
      connected: false,
      binaryInstalled: false,
      serviceInstalled: false,
      serviceActive: false,
      hardwareInstalled: false,
      action: "install",
      progress: {
        phase: "downloading",
        busy: true,
        message: "Downloading Core 2.17.0",
        version: "2.17.0",
      },
    });

    expect(status.action).toBe("install");
    expect(status.progress.phase).toBe("downloading");
  });

  it("rejects unknown bootstrap actions and phases", () => {
    expect(() =>
      normalizeBootstrapProgress({ phase: "executing", busy: true, message: "bad" }),
    ).toThrow("invalid bootstrap progress");
    expect(() =>
      normalizeBootstrapStatus({
        supported: true,
        connected: false,
        binaryInstalled: false,
        serviceInstalled: false,
        serviceActive: false,
        hardwareInstalled: false,
        action: "replace-system",
        progress: { phase: "idle", busy: false, message: "" },
      }),
    ).toThrow("invalid bootstrap status");
  });
});

describe("normalizePluginStatus", () => {
  it("accepts a complete bounded Core snapshot", () => {
    const status = normalizePluginStatus(validStatus());

    expect(status.connected).toBe(true);
    expect(status.version).toEqual({ version: "2.17.0", platform: "steamos" });
    expect(status.readers?.readers[0]?.readerId).toBe("pn532-1");
    expect(status.media?.database.totalMedia).toBe(42);
    expect(status.errors).toEqual({});
  });

  it("turns invalid top-level and version responses into disconnected status", () => {
    expect(normalizePluginStatus(null)).toEqual({
      connected: false,
      error: "Invalid response from Decky backend",
    });
    expect(normalizePluginStatus({ connected: true, version: null })).toEqual({
      connected: false,
      error: "Core returned invalid version information",
    });
  });

  it("isolates malformed sections instead of passing them to React", () => {
    const value = validStatus();
    value.readers = { readers: [{ connected: true }] };
    value.media = {
      database: { exists: true, indexing: false, optimizing: false, paused: false },
      active: "not-an-array",
    };

    const status = normalizePluginStatus(value);

    expect(status.connected).toBe(true);
    expect(status.readers).toBeUndefined();
    expect(status.media).toBeUndefined();
    expect(status.errors).toMatchObject({
      readers: "Core returned invalid readers status",
      media: "Core returned invalid media status",
    });
  });

  it("rejects oversized collections", () => {
    const value = validStatus();
    value.inbox = { messages: Array.from({ length: 513 }, () => ({})) };

    const status = normalizePluginStatus(value);

    expect(status.inbox).toBeUndefined();
    expect(status.errors?.inbox).toBe("Core returned invalid inbox status");
  });

  it("defaults omitted backup availability and link state safely", () => {
    const value = validStatus();
    value.backup = { remote: { lastStatus: "never", enabled: false } };

    expect(normalizePluginStatus(value).backup?.remote).toMatchObject({
      availability: "unknown",
      linked: false,
      enabled: false,
    });
  });
});

describe("parseDatabaseStatus", () => {
  it("rejects malformed optional progress fields", () => {
    expect(
      parseDatabaseStatus({
        exists: true,
        indexing: true,
        optimizing: false,
        paused: false,
        currentStepDisplay: { unsafe: true },
      }),
    ).toBeUndefined();
  });

  it("accepts finite non-negative progress", () => {
    expect(
      parseDatabaseStatus({
        exists: true,
        indexing: true,
        optimizing: false,
        paused: false,
        currentStep: 2,
        totalSteps: 5,
      }),
    ).toMatchObject({ currentStep: 2, totalSteps: 5 });
  });
});

describe("direct callable validation", () => {
  it("validates pairing details", () => {
    expect(normalizeClientPairing({ pin: "123456", expiresAt: 1_800_000_000 })).toEqual({
      pin: "123456",
      expiresAt: 1_800_000_000,
    });
    expect(() => normalizeClientPairing({ pin: [], expiresAt: "later" })).toThrow("invalid");
  });

  it("accepts only bounded HTTP verification URLs", () => {
    expect(
      normalizeOnlineLink({
        status: "pending",
        userCode: "ABCD-1234",
        verificationUrl: "https://online.zaparoo.com/link",
      }),
    ).toMatchObject({ status: "pending", userCode: "ABCD-1234" });
    expect(() =>
      normalizeOnlineLink({ status: "pending", verificationUrl: "javascript:alert(1)" }),
    ).toThrow("invalid");
    expect(() =>
      normalizeOnlineLink({
        status: "pending",
        verificationUrl: "https://online.zaparoo.com/link",
        expiresAt: "not-a-date",
      }),
    ).toThrow("invalid");
  });

  it("rejects malformed Decky event payloads", () => {
    expect(normalizeCoreNotification({ method: "media.started", params: {} })).toEqual({
      method: "media.started",
      params: {},
    });
    expect(normalizeCoreNotification({ method: [] })).toBeUndefined();
  });
});
