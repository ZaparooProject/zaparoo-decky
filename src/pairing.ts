import type { PairedClient } from "./types";

export function hasNewClient(
  clients: readonly PairedClient[],
  initialClientIDs: ReadonlySet<string>,
): boolean {
  return clients.some((client) => !initialClientIDs.has(client.clientId));
}
