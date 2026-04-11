import type { PluginInput } from "@opencode-ai/plugin";
import { getDiscoveryStore, type DiscoverySnapshot } from "./discover";
import { COMMAND_SENTINEL, LOG_PREFIX, COMMAND_NAME } from "./constants";

/**
 * Handle the slash command.
 */
export async function handleCommand(
  client: PluginInput["client"],
  sessionID: string,
  args: string,
): Promise<never> {
  const store = getDiscoveryStore();
  const useJson = (args || "").trim().split(/\s+/).includes("--json");

  const text = useJson
    ? JSON.stringify(store, null, 2)
    : formatModelsTable(store);

  if (!client.session) {
    console.warn(
      `${LOG_PREFIX} Session client unavailable for /${COMMAND_NAME}`,
    );
    throw new Error(COMMAND_SENTINEL);
  }

  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text, ignored: true }],
    },
  });

  throw new Error(COMMAND_SENTINEL);
}

/**
 * Format discovery results as a human-readable table.
 * Pure function — no side effects.
 */
export function formatModelsTable(
  snapshots: readonly DiscoverySnapshot[],
): string {
  if (snapshots.length === 0) {
    return "Models Discovery\n\nNo models discovered. Providers may be offline or excluded by config.";
  }

  const sections: string[] = ["Models Discovery"];

  for (const snap of snapshots) {
    const discovered = Object.keys(snap.models).length;
    const total = discovered + snap.skipped.length;
    const probeLabel = snap.detectedServer
      ? `auto \u2192 ${snap.detectedServer}`
      : snap.probeType
        ? `probe: ${snap.probeType}`
        : "no probe";
    const countLabel =
      snap.skipped.length > 0
        ? `${total} model${total !== 1 ? "s" : ""} (${discovered} new)`
        : `${discovered} model${discovered !== 1 ? "s" : ""}`;
    const header = `\n${snap.provider} (${probeLabel}) — ${countLabel}`;
    const separator = "\u2500".repeat(50);

    sections.push(header);
    sections.push(separator);

    for (const [id, model] of Object.entries(snap.models)) {
      sections.push(`  ${id}`);

      const parts: string[] = [];

      // Context and output limits
      const limit = model.limit as
        | { context?: number; output?: number }
        | undefined;
      if (limit?.context) parts.push(`Context: ${formatNumber(limit.context)}`);
      if (limit?.output) parts.push(`Output: ${formatNumber(limit.output)}`);

      // Model type from modalities
      if (model.modalities) {
        const mod = model.modalities as {
          input?: string[];
          output?: string[];
        };
        if (mod.output?.includes("embedding")) {
          parts.push("Type: embedding");
        } else if (mod.input?.includes("image")) {
          parts.push("Type: vlm");
        } else {
          parts.push("Type: llm");
        }
      }

      // Capability flags
      const flags: string[] = [];
      if (model.attachment) flags.push("Vision");
      if (model.tool_call) flags.push("Tools");
      if (model.reasoning) flags.push("Reasoning");
      if (model.temperature) flags.push("Temp");
      if (flags.length > 0) parts.push(flags.join(", "));

      // Family and probe details (values are strings from probe metadata)
      if (model.family) parts.push(`Family: ${model.family as string}`);
      if (model.parameterSize)
        parts.push(`Params: ${model.parameterSize as string}`);
      if (model.quantization)
        parts.push(`Quant: ${model.quantization as string}`);
      if (model.sizeBytes)
        parts.push(`Size: ${formatBytes(model.sizeBytes as number)}`);

      if (parts.length > 0) {
        sections.push(`    ${parts.join(" | ")}`);
      }
    }

    if (snap.skipped.length > 0) {
      sections.push(
        `\n  Already configured (${snap.skipped.length}): ${snap.skipped.join(", ")}`,
      );
    }
  }

  return sections.join("\n");
}

/** Format a number with comma separators: 262144 → "262,144" */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format bytes as human-readable: 20285680936 → "18.9 GB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
