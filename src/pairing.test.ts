import { describe, expect, it } from "vitest";
import { hasNewClient } from "./pairing";
import type { PairedClient } from "./types";

function client(clientId: string): PairedClient {
  return {
    clientId,
    clientName: clientId,
    role: "member",
    createdAt: 1,
    lastSeenAt: 1,
  };
}

describe("hasNewClient", () => {
  it("detects identity changes even when client count stays constant", () => {
    const initial = new Set(["old-client"]);

    expect(hasNewClient([client("new-client")], initial)).toBe(true);
    expect(hasNewClient([client("old-client")], initial)).toBe(false);
  });
});
