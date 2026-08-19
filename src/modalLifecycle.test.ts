import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAllModals,
  closeModal,
  registerModal,
  startModalLifecycle,
} from "./modalLifecycle";

function handle() {
  return { Close: vi.fn() };
}

beforeEach(() => {
  closeAllModals();
  startModalLifecycle();
});

describe("modal lifecycle", () => {
  it("keeps modal open until its owner closes it", () => {
    const modal = registerModal(handle());

    expect(modal.Close).not.toHaveBeenCalled();
    closeModal(modal);

    expect(modal.Close).toHaveBeenCalledOnce();
  });

  it("closes and cleans active modals only on plugin unload", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const active = registerModal(handle(), cleanup);
    const alreadyClosed = registerModal(handle(), cleanup);
    closeModal(alreadyClosed);
    cleanup.mockClear();

    closeAllModals();
    await Promise.resolve();

    expect(active.Close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("retains ownership when normal modal closing fails", async () => {
    const closeError = new Error("close failed");
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const modal = {
      Close: vi.fn().mockImplementationOnce(() => { throw closeError; }),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerModal(modal, cleanup);

    expect(() => closeModal(modal)).toThrow(closeError);
    closeAllModals();
    await Promise.resolve();

    expect(modal.Close).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("rejects and cleans modal registration after plugin dismount", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const modal = handle();
    closeAllModals();

    expect(() => registerModal(modal, cleanup)).toThrow("plugin is unloading");
    await Promise.resolve();

    expect(modal.Close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs unload cleanup when modal closing fails", async () => {
    const closeError = new Error("close failed");
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerModal({ Close: vi.fn(() => { throw closeError; }) }, cleanup);

    closeAllModals();
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "Could not close Zaparoo modal during plugin unload",
      closeError,
    );
    consoleError.mockRestore();
  });
});
