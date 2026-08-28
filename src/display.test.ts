import { describe, expect, it } from "vitest";
import {
  databaseProgressLabel,
  databaseProgressPercent,
  databaseStatusLabel,
  formatPairingPIN,
  inboxSeverityLabel,
  lastScannedID,
  updateActionDisabled,
  updateActionLabel,
  updateStatusLabel,
  onlineAccountLabel,
  pairingCountdown,
  readerCountLabel,
} from "./display";

const database = {
  exists: true,
  indexing: false,
  optimizing: false,
  paused: false,
};

describe("readerCountLabel", () => {
  it.each([
    [0, "None connected"],
    [1, "1 connected"],
    [2, "2 connected"],
  ])("formats %i connected readers", (count, expected) => {
    expect(readerCountLabel(count)).toBe(expected);
  });
});

describe("client pairing display", () => {
  it("groups a six-digit PIN for readability", () => {
    expect(formatPairingPIN("123456")).toBe("123 456");
    expect(formatPairingPIN("ABC123")).toBe("ABC123");
  });

  it("shows a non-negative pairing countdown", () => {
    expect(pairingCountdown(130, 10_000)).toBe("2:00");
    expect(pairingCountdown(9, 10_000)).toBe("0:00");
  });
});

describe("inboxSeverityLabel", () => {
  it.each([
    [0, "Info"],
    [1, "Warning"],
    [2, "Error"],
  ] as const)("maps severity %i to %s", (severity, expected) => {
    expect(inboxSeverityLabel(severity)).toBe(expected);
  });
});

describe("onlineAccountLabel", () => {
  const remote = {
    availability: "available" as const,
    lastStatus: "success",
    linked: true,
    enabled: false,
  };

  it("shows concise link identity", () => {
    expect(onlineAccountLabel(remote)).toBe("Linked");
    expect(onlineAccountLabel({ ...remote, deviceName: "Steam Deck" })).toBe("Linked as Steam Deck");
  });

  it("distinguishes unlinked and unavailable status", () => {
    expect(onlineAccountLabel({ ...remote, linked: false })).toBe("Not linked");
    expect(onlineAccountLabel(undefined, true)).toBe("Unavailable");
  });
});

describe("media database display", () => {
  it("separates update state from current work", () => {
    expect(databaseStatusLabel({ ...database, indexing: true, currentStepDisplay: "Scanning Steam" })).toBe(
      "Updating",
    );
    expect(databaseStatusLabel({ ...database, indexing: true, paused: true })).toBe("Paused");
  });

  it("formats bounded step progress", () => {
    expect(databaseProgressLabel({ ...database, currentStep: 18, totalSteps: 42 })).toBe("18 of 42 (43%)");
    expect(databaseProgressPercent({ ...database, currentStep: 50, totalSteps: 42 })).toBe(100);
    expect(databaseProgressLabel({ ...database, currentStep: 0, totalSteps: 0 })).toBeUndefined();
  });

  it("uses compact idle labels", () => {
    expect(databaseStatusLabel(database)).toBe("Ready");
    expect(databaseStatusLabel({ ...database, exists: false })).toBe("Not ready");
  });
});

describe("lastScannedID", () => {
  const token = { scanTime: "", type: "", uid: "04A1", text: "game", data: "" };

  it("shows a distinct physical token ID", () => {
    expect(lastScannedID(token)).toBe("04A1");
  });

  it("hides API and duplicated IDs like Zaparoo App", () => {
    expect(lastScannedID({ ...token, uid: "__api__" })).toBeUndefined();
    expect(lastScannedID({ ...token, uid: "game" })).toBeUndefined();
  });
});

describe("updateStatusLabel", () => {
  it("says nothing is known when Core has not answered", () => {
    expect(updateStatusLabel(undefined)).toBe("Unknown");
  });

  it("reports an available update", () => {
    expect(
      updateStatusLabel({
        currentVersion: "2.10.0",
        latestVersion: "2.11.0",
        updateAvailable: true,
        autoInstall: false,
      }),
    ).toBe("2.11.0 available");
  });

  // Being told a version exists without being told why it is not installing
  // reads as something broken.
  it("explains a staged rollout rather than just offering the version", () => {
    expect(
      updateStatusLabel({
        currentVersion: "2.10.0",
        latestVersion: "2.11.0",
        updateAvailable: true,
        rolloutHeld: true,
        autoInstall: true,
      }),
    ).toBe("2.11.0 available, rolling out gradually");
  });

  // Something already happened to this device, so it outranks the offer.
  it("puts a rollback ahead of an available update", () => {
    expect(
      updateStatusLabel({
        currentVersion: "2.10.0",
        latestVersion: "2.11.0",
        updateAvailable: true,
        autoInstall: true,
        lastResult: { at: "2026-08-28T09:21:57Z", outcome: "rolledBack", toVersion: "2.11.0" },
      }),
    ).toBe("Update to 2.11.0 was rolled back");
  });

  it("does not announce an update that simply worked", () => {
    expect(
      updateStatusLabel({
        currentVersion: "2.11.0",
        updateAvailable: false,
        autoInstall: false,
        lastResult: { at: "2026-08-28T09:16:28Z", outcome: "succeeded", toVersion: "2.11.0" },
      }),
    ).toBe("Up to date");
  });

  it("says when Core will install on its own", () => {
    expect(
      updateStatusLabel({ currentVersion: "2.11.0", updateAvailable: false, autoInstall: true }),
    ).toBe("Up to date, installs automatically");
  });

  it("explains why a development build never updates", () => {
    expect(
      updateStatusLabel({
        currentVersion: "abc123-dev",
        updateAvailable: false,
        autoInstall: false,
        eligibility: "development",
      }),
    ).toBe("Development build");
  });
});

describe("updateActionLabel and updateActionDisabled", () => {
  it("offers to install when there is something to install", () => {
    const update = {
      currentVersion: "2.10.0",
      latestVersion: "2.11.0",
      updateAvailable: true,
      autoInstall: false,
    };
    expect(updateActionLabel(update)).toBe("Install Update");
    expect(updateActionDisabled(update)).toBe(false);
  });

  it("offers to check when nothing is known to be available", () => {
    const update = { currentVersion: "2.11.0", updateAvailable: false, autoInstall: false };
    expect(updateActionLabel(update)).toBe("Check for Updates");
    expect(updateActionDisabled(update)).toBe(false);
  });

  // The gate has already said no and explained itself in the status line.
  it("cannot act through a gate that will not be forced", () => {
    expect(
      updateActionDisabled({
        currentVersion: "2.10.0",
        latestVersion: "2.11.0",
        updateAvailable: true,
        autoInstall: false,
        blockedBy: { reason: "indexing", message: "media is being indexed", forceable: false },
      }),
    ).toBe(true);
  });

  it("cannot act where updates do not apply at all", () => {
    expect(
      updateActionDisabled({
        currentVersion: "2.11.0",
        updateAvailable: false,
        autoInstall: false,
        eligibility: "managed",
      }),
    ).toBe(true);
  });
});
