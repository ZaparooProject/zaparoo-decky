export const MINIMUM_CORE_VERSION = "2.17.0";

export interface CoreCompatibility {
  supported: boolean;
  development: boolean;
  message?: string;
}

const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

function versionParts(version: string): [number, number, number] | undefined {
  const match = RELEASE_VERSION.exec(version);
  if (!match) return undefined;
  const parts = match.slice(1, 4).map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    ? [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    : undefined;
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function coreCompatibility(version: string): CoreCompatibility {
  const development = version === "DEVELOPMENT" || version.endsWith("-dev");
  const current = versionParts(version);
  const minimum = versionParts(MINIMUM_CORE_VERSION);
  if (current !== undefined && minimum !== undefined) {
    const supported = compareVersions(current, minimum) >= 0;
    return {
      supported,
      development,
      ...(supported ? {} : { message: `Core ${MINIMUM_CORE_VERSION} or newer required` }),
    };
  }
  if (development) return { supported: true, development: true };
  return {
    supported: false,
    development: false,
    message: `Unrecognized Core version. Core ${MINIMUM_CORE_VERSION} or newer required`,
  };
}
