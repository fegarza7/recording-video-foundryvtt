/**
 * Module entry point: settings registration, ready wiring, socket dispatch.
 */
import { MOD, SOCKET, sdk, activeSession } from "./state.mjs";
import { onSocketMessage, promptJoin } from "./session.mjs";
import { registerToolbar } from "./toolbar.mjs";

Hooks.once("init", () => {
  game.settings.register(MOD, "apiBase", {
    name: "Recorder API base URL",
    hint: "Where your recorder platform lives.",
    scope: "world",
    config: true,
    type: String,
    default: "https://recorder-api-staging.fergarza7.workers.dev",
  });
  game.settings.register(MOD, "apiToken", {
    name: "Personal API token (GM)",
    hint: "Generate one on the dashboard under 'API tokens'. Only the GM needs this.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MOD, "activeSession", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
  // Per-player, per-browser cam window layout: { [name]: {left,top,width,height} }.
  game.settings.register(MOD, "camLayout", {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  registerToolbar();
});

Hooks.once("ready", () => {
  if (!sdk()) {
    ui.notifications?.error("Session Recorder: SDK bundle failed to load.");
    return;
  }
  game.socket.on(SOCKET, onSocketMessage);
  // Anything that never reached 100% (closed tab, ended session) drains now.
  sdk()
    .resumePendingUploads(game.settings.get(MOD, "apiBase"))
    .then(({ resumed }) => {
      if (resumed > 0) ui.notifications.info(`Session Recorder: resumed ${resumed} unfinished upload(s) — now safe.`);
    })
    .catch(() => {});
  // If a session is already live (player refreshed mid-game), offer to rejoin.
  const active = activeSession();
  if (active) promptJoin(active.invite, true);
});
