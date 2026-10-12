import { describe, expect, it } from "vitest";
import { probeKoboldcpp } from "../../src/probes/koboldcpp";
import { probeLmstudio } from "../../src/probes/lmstudio";
import { probeOllama } from "../../src/probes/ollama";
import { probeOmlx } from "../../src/probes/omlx";
import { probeSglang } from "../../src/probes/sglang";
import { probeTgi } from "../../src/probes/tgi";
import type { ProbeContext, ProviderProbe } from "../../src/probes/types";

const BASE_URL = "http://gateway.test";

const CONTEXT: ProbeContext = {
  headers: { "X-Gateway": "team-a" },
  modelsResponse: [
    { id: "model", object: "model", created: 1_700_000_000, owned_by: "x" },
  ],
};

function sentHeaders(): Record<string, string>[] {
  return mockFetch.mock.calls.map(
    ([, init]) => (init as RequestInit).headers as Record<string, string>,
  );
}

describe("provider header forwarding", () => {
  it.each<[string, ProviderProbe]>([
    ["koboldcpp", probeKoboldcpp],
    ["lmstudio", probeLmstudio],
    ["ollama", probeOllama],
    ["omlx", probeOmlx],
    ["sglang", probeSglang],
    ["tgi", probeTgi],
  ])("%s sends the API key and provider headers", async (_name, probe) => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await probe(BASE_URL, "sk-test", CONTEXT);

    expect(mockFetch).toHaveBeenCalled();
    for (const headers of sentHeaders()) {
      expect(headers).toEqual({
        Authorization: "Bearer sk-test",
        "X-Gateway": "team-a",
      });
    }
  });

  it("ollama sends one JSON Content-Type on /api/show over a provider content-type", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.endsWith("/api/tags")
        ? { ok: true, json: async () => ({ models: [{ name: "llama3" }] }) }
        : { ok: false, status: 404 },
    );

    await probeOllama(BASE_URL, undefined, {
      headers: { "content-type": "text/plain", "X-Gateway": "team-a" },
    });

    const showHeaders = sentHeaders()[1];
    expect(showHeaders).toEqual({
      "X-Gateway": "team-a",
      "Content-Type": "application/json",
    });
  });
});
