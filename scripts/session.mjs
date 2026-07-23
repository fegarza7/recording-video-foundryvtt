/**
 * Session lifecycle: joining the live room, roster-driven recording,
 * teardown, and the module-socket messages.
 */
import { SOCKET, state, setting, sdk, participantName } from "./state.mjs";
import {
  camWindows,
  camStates,
  openCamWindow,
  closeCamWindow,
  refreshCamWindowFor,
  broadcastCamState,
  resetCaptureStates,
} from "./cam-windows.mjs";
import { screenShare, areaBox } from "./screen-share.mjs";
import { refreshToolbar } from "./toolbar.mjs";
import { renderSettingsIfOpen } from "./dialogs.mjs";
import { openGreenRoom } from "./green-room.mjs";
import {
  handleGameViewSocket,
  gameViewHello,
  gameViewPresenceCheck,
  gameViewOnRecordStart,
  isSharingGameView,
  stopGameShare,
} from "./game-view.mjs";
import { startCamTelemetry, stopCamTelemetry } from "./telemetry.mjs";
import { camConstraints, watchCamTracks } from "./av-devices.mjs";
import { startLocalCapture, showRecordRequest, showRecordingNotice } from "./record-consent.mjs";
import { attachAudio } from "./remote-audio.mjs";

export function onSocketMessage(msg) {
  switch (msg?.action) {
    case "session-started":
      promptJoin(msg.invite, false);
      break;
    case "join-nudge":
      // Re-prompt anyone who missed (or dismissed) the original invite.
      if (!state.room && msg.invite) promptJoin(msg.invite, false);
      break;
    case "session-closed":
      teardown("The GM closed the recording session.");
      break;
    case "hello":
      // A client joined and wants everyone's current mic/cam state.
      if (state.room) {
        broadcastCamState();
        gameViewHello();
      }
      break;
    case "cam-state":
      camStates.set(msg.name, { micOn: msg.micOn, camOn: msg.camOn, capturing: msg.capturing ?? null });
      refreshCamWindowFor(msg.name);
      break;
    case "record-request":
      // GM asks a live-only player to reconsider — always a question,
      // never a force-start.
      if (msg.name === game.user.name) showRecordRequest();
      break;
    default:
      handleGameViewSocket(msg); // gv-* actions live in game-view.mjs
  }
}

// ---- joining & the live room --------------------------------------------------

/** Every join path leads to the green room: preview, device choice, and
 *  explicit consent — nothing is captured or shared before that. */
export async function promptJoin(invite, isRejoin) {
  if (state.room) return;
  openGreenRoom(invite, isRejoin);
}

/** Stop streaming entirely and leave the live session (rejoin any time
 *  from Sessions & connection) — stronger than mute/hide, which keep you
 *  in the call. */
export async function leaveSession() {
  if (!state.room) return;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Leave the session?" },
    content: `<p>Your camera and microphone stop streaming and recording entirely.
              Anything already uploaded stays with the session, and you can rejoin
              any time from <b>Sessions &amp; connection</b>.</p>`,
    rejectClose: false,
  });
  if (!ok) return;
  teardown("You left the session — nothing more is streamed or recorded. Rejoin any time from Sessions & connection.");
  renderSettingsIfOpen();
}

