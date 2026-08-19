import type { LogUpload } from "./types";

export type LogUploadState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; url: string }
  | { status: "unknown"; error: string }
  | { status: "error"; error: string };

type Listener = (state: LogUploadState) => void;

const listeners = new Set<Listener>();
let state: LogUploadState = { status: "idle" };
let generation = 0;

function update(next: LogUploadState): void {
  state = next;
  for (const listener of [...listeners]) listener(state);
}

export function getLogUploadState(): LogUploadState {
  return state;
}

export function subscribeLogUpload(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function startLogUpload(action: () => Promise<LogUpload>): void {
  if (state.status === "pending") return;
  const currentGeneration = ++generation;
  update({ status: "pending" });
  void action().then(
    (result) => {
      if (generation !== currentGeneration) return;
      if (result.outcome === "unknown") {
        update({ status: "unknown", error: result.error });
      } else {
        update({ status: "success", url: result.url });
      }
    },
    (error: unknown) => {
      if (generation === currentGeneration) {
        update({ status: "error", error: String(error).slice(0, 512) });
      }
    },
  );
}

export function clearLogUploadResult(): void {
  if (state.status === "success" || state.status === "unknown" || state.status === "error") {
    update({ status: "idle" });
  }
}

export function resetLogUploadLifecycle(): void {
  generation += 1;
  update({ status: "idle" });
}
