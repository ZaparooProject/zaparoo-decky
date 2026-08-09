import { describe, expect, it } from "vitest";
import { coreCompatibility, MINIMUM_CORE_VERSION } from "./compatibility";

describe("coreCompatibility", () => {
  it(`requires Core ${MINIMUM_CORE_VERSION}`, () => {
    expect(coreCompatibility("2.16.1")).toMatchObject({ supported: false, development: false });
    expect(coreCompatibility("2.17.0")).toEqual({ supported: true, development: false });
    expect(coreCompatibility("v2.18.3")).toEqual({ supported: true, development: false });
  });

  it("compares semantic components numerically", () => {
    expect(coreCompatibility("2.9.0").supported).toBe(false);
    expect(coreCompatibility("2.100.0").supported).toBe(true);
  });

  it("allows matching semantic prereleases and hash development builds", () => {
    expect(coreCompatibility("2.17.0-dev")).toEqual({ supported: true, development: true });
    expect(coreCompatibility("46e9fbb7-dev")).toEqual({ supported: true, development: true });
    expect(coreCompatibility("DEVELOPMENT")).toEqual({ supported: true, development: true });
  });

  it("still rejects versioned development builds below minimum", () => {
    expect(coreCompatibility("2.16.9-dev")).toMatchObject({ supported: false, development: true });
  });

  it("rejects unknown release version formats", () => {
    expect(coreCompatibility("latest")).toEqual({
      supported: false,
      development: false,
      message: "Unrecognized Core version. Core 2.17.0 or newer required",
    });
  });
});
