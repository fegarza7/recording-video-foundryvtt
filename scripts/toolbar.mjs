/**
 * Toolbar: one scene-controls group whose tools are the whole UX —
 * Settings, Stream area/window, Record toggle, Videos.
 */
import { MOD, state, activeSession, errNotify } from "./state.mjs";
import { gmSetRecording } from "./session.mjs";
import { screenShare, areaBox } from "./screen-share.mjs";
import { showAllCams } from "./cam-windows.mjs";
import { openSettings, openVideos } from "./dialogs.mjs";
import { openGameView, isSharingGameView } from "./game-view.mjs";

function registerToolbar() {
  Hooks.on("getSceneControlButtons", (controls) => {
    const isGM = game.user.isGM;

    // Inert anchor tool: groups need an activeTool, and a real button
    // there would auto-fire when the submenu opens. Hidden via CSS.
    const tools = [
      { name: "recvtt-anchor", title: "Session Recorder", icon: "fas fa-video", order: 0 },
      {
        name: "settings",
        title: "Sessions & connection",
        icon: "fas fa-sliders-h",
        button: true,
        order: 1,
        onChange: () => openSettings(),
      },
    ];

    tools.push({
      name: "cams",
      title: "Show camera windows",
      icon: "fas fa-camera",
      button: true,
      order: 1.5,
      onChange: () => showAllCams(),
    });

    // Everyone sees Game view: the GM manages it; a sharing player uses
    // it to stop; everyone else gets a what-is-this notification.
    tools.push({
      name: "gameview",
      title: "Game view recording",
      icon: "fas fa-chess-board",
      button: true,
      order: 2.7,
      onChange: () => openGameView(),
    });

    if (isGM) {
      tools.push({
        name: "area",
        title: "Stream an area",
        icon: "fas fa-object-group",
        button: true,
        order: 2,
        onChange: () => areaBox.toggle(),
      });
      tools.push({
        name: "window",
        title: "Stream a tab or window",
        icon: "fas fa-desktop",
        button: true,
        order: 2.5,
        // Plain button, not a toggle — never trust an `active` argument,
        // decide from actual state.
        onChange: () => {
          if (screenShare.mode === "window") screenShare.stop("window");
          else screenShare.startWindow().catch(errNotify);
        },
      });
      tools.push({
        name: "record",
        title: "Start recording",
        icon: "fas fa-circle",
        button: true,
        order: 3,
        // Plain button + live state (see 'window' tool note): if the
        // session is recording, stop; otherwise start.
        onChange: () => {
          if (state.recordPending) return; // ignore clicks until the roster confirms
          if (!activeSession() || !state.room) {
            ui.notifications.warn("Session Recorder: create a session first (Sessions & connection).");
            return;
          }
          state.recordPending = true;
          setTimeout(() => (state.recordPending = false), 6000); // safety valve
          const status = state.room.roster?.session.status;
          gmSetRecording(status !== "recording").catch(errNotify);
        },
      });
      tools.push({
        name: "videos",
        title: "Sessions & downloads",
        icon: "fas fa-photo-video",
        button: true,
        order: 4,
        onChange: () => openVideos(),
      });
    }

    if (Array.isArray(controls)) {
      // v12: array of groups, tools arrays, onClick callback name.
      controls.push({
        name: MOD,
        title: "Session Recorder",
        icon: "fas fa-video",
        visible: true,
        activeTool: "recvtt-anchor",
        tools: tools.map((t) => (t.onChange ? { ...t, onClick: t.onChange } : t)),
      });
    } else {
      // v13+: Records for groups and tools.
      controls[MOD] = {
        name: MOD,
        title: "Session Recorder",
        icon: "fas fa-video",
        order: 100,
        visible: true,
        activeTool: "recvtt-anchor",
        tools: Object.fromEntries(tools.map((t) => [t.name, t])),
      };
    }
  });

  Hooks.on("renderSceneControls", () => refreshToolbar());
}

/**
 * All stateful visuals are DOM patches — never rebuild the toolbar config;
 * just repaint the two stateful buttons.
 */
const refreshToolbar = () => {
  patchTool("record", {
    on: state.recordingOn,
    className: "recvtt-recording",
    iconOn: "fas fa-stop",
    iconOff: "fas fa-circle",
    tipOn: "Stop recording",
    tipOff: "Start recording",
  });
  patchTool("window", {
    on: screenShare.mode === "window",
    className: "recvtt-sharing",
    iconOn: "fas fa-desktop",
    iconOff: "fas fa-desktop",
    tipOn: "Stop sharing the tab/window",
    tipOff: "Stream a tab or window",
  });
  patchTool("gameview", {
    on: isSharingGameView(),
    className: "recvtt-sharing",
    iconOn: "fas fa-chess-board",
    iconOff: "fas fa-chess-board",
    tipOn: "Sharing your game view — click to stop",
    tipOff: "Game view recording",
  });
};

function patchTool(name, visual) {
  const btn = document.querySelector(`[data-tool="${name}"]`);
  if (!btn) return;
  btn.classList.toggle(visual.className, visual.on);
  const icon = btn.querySelector("i");
  if (icon) icon.className = visual.on ? visual.iconOn : visual.iconOff;
  const tip = visual.on ? visual.tipOn : visual.tipOff;
  btn.dataset.tooltip = tip; // v13+
  btn.setAttribute("aria-label", tip);
  if (btn.title !== undefined) btn.title = tip; // v12
}

export { registerToolbar, refreshToolbar };
