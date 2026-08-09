import { describe, expect, it } from "vitest";
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
