/**
 * Game view: record the board canvas itself — the scene, tokens, and
 * movement, with NO chat, sheets, windows, or UI — as its own 'game'
 * track from one player's point of view. The GM requests, the chosen
 * player consents, one active view at a time. Frames are captured only
 * while the session records.
 */
import { MOD, SOCKET, state, participantName, errNotify } from "./state.mjs";
import { refreshToolbar } from "./toolbar.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const REQUEST_TIMEOUT_MS = 60_000;

const gameView = {
  stream: null, // set only on the sharing client
  sharerName: null, // everyone's view of who shares, synced over the module socket
  pendingName: null, // GM only: outstanding request
  _pendingTimer: null,
  _requestOpen: false,
  _cleanup: null, // tears down the 1080p scaler pipeline, if one was needed
};

/** Foundry's board canvas (PIXI) — DOM UI lives on top and is never captured. */
function boardCanvas() {
  return canvas?.app?.view ?? canvas?.app?.renderer?.view ?? null;
}

export const isSharingGameView = () => !!gameView.stream;

function clearPending() {
  clearTimeout(gameView._pendingTimer);
  gameView._pendingTimer = null;
  gameView.pendingName = null;
}

// ---- module-socket protocol --------------------------------------------------

export function handleGameViewSocket(msg) {
  switch (msg?.action) {
    case "gv-request":
      if (msg.target === game.user.name) showShareRequest();
      break;
    case "gv-declined":
      if (game.user.isGM && gameView.pendingName === msg.name) {
        clearPending();
        ui.notifications.warn(`Session Recorder: ${msg.name} declined the game view request.`);
        refreshWindow();
      }
      break;
    case "gv-started":
      gameView.sharerName = msg.name;
      if (gameView.pendingName === msg.name) clearPending();
      refreshWindow();
      refreshToolbar();
      break;
    case "gv-stopped":
      if (gameView.sharerName === msg.name) gameView.sharerName = null;
      refreshWindow();
      refreshToolbar();
      break;
    case "gv-stop":
      if (msg.target === game.user.name) stopGameShare("the GM stopped your game view share.");
      break;
  }
}

/** Re-announce on someone's 'hello' so late joiners learn who shares. */
export function gameViewHello() {
  if (isSharingGameView()) game.socket.emit(SOCKET, { action: "gv-started", name: game.user.name });
}

/** The sharer dropped off the call: clear the state everywhere. */
export function gameViewPresenceCheck(onlineNames) {
  if (!gameView.sharerName || gameView.sharerName === game.user.name) return;
  if (onlineNames.has(gameView.sharerName)) return;
  gameView.sharerName = null;
  if (game.user.isGM) ui.notifications.warn("Session Recorder: the game view sharer disconnected — pick another player when ready.");
  refreshWindow();
  refreshToolbar();
}

// ---- sharer lifecycle --------------------------------------------------------

/**
 * Cap the recording at Full HD (1080p). The board's backbuffer is the
 * window size × display scaling — often well above 1080p — and panning
 * changes every pixel every frame, so oversized captures starve the
 * encoder's bitrate and macroblock during movement. Scaling goes through
 * a <video> element because drawImage straight from Foundry's WebGL
 * canvas is unreliable (PIXI doesn't preserve the drawing buffer).
 */
const MAX_W = 1920;
const MAX_H = 1080;

function scaledBoardStream(el) {
  const native = el.captureStream(30);
  const video = document.createElement("video");
  video.srcObject = native;
  video.muted = true;
  video.play();
  const scale = Math.min(MAX_W / el.width, MAX_H / el.height);
  const out = document.createElement("canvas");
  out.width = Math.round(el.width * scale);
  out.height = Math.round(el.height * scale);
  const ctx = out.getContext("2d");
  const timer = setInterval(() => {
    if (video.videoWidth) ctx.drawImage(video, 0, 0, out.width, out.height);
  }, 1000 / 30);
  return {
    stream: out.captureStream(30),
    cleanup: () => {
      clearInterval(timer);
      native.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    },
  };
}

async function startGameShare() {
  if (isSharingGameView()) return;
  if (!state.room) throw new Error("join the session first (Sessions & connection)");
  const el = boardCanvas();
  if (!el?.captureStream) throw new Error("no game canvas available to capture");
  let stream;
  try {
    if (el.width > MAX_W || el.height > MAX_H) {
      const scaled = scaledBoardStream(el);
      stream = scaled.stream;
      gameView._cleanup = scaled.cleanup;
    } else {
      stream = el.captureStream(30);
    }
  } catch {
    throw new Error("the browser blocked board capture — a scene asset loaded from another site without permissions can cause this");
  }
  gameView.stream = stream;
  gameView.sharerName = game.user.name;
  game.socket.emit(SOCKET, { action: "gv-started", name: game.user.name });
  if (state.recordingOn) await state.room.startRecording("game", stream);
  ui.notifications.info(
    `Session Recorder: sharing your game view${state.recordingOn ? " — recording now." : " — it records while the session records."}`,
  );
  refreshWindow();
  refreshToolbar();
}

