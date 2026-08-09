const MAX_OFFICIAL_APP_ID = 0xffff_ffffn;
const GAME_PAGE_ROUTE = /\/(?:routes\/)?library\/app\/(\d+)(?:\/|$)/u;
const RUNTIME_DISPLAY_NAME = "Zaparoo Runtime";

export interface SteamGame {
  appID: string;
  name: string;
}

export function steamGameFromValues(appIDValue: unknown, nameValue: unknown): SteamGame | undefined {
  let appID: string;
  try {
    appID = String(appIDValue);
    if (BigInt(appID) <= 0n) return undefined;
  } catch {
    return undefined;
  }
  const suppliedName = typeof nameValue === "string" ? nameValue.trim() : "";
  if (suppliedName === RUNTIME_DISPLAY_NAME) return undefined;
  return { appID, name: suppliedName || `App ${appID}` };
}

export function steamGamePageAppID(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(GAME_PAGE_ROUTE)?.[1];
  } catch {
    return undefined;
  }
}

export function isNonSteamGameID(appID: string | number | bigint): boolean {
  try {
    return BigInt(appID) > MAX_OFFICIAL_APP_ID;
  } catch {
    return false;
  }
}

export function steamMediaValue(
  appId: string | number | bigint,
  nonSteam: boolean,
  title?: string,
): string {
  let parsed: bigint;
  try {
    parsed = BigInt(appId);
  } catch {
    throw new Error("Steam app ID is invalid");
  }
  if (parsed <= 0n) {
    throw new Error("Steam app ID must be positive");
  }
  if (!nonSteam && parsed <= MAX_OFFICIAL_APP_ID) {
    const cleanTitle = title?.trim();
    return cleanTitle ? `steam://${parsed}/${encodeURIComponent(cleanTitle)}` : `steam://${parsed}`;
  }
  return `steam://rungameid/${parsed}`;
}
