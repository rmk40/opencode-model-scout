import type { Plugin } from "@opencode/plugin/tui";
import { COMMAND_NAME, PLUGIN_ID } from "./constants";
import { ALL_PROVIDERS } from "./tui-browser";
import { closeBrowsers, openBrowser } from "./tui-session";

type Context = Plugin.Context;

const SHOW_COMMAND_ID = `${COMMAND_NAME}.show`;

function setup(context: Context): Plugin.Cleanup {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: SHOW_COMMAND_ID,
        title: "Model Scout",
        description:
          "Browse discovered models, their limits, prices, and capabilities",
        slash: { name: COMMAND_NAME },
        palette: true,
        run: async () => {
          await openBrowser(context, ALL_PROVIDERS);
        },
      },
    ],
  }));

  // A plugin reload would otherwise leave the old dialog on screen.
  return () => closeBrowsers(context);
}

const plugin: Plugin.Definition = { id: PLUGIN_ID, setup };

export default plugin;
