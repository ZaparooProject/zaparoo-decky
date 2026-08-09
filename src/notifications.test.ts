import { describe, expect, it } from "vitest";
import { indexingStatusFromNotification, notificationInvalidatesStatus } from "./notifications";

describe("indexingStatusFromNotification", () => {
  it("returns detailed media indexing status", () => {
    const status = indexingStatusFromNotification({
      method: "media.indexing",
      params: {
        exists: true,
        indexing: true,
        optimizing: false,
        paused: false,
        currentStep: 18,
        totalSteps: 42,
        currentStepDisplay: "Super Nintendo",
      },
    });

    expect(status).toMatchObject({
      indexing: true,
      currentStep: 18,
      totalSteps: 42,
      currentStepDisplay: "Super Nintendo",
    });
  });

  it("rejects malformed indexing notifications", () => {
    expect(
      indexingStatusFromNotification({ method: "media.indexing", params: { indexing: true } }),
    ).toBeUndefined();
    expect(indexingStatusFromNotification({ method: "media.started", params: {} })).toBeUndefined();
  });
});

describe("notificationInvalidatesStatus", () => {
  it.each(["media.started", "tokens.added", "readers.removed", "inbox.added", "backup.state"])(
    "invalidates snapshots for %s",
    (method) => expect(notificationInvalidatesStatus({ method })).toBe(true),
  );

  it("ignores high-frequency indexing updates handled directly", () => {
    expect(notificationInvalidatesStatus({ method: "media.indexing" })).toBe(false);
  });
});