export function stopGameShare(reason) {
  if (!isSharingGameView()) return;
  // Ending the tracks ends the 'game' recording; the segment uploads itself.
  gameView.stream.getTracks().forEach((t) => t.stop());
  gameView._cleanup?.();
  gameView._cleanup = null;
  gameView.stream = null;
  if (gameView.sharerName === game.user.name) gameView.sharerName = null;
  game.socket.emit(SOCKET, { action: "gv-stopped", name: game.user.name });
  if (reason) ui.notifications.info(`Session Recorder: ${reason}`);
  refreshWindow();
  refreshToolbar();
}

/** Called on every record-cycle start: an armed game view records with the
 *  session. Consent was given when the share was accepted — independent of
 *  the cam "Record me / Live only" choice. */
export function gameViewOnRecordStart() {
  if (!isSharingGameView() || !state.room) return;
  state.room.startRecording("game", gameView.stream).catch(errNotify);
}

// ---- the player-side consent ask ---------------------------------------------

function showShareRequest() {
  if (gameView._requestOpen) return;
  if (!state.room) {
    game.socket.emit(SOCKET, { action: "gv-declined", name: game.user.name });
    return;
  }
  gameView._requestOpen = true;
  foundry.applications.api.DialogV2.wait({
    window: { title: "Share your game view?" },
    content: `<p>The GM asks to record the <b>game board as you see it</b> — the scene, tokens,
              and movement only. Chat, character sheets, windows, and UI are never captured.</p>
              <p>It records whenever the session records, and you can stop any time from the
              Game view toolbar button.</p>`,
    buttons: [
      { action: "accept", label: "Share my game view", default: true },
      { action: "decline", label: "No thanks" },
    ],
    rejectClose: false,
  })
    .then((action) => {
      gameView._requestOpen = false;
      if (action === "accept") {
        startGameShare().catch((err) => {
          errNotify(err);
          game.socket.emit(SOCKET, { action: "gv-declined", name: game.user.name });
        });
      } else {
        game.socket.emit(SOCKET, { action: "gv-declined", name: game.user.name });
      }
    })
    .catch(() => {
      gameView._requestOpen = false;
    });
}

// ---- toolbar entry & the GM window -------------------------------------------

let app = null;

export function openGameView() {
  if (!game.user.isGM) {
    if (isSharingGameView()) {
      foundry.applications.api.DialogV2.confirm({
        window: { title: "Stop sharing your game view?" },
        content: "<p>The board recording from your point of view ends; everything captured so far uploads normally.</p>",
        rejectClose: false,
      }).then((ok) => {
        if (ok) stopGameShare("you stopped sharing your game view.");
      });
    } else {
      ui.notifications.info("Session Recorder: the GM can request your game view — you'll be asked to accept.");
    }
    return;
  }
  app ??= new GameViewWindow();
  app.render({ force: true });
}

function refreshWindow() {
  if (app?.rendered) app.render();
}

class GameViewWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "recvtt-game-view",
    classes: ["recvtt-control"],
    window: { title: "Game view recording", resizable: false, minimizable: true },
    position: { width: 360, height: "auto" },
  };
  static PARTS = {
    body: { template: `modules/${MOD}/templates/game-view.hbs` },
  };

  async _prepareContext(_options) {
    const roster = state.room?.roster;
    const online = state.lastPresence;
    const players = (roster?.participants ?? [])
      .filter((p) => p.id === state.room?.participantId || !online || online.has(p.id))
      .map((p) => ({ name: p.display_name, self: p.display_name === game.user.name }));
    return {
      joined: !!state.room,
      players,
      hasPlayers: players.length > 0,
      sharer: gameView.sharerName,
      pending: gameView.pendingName,
      recordingOn: state.recordingOn,
    };
  }

  _onRender(_context, _options) {
    const el = this.element;
    const picked = () => el.querySelector("[data-recvtt=gv-player]")?.value;
    el.querySelector("[data-recvtt=gv-request]")?.addEventListener("click", () => {
      const target = picked();
      if (target) this._request(target);
    });
    el.querySelector("[data-recvtt=gv-switch]")?.addEventListener("click", () => {
      const target = picked();
      if (!target || target === gameView.sharerName) return;
      this._stop();
      this._request(target);
    });
    el.querySelector("[data-recvtt=gv-stop]")?.addEventListener("click", () => {
      this._stop();
      this.render();
    });
    el.querySelector("[data-recvtt=gv-cancel]")?.addEventListener("click", () => {
      clearPending();
      this.render();
    });
  }

  _request(target) {
    if (target === game.user.name) {
      // The GM picked themselves — choosing IS the consent.
      startGameShare().catch(errNotify);
    } else {
      clearPending();
      gameView.pendingName = target;
      game.socket.emit(SOCKET, { action: "gv-request", target });
      gameView._pendingTimer = setTimeout(() => {
        if (gameView.pendingName !== target) return;
        clearPending();
        ui.notifications.warn(`Session Recorder: ${target} didn't answer the game view request.`);
        refreshWindow();
      }, REQUEST_TIMEOUT_MS);
    }
    this.render();
  }

  _stop() {
    if (gameView.sharerName === game.user.name) stopGameShare("you stopped sharing your game view.");
    else if (gameView.sharerName) game.socket.emit(SOCKET, { action: "gv-stop", target: gameView.sharerName });
  }
}
