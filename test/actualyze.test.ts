import { describe, expect, it } from "vitest";
import {
  registerActualyzeIntegration,
  type IntegrationEditor,
} from "../src/actualyze";

interface FakeIntegration {
  ref: { id: string; name: string };
  methods: Array<{ type: string; names?: readonly string[] }>;
}

/** Mirrors the host editor: `method.update` replaces a method of the same type. */
function fakeIntegrationEditor(initial: FakeIntegration[] = []) {
  const entries = new Map(initial.map((entry) => [entry.ref.id, entry]));
  const entry = (id: string): FakeIntegration => {
    const current = entries.get(id) ?? { ref: { id, name: id }, methods: [] };
    entries.set(id, current);
    return current;
  };
  const editor = {
    get: (id: string) => entries.get(id)?.ref,
    update: (id: string, update: (ref: FakeIntegration["ref"]) => void) =>
      update(entry(id).ref),
    method: {
      update: ({
        integrationID,
        method,
      }: {
        integrationID: string;
        method: FakeIntegration["methods"][number];
      }) => {
        const methods = entry(integrationID).methods;
        const index = methods.findIndex((m) => m.type === method.type);
        if (index === -1) methods.push(method);
        else methods[index] = method;
      },
    },
  } as unknown as IntegrationEditor;
  return { editor, entries };
}

describe("registerActualyzeIntegration", () => {
  it("offers a stored key and the ACTUALYZE_API_KEY variable under the provider's ID", () => {
    const { editor, entries } = fakeIntegrationEditor();
    registerActualyzeIntegration(editor);
    expect([...entries.keys()]).toEqual(["actualyze"]);
    expect(entries.get("actualyze")).toEqual({
      ref: { id: "actualyze", name: "Actualyze" },
      methods: [{ type: "key" }, { type: "env", names: ["ACTUALYZE_API_KEY"] }],
    });
  });

  it("adds nothing next to an actualyze integration registered by a catalog", () => {
    const catalog: FakeIntegration = {
      ref: { id: "actualyze", name: "Actualyze (catalog)" },
      methods: [{ type: "env", names: ["ATLAS_API_KEY"] }],
    };
    const { editor, entries } = fakeIntegrationEditor([
      structuredClone(catalog),
    ]);
    registerActualyzeIntegration(editor);
    expect([...entries.values()]).toEqual([catalog]);
  });

  it("does not throw when the editor rejects an update", () => {
    const { editor } = fakeIntegrationEditor();
    (editor.method as { update: unknown }).update = () => {
      throw new Error("rejected");
    };
    expect(() => registerActualyzeIntegration(editor)).not.toThrow();
  });
});
