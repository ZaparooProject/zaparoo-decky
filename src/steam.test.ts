import { describe, expect, it } from "vitest";
import {
  isNonSteamGameID,
  steamGameFromValues,
  steamGamePageAppID,
  steamMediaValue,
} from "./steam";

describe("steamGamePageAppID", () => {
  it("reads Steam game routes without modifying the page", () => {
    expect(steamGamePageAppID("https://steamloopback.host/routes/library/app/1145360")).toBe(
      "1145360",
    );
    expect(steamGamePageAppID("https://steamloopback.host/routes/library/home")).toBeUndefined();
    expect(steamGamePageAppID("not a URL")).toBeUndefined();
  });
});

describe("steamGameFromValues", () => {
  it("validates Steam context and supplies a safe fallback title", () => {
    expect(steamGameFromValues(1145360, " Hades ")).toEqual({ appID: "1145360", name: "Hades" });
    expect(steamGameFromValues("17708845718510239744", undefined)).toEqual({
      appID: "17708845718510239744",
      name: "App 17708845718510239744",
    });
    expect(steamGameFromValues("invalid", "Game")).toBeUndefined();
  });

  it("excludes the permanent Zaparoo Runtime shortcut", () => {
    expect(steamGameFromValues("17708845718510239744", "Zaparoo Runtime")).toBeUndefined();
  });
});

describe("isNonSteamGameID", () => {
  it("distinguishes shortcut game IDs from official app IDs", () => {
    expect(isNonSteamGameID(1145360)).toBe(false);
    expect(isNonSteamGameID("17708845718510239744")).toBe(true);
  });
});

describe("steamMediaValue", () => {
  it("writes official Steam apps with readable titles", () => {
    expect(steamMediaValue(1145360, false, "Hades")).toBe("steam://1145360/Hades");
    expect(steamMediaValue(123, false, "Super Hot/Cold")).toBe(
      "steam://123/Super%20Hot%2FCold",
    );
  });

  it("allows official Steam apps without titles", () => {
    expect(steamMediaValue(1145360, false)).toBe("steam://1145360");
  });

  it("writes non-Steam shortcuts with their Big Picture ID", () => {
    expect(steamMediaValue("17708845718510239744", true)).toBe(
      "steam://rungameid/17708845718510239744",
    );
  });

  it("rejects invalid app IDs", () => {
    expect(() => steamMediaValue("not-an-id", false)).toThrow("invalid");
    expect(() => steamMediaValue(0, false)).toThrow("positive");
  });
});
