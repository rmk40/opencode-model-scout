import { describe, expect, it } from "vitest";
import { createServerKey } from "../src/catalog-snapshot";
import {
  serverBaseUrlFromPinnedClient,
  serverKeyFromPinnedClient,
} from "../src/tui-client-adapter";

describe("pinned TUI client adapter", () => {
  it("extracts the runtime own HeyApi client configuration", () => {
    const client = {
      client: {
        getConfig: () => ({ baseUrl: "https://atlas.test:8443/api/" }),
      },
    };
    expect(Object.hasOwn(client, "client")).toBe(true);
    expect(serverKeyFromPinnedClient(client)).toBe(
      createServerKey("https://atlas.test:8443/api"),
    );
  });

  it("normalizes the protected base URL before deriving correlation identity", () => {
    const client = {
      client: {
        getConfig: () => ({
          baseUrl:
            "https://Atlas:Atlas@atlas.test:8443/api///?Atlas=Atlas#Atlas",
        }),
      },
    };
    expect(serverBaseUrlFromPinnedClient(client)).toBe(
      "https://atlas.test:8443/api",
    );
    expect(serverKeyFromPinnedClient(client)).toBe(
      createServerKey("https://atlas.test:8443/api"),
    );
  });

  it("degrades when the protected runtime field is absent or inaccessible", () => {
    expect(serverKeyFromPinnedClient({})).toBeUndefined();
    expect(
      serverKeyFromPinnedClient({ client: { getConfig: () => ({}) } }),
    ).toBeUndefined();
    expect(
      serverKeyFromPinnedClient({
        client: {
          getConfig: () => {
            throw new Error("inaccessible");
          },
        },
      }),
    ).toBeUndefined();
    expect(
      serverKeyFromPinnedClient({
        client: { getConfig: () => ({ baseUrl: "file:///tmp/socket" }) },
      }),
    ).toBeUndefined();
    const inherited = Object.create({
      client: { getConfig: () => ({ baseUrl: "https://atlas.test" }) },
    }) as unknown;
    expect(serverKeyFromPinnedClient(inherited)).toBeUndefined();
    expect(
      serverKeyFromPinnedClient({ client: { getConfig: "Atlas" } }),
    ).toBeUndefined();
  });
});
