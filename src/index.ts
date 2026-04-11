import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { discoverModels } from "./discover";
import { handleCommand } from "./command";
import { fetchModelsDevIndex } from "./models-dev";
import {
  COMMAND_NAME,
  COMMAND_TEMPLATE,
  COMMAND_DESCRIPTION,
  COMMAND_SENTINEL,
  PLUGIN_NAME,
} from "./constants";

/** Extended hooks type that includes command.execute.before (runtime-supported). */
interface PluginHooks extends Hooks {
  "command.execute.before": (input: {
    command: string;
    sessionID: string;
    arguments: string;
  }) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/require-await
const plugin: Plugin = async (input: PluginInput) => {
  const { client } = input;

  if (!client || typeof client !== "object") {
    return {
      config: async () => {},
    };
  }

  const hooks: PluginHooks = {
    config: async (config) => {
      // Register slash command
      if (config) {
        const commands = (config.command ?? {}) as Record<
          string,
          {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            subtask?: boolean;
          }
        >;
        commands[COMMAND_NAME] = {
          template: COMMAND_TEMPLATE,
          description: COMMAND_DESCRIPTION,
        };
        config.command = commands;
      }

      const configRecord = config as unknown as Record<string, unknown>;
      const modelsDevIndex = await fetchModelsDevIndex();

      // Run discovery with 5-second timeout.
      // AbortSignal.timeout handles both unblocking the caller and
      // cancelling in-flight HTTP work (via probeFetch signal composition).
      try {
        await discoverModels(
          configRecord,
          modelsDevIndex,
          AbortSignal.timeout(5000),
        );
      } catch {
        // timeout or error — opencode starts normally
      }
    },

    "command.execute.before": async (input: {
      command: string;
      sessionID: string;
      arguments: string;
    }) => {
      if (input.command !== COMMAND_NAME) return;
      try {
        await handleCommand(client, input.sessionID, input.arguments);
      } catch (err) {
        if (err instanceof Error && err.message === COMMAND_SENTINEL) throw err;
        const message = err instanceof Error ? err.message : String(err);
        await client.session?.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: `${PLUGIN_NAME} (error)\n\n${message}`,
                ignored: true,
              },
            ],
          },
        });
        throw new Error(COMMAND_SENTINEL);
      }
    },
  };

  return hooks;
};

export default plugin;
