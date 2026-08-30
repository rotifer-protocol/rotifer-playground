import { describe, it, expect } from "vitest";
import { telemetryOptedOutByEnv, telemetryExplicitlyOnByEnv } from "../../src/telemetry/consent.js";

/**
 * The one environment check shared by the anonymous heartbeat (ADR-329) and
 * the signed-in invocation report (ADR-316/322). ADR-329's decision is that
 * ROTIFER_TELEMETRY=0 turns off "all of it, not half" — these tests exist so
 * that promise can't quietly stop being true after either report's code
 * changes without the other's changing too.
 */
describe("telemetryOptedOutByEnv", () => {
  it("is false when nothing is set", () => {
    expect(telemetryOptedOutByEnv({})).toBe(false);
  });

  it.each(["1", "true", "yes", "anything-non-empty"])(
    "DO_NOT_TRACK=%j opts out",
    (v) => {
      expect(telemetryOptedOutByEnv({ DO_NOT_TRACK: v })).toBe(true);
    },
  );

  it.each(["0", "false", "", undefined])(
    "DO_NOT_TRACK=%j does NOT opt out on its own",
    (v) => {
      const env = v === undefined ? {} : { DO_NOT_TRACK: v };
      expect(telemetryOptedOutByEnv(env)).toBe(false);
    },
  );

  it.each(["0", "false", "off", "OFF", " off "])(
    "ROTIFER_TELEMETRY=%j opts out",
    (v) => {
      expect(telemetryOptedOutByEnv({ ROTIFER_TELEMETRY: v })).toBe(true);
    },
  );

  it("ROTIFER_TELEMETRY=1 does not opt out", () => {
    expect(telemetryOptedOutByEnv({ ROTIFER_TELEMETRY: "1" })).toBe(false);
  });

  it("DO_NOT_TRACK wins even when ROTIFER_TELEMETRY explicitly asks for on", () => {
    // ADR-329 D1.3: DO_NOT_TRACK outranks Rotifer's own knob — a stance the
    // user took before ever hearing of this project.
    expect(
      telemetryOptedOutByEnv({ DO_NOT_TRACK: "1", ROTIFER_TELEMETRY: "1" }),
    ).toBe(true);
  });
});

describe("telemetryExplicitlyOnByEnv", () => {
  it("is false when nothing is set — 'unset' is not 'explicitly on'", () => {
    expect(telemetryExplicitlyOnByEnv({})).toBe(false);
  });

  it.each(["1", "true", "on", "yes"])("ROTIFER_TELEMETRY=%j is explicit on", (v) => {
    expect(telemetryExplicitlyOnByEnv({ ROTIFER_TELEMETRY: v })).toBe(true);
  });

  it("is false when ROTIFER_TELEMETRY says off", () => {
    expect(telemetryExplicitlyOnByEnv({ ROTIFER_TELEMETRY: "0" })).toBe(false);
  });

  it("DO_NOT_TRACK vetoes an explicit ROTIFER_TELEMETRY=1", () => {
    expect(
      telemetryExplicitlyOnByEnv({ DO_NOT_TRACK: "1", ROTIFER_TELEMETRY: "1" }),
    ).toBe(false);
  });
});
