import type { Plugin } from "@opencode/plugin/tui";
import {
  ACTUALYZE_COMMAND_NAME,
  ACTUALYZE_NAME,
  COMMAND_NAME,
  PLUGIN_ID,
} from "./constants";
import { closeActualyze, openActualyze } from "./tui-actualyze-view";
import { ALL_PROVIDERS } from "./tui-browser";
import { closeBrowsers, openBrowser } from "./tui-session";

type Context = Plugin.Context;

const SHOW_COMMAND_ID = `${COMMAND_NAME}.show`;
const ACTUALYZE_COMMAND_ID = `${ACTUALYZE_COMMAND_NAME}.show`;
/** Palette category of both commands. */
const COMMAND_GROUP = "Models";

function setup(context: Context): Plugin.Cleanup {
  const showModelScout = async (): Promise<void> => {
    await openBrowser(context, ALL_PROVIDERS, {
      actualyze: () => void showActualyze(),
    });
  };
  const showActualyze = async (): Promise<void> => {
    await openActualyze(context, {
      openModelScout: () => void showModelScout(),
    });
  };

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: SHOW_COMMAND_ID,
        title: "Model Scout",
        description:
          "Browse discovered models, their limits, prices, and capabilities",
        group: COMMAND_GROUP,
        slash: { name: COMMAND_NAME },
        palette: true,
        run: showModelScout,
      },
      {
        id: ACTUALYZE_COMMAND_ID,
        title: ACTUALYZE_NAME,
        description:
          "Connect an Actualyze API key and browse the models it can reach",
        group: COMMAND_GROUP,
        slash: { name: ACTUALYZE_COMMAND_NAME },
        palette: true,
        run: showActualyze,
      },
    ],
  }));

  // A plugin reload would otherwise leave the old dialog on screen.
  return () => {
    closeActualyze(context);
    closeBrowsers(context);
  };
}

const plugin: Plugin.Definition = { id: PLUGIN_ID, setup };

export default plugin;
