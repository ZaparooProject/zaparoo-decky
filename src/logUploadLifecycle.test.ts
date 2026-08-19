import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLogUploadResult,
  getLogUploadState,
  resetLogUploadLifecycle,
  startLogUpload,
  subscribeLogUpload,
} from "./logUploadLifecycle";
import type { LogUpload } from "./types";

beforeEach(() => resetLogUploadLifecycle());

describe("log upload lifecycle", () => {
  it("preserves a successful result until a remounted owner consumes it", async () => {
    let resolveUpload: ((value: LogUpload) => void) | undefined;
    startLogUpload(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    expect(getLogUploadState()).toEqual({ status: "pending" });

    resolveUpload?.({ outcome: "success", url: "https://logs.zaparoo.org/abc123.log" });
    await Promise.resolve();

    const listener = vi.fn();
    const unsubscribe = subscribeLogUpload(listener);
    expect(listener).toHaveBeenLastCalledWith({
      status: "success",
      url: "https://logs.zaparoo.org/abc123.log",
    });

    clearLogUploadResult();
    expect(getLogUploadState()).toEqual({ status: "idle" });
    unsubscribe();
  });

  it("preserves an unknown outcome separately from definite failure", async () => {
    startLogUpload(async () => ({ outcome: "unknown", error: "Service may have received log" }));
    await Promise.resolve();

    expect(getLogUploadState()).toEqual({
      status: "unknown",
      error: "Service may have received log",
    });
  });

  it("ignores completion after terminal plugin reset", async () => {
    let resolveUpload: ((value: LogUpload) => void) | undefined;
    startLogUpload(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    resetLogUploadLifecycle();
    resolveUpload?.({ outcome: "success", url: "https://logs.zaparoo.org/stale.log" });
    await Promise.resolve();

    expect(getLogUploadState()).toEqual({ status: "idle" });
  });
});
