import { describe, expect, it } from "vitest";
import { canonicalProbeKey, resolveProbe } from "../../src/probes/index";
import { probeActualyze } from "../../src/probes/actualyze";

describe("probe registry", () => {
  it("resolves the deprecated atlas ID to the actualyze probe", async () => {
    expect(canonicalProbeKey("atlas")).toBe("actualyze");
    await expect(resolveProbe("atlas", "https://a.test")).resolves.toEqual({
      probe: probeActualyze,
      key: "actualyze",
    });
  });

  it("resolves the current actualyze ID", async () => {
    await expect(resolveProbe("actualyze", "https://a.test")).resolves.toEqual({
      probe: probeActualyze,
      key: "actualyze",
    });
  });

  it("rejects unknown IDs and inherited object keys", async () => {
    for (const id of ["nope", "constructor", "__proto__", "toString"]) {
      expect(canonicalProbeKey(id)).toBeUndefined();
      await expect(resolveProbe(id, "https://a.test")).resolves.toEqual({
        probe: undefined,
      });
    }
  });

  it("maps the legacy atlas owner through auto detection", async () => {
    await expect(
      resolveProbe("auto", "https://a.test", undefined, {
        modelsResponse: [
          { id: "m", object: "model", created: 1, owned_by: "atlas" },
        ],
      }),
    ).resolves.toEqual({
      probe: probeActualyze,
      key: "actualyze",
      detectedServer: "actualyze",
    });
  });
});