export async function joinRoom(invite, opts = {}) {
  if (state.room) return;
  const apiBase = setting("apiBase");
  state.avPrefs = { camId: opts.camId ?? "", micId: opts.micId ?? "" };
  state.camStream = await navigator.mediaDevices.getUserMedia(camConstraints());

  state.room = await sdk().Room.join({ apiBase, inviteToken: invite, displayName: game.user.name });

  openCamWindow("self", `${game.user.name} (you)`, state.camStream);
  // Honor the green-room toggles before anything is published or recorded:
  // a disabled track records black/silence, same as the in-call toggles.
  if (opts.camOff || opts.micMuted) {
    const selfWin = camWindows.get("self");
    if (selfWin) {
      if (opts.camOff) selfWin.camOn = false;
      if (opts.micMuted) selfWin.micOn = false;
      selfWin._applyTracks();
      selfWin.render();
    }
  }

  state.room.on("roster", onRoster);
  state.room.on("stream", (pid, kind, trackName, stream) => {
    if (kind !== "cam") return; // webcams only — the map IS the Foundry canvas
    if (trackName.endsWith("-video")) {
      openCamWindow(pid, participantName(pid), stream);
      refreshCamWindowFor(participantName(pid));
      // A window opened mid-recording still shows the red dot.
      camWindows.get(pid)?.setRecording(state.recordingOn);
    } else {
      attachAudio(pid, stream);
    }
  });
  state.room.on("streamLive", (pid, kind, trackName, live) => {
    if (kind === "cam" && trackName.endsWith("-video")) camWindows.get(pid)?.setStale(!live);
  });
  state.room.on("presence", (online) => {
    state.lastPresence = online;
    for (const [pid] of camWindows) {
      if (pid !== "self" && !online.has(pid)) closeCamWindow(pid);
    }
    const onlineNames = new Set(
      (state.room?.roster?.participants ?? []).filter((p) => online.has(p.id)).map((p) => p.display_name),
    );
    gameViewPresenceCheck(onlineNames);
  });
  state.room.on("control", (action) => {
    if (action === "close")
      teardown("The GM ended the session. Uploads finish in the background — keep Foundry open until done.");
  });

  const live = await state.room.connectLiveCall();
  if (live) await state.room.publish(state.camStream, "cam");
  else ui.notifications.warn("Session Recorder: live preview unavailable; recording still works.");

  watchCamTracks();
  startCamTelemetry();
  game.socket.emit(SOCKET, { action: "hello" });
  broadcastCamState();
  renderSettingsIfOpen();
  refreshToolbar();
}

function onRoster(roster) {
  for (const p of roster.participants) {
    if (p.id !== state.room.participantId) {
      state.room.pull(p.id, "cam");
      // GM-enforced flags travel in the roster — every client shows the
      // portrait / mic badge for a muted participant, Foundry or web.
      camWindows.get(p.id)?.setPlatformState(!!p.mic_muted, !!p.cam_muted);
    } else {
      // Enforce host controls on OUR OWN tracks (host wins over local
      // toggles) — this is what makes a GM mute real for everyone.
      camWindows.get("self")?.setPlatformState(!!p.mic_muted, !!p.cam_muted);
    }
  }
  const status = roster.session.status;
  if (status === "recording" && !state.recordingOn) {
    state.recordPending = false;
    state.recordingOn = true;
    // Fresh cycle: nobody's capture choice is known until they make it.
    resetCaptureStates();
    for (const win of camWindows.values()) win.setRecording(true);
    refreshToolbar();
    if (game.user.isGM) {
      // The GM pressed the button — that IS their confirmation.
      startLocalCapture();
      ui.notifications.info("Session Recorder: recording started.");
    } else {
      // Players capture NOTHING until they confirm in the notice.
      showRecordingNotice();
    }
    // An armed game view was consented separately — it records with the cycle.
    gameViewOnRecordStart();
  }
  if (status !== "recording" && state.recordingOn && !state.draining) {
    state.recordPending = false;
    state.recordingOn = false;
    state.recordNoticeShown = false;
    for (const win of camWindows.values()) win.setRecording(false);
    camWindows.get("self")?.setCapturing(null);
    // A live-only player can still have a game-view recording running.
    if (state.capturing || isSharingGameView()) {
      state.capturing = false;
      state.draining = true;
      state.room.stopRecording();
      ui.notifications.info("Session Recorder: recording stopped — uploading the remainder…");
      state.room.waitForUploads().then(() => {
        state.draining = false;
        ui.notifications.info("Session Recorder: all uploads complete. Your recording is safe.");
        renderSettingsIfOpen();
      });
    }
    refreshToolbar();
  }
  renderSettingsIfOpen();
}

export function teardown(message) {
  // The close arrives on two channels (platform control + module
  // socket); only announce and clean up once. Every step is isolated so
  // one failure can't leave the session half-alive.
  const wasActive = !!state.room || !!state.camStream;
  const safely = (fn) => {
    try {
      fn();
    } catch (err) {
      console.error("recorder-vtt | teardown step failed", err);
    }
  };
  safely(() => stopCamTelemetry());
  safely(() => stopGameShare(null));
  safely(() => state.room?.leave());
  state.room = null;
  state.recordingOn = false;
  state.recordNoticeShown = false;
  state.capturing = false;
  safely(() => state.camStream?.getTracks().forEach((t) => t.stop()));
  state.camStream = null;
  safely(() => screenShare.stop());
  safely(() => areaBox.remove());
  for (const pid of [...camWindows.keys()]) safely(() => closeCamWindow(pid));
  if (message && wasActive) ui.notifications.info(`Session Recorder: ${message}`);
  safely(() => refreshToolbar());
}
