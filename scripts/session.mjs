/**
 * Session lifecycle: joining the live room, roster-driven recording,
 * GM actions, teardown, and the module-socket messages.
 */
import { MOD, SOCKET, state, setting, sdk, activeSession, requireClient, moduleProject, participantName, errNotify } from "./state.mjs";
import {
  camWindows,
  camStates,
  openCamWindow,
  closeCamWindow,
  attachAudio,
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

// ---- GM actions --------------------------------------------------------------

export async function gmCreateSession() {
  const client = requireClient();
  if (!client) return;
  // Plain hyphen: users must be able to TYPE this name (delete confirmation).
  const name = `${game.world.title} - ${new Date().toLocaleDateString()}`;
  const project = await moduleProject(client);
  const { session } = await client.createSession(name, project.id);
  await game.settings.set(
    MOD,
    "activeSession",
    JSON.stringify({ sessionId: session.id, invite: session.invite_token }),
  );
  game.socket.emit(SOCKET, { action: "session-started", invite: session.invite_token });
  // The GM consents like everyone else — no silent camera grab.
  openGreenRoom(session.invite_token, false);
  renderSettingsIfOpen();
  refreshToolbar();
}

export async function gmSetRecording(on) {
  const client = requireClient();
  const active = activeSession();
  if (!client || !active) return;
  try {
    if (on) {
      await client.startRecording(active.sessionId);
      // Nudge anyone who never joined — recording starting is the moment
      // it matters most that everyone's camera is in.
      game.socket.emit(SOCKET, { action: "join-nudge", invite: active.invite });
    } else {
      await client.stopRecording(active.sessionId);
    }
  } catch (err) {
    // 409 = the platform is already in the requested state (roster lag,
    // double click). The next roster push syncs us — not an error.
    if (err?.status === 409) {
      console.warn("recorder-vtt | record toggle ignored:", err.message);
      return;
    }
    throw err;
  }
}

/** GM toggles a platform-enforced control on another participant. */
export async function gmToggleParticipant(pid, which) {
  const client = requireClient();
  const active = activeSession();
  const p = state.room?.roster?.participants.find((x) => x.id === pid);
  if (!client || !active || !p) return;
  const controls = which === "mic" ? { micMuted: !p.mic_muted } : { camMuted: !p.cam_muted };
  await client.setParticipantControls(active.sessionId, pid, controls);
}

export async function gmCloseForEveryone() {
  const client = requireClient();
  const active = activeSession();
  // Guards are loud, and the local side ALWAYS tears down — the UI must
  // never look stuck on a session the platform already forgot.
  if (!client) return;
  if (!active) {
    ui.notifications.warn("Session Recorder: no active session recorded — clearing local state.");
    teardown();
    renderSettingsIfOpen();
    return;
  }
  try {
    await client.closeForEveryone(active.sessionId);
  } catch (err) {
    ui.notifications.warn(`Session Recorder: platform close failed (${err.message}) — closing locally anyway.`);
  }
  await game.settings.set(MOD, "activeSession", "");
  game.socket.emit(SOCKET, { action: "session-closed" });
  teardown("Session closed. Keep this window open until uploads reach 100%.");
  renderSettingsIfOpen();
  refreshToolbar();
}

// ---- joining & the live room --------------------------------------------------

/** Every join path leads to the green room: preview, device choice, and
 *  explicit consent — nothing is captured or shared before that. */
export async function promptJoin(invite, isRejoin) {
  if (state.room) return;
  openGreenRoom(invite, isRejoin);
}

const CAM_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
};

/** Base constraints + the devices chosen in the green room (if any). */
function camConstraints() {
  const prefs = state.avPrefs ?? {};
  return {
    video: { ...CAM_CONSTRAINTS.video, ...(prefs.camId ? { deviceId: { exact: prefs.camId } } : {}) },
    audio: { ...CAM_CONSTRAINTS.audio, ...(prefs.micId ? { deviceId: { exact: prefs.micId } } : {}) },
  };
}

/** Re-acquire and hot-swap when a camera/mic track dies (device off,
 *  permission blip, OS switch) — the failure that used to require F5. */
function watchCamTracks() {
  for (const t of state.camStream?.getTracks() ?? []) {
    t.addEventListener("ended", () => reacquireCamera().catch(errNotify), { once: true });
  }
}

/** Swap our live+recorded stream for a fresh one (device change or device
 *  death): sender-level replace, no renegotiation. If capturing, the old
 *  segment closed with its track and a new file continues from here. */
async function adoptFreshStream(fresh) {
  const old = state.camStream;
  state.camStream = fresh;
  old.getTracks().forEach((t) => t.stop());
  await state.room.replaceLocalStream("cam", fresh);
  const selfWin = camWindows.get("self");
  selfWin?.setStream(fresh);
  selfWin?._applyTracks();
  watchCamTracks();
  if (state.capturing) {
    await state.room.startRecording("cam", fresh);
  }
}

async function reacquireCamera() {
  if (!state.room || !state.camStream) return;
  ui.notifications.warn("Session Recorder: camera or mic lost — reconnecting…");
  state.room.log("warn", "cam-reacquire");
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(camConstraints());
  } catch (err) {
    state.room.log("error", "cam-reacquire-failed", err.message);
    ui.notifications.error("Session Recorder: could not reconnect the camera — check device/permissions, then toggle your camera.");
    return;
  }
  await adoptFreshStream(fresh);
  ui.notifications.info("Session Recorder: camera reconnected.");
}

/** Mid-session device switch, from the ⚙ button on your own cam window. */
export async function openDeviceSwitch() {
  if (!state.room || !state.camStream) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const currentCam = state.camStream.getVideoTracks()[0]?.getSettings().deviceId ?? "";
  const currentMic = state.camStream.getAudioTracks()[0]?.getSettings().deviceId ?? "";
  const options = (kind, selected, fallback) =>
    devices
      .filter((d) => d.kind === kind)
      .map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === selected ? "selected" : ""}>${d.label || `${fallback} ${i + 1}`}</option>`)
      .join("");
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: "Change camera / microphone" },
    content: `<div class="recvtt-devswitch">
                <label>Camera <select name="recvtt-cam">${options("videoinput", currentCam, "Camera")}</select></label>
                <label>Microphone <select name="recvtt-mic">${options("audioinput", currentMic, "Microphone")}</select></label>
                <p class="recvtt-hint">If you're being recorded, the recording continues as a new file after the switch.</p>
              </div>`,
    buttons: [
      {
        action: "apply",
        label: "Switch",
        default: true,
        callback: (_event, button) => ({
          cam: button.form.elements["recvtt-cam"].value,
          mic: button.form.elements["recvtt-mic"].value,
        }),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
  if (!picked || typeof picked !== "object") return;
  state.avPrefs = { camId: picked.cam, micId: picked.mic };
  await game.settings.set(MOD, "camDevice", picked.cam);
  await game.settings.set(MOD, "micDevice", picked.mic);
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(camConstraints());
  } catch (err) {
    ui.notifications.error(`Session Recorder: could not switch devices — ${err.message}`);
    return;
  }
  await adoptFreshStream(fresh);
  ui.notifications.info("Session Recorder: devices switched.");
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

/** Begin capturing on THIS client. GM: immediately on record press.
 *  Players: only from the recording-notice confirmation below. */
function startLocalCapture() {
  if (!state.room || !state.recordingOn || state.capturing) return;
  state.capturing = true;
  state.room.startRecording("cam", state.camStream).catch((err) => {
    state.capturing = false;
    camWindows.get("self")?.setCapturing(false);
    broadcastCamState();
    ui.notifications.error(`Session Recorder: recording failed — ${err.message}`);
  });
  if (screenShare.stream) {
    state.room.startRecording("screen", screenShare.stream).catch(errNotify);
  }
  // Everyone's windows show the truth: this participant IS recorded.
  camWindows.get("self")?.setCapturing(true);
  broadcastCamState();
}

/** A live-only player changed their mind (own webcam button) — start
 *  capturing mid-cycle; the recording continues as a new file from now. */
export function selfStartCapture() {
  if (!state.room || !state.recordingOn || state.capturing) return;
  startLocalCapture();
  ui.notifications.info("Session Recorder: your recording started.");
}

let recordRequestOpen = false;
/** The GM's re-ask, delivered to a live-only player. Same rules as the
 *  original dialog: the player decides. */
function showRecordRequest() {
  if (game.user.isGM || recordRequestOpen) return;
  if (!state.room || !state.recordingOn || state.capturing) return;
  recordRequestOpen = true;
  foundry.applications.api.DialogV2.wait({
    window: { title: "The GM asks to record you" },
    content: `<p>You're currently sharing <b>live only</b>. The GM asked whether you'd like to
              be recorded after all — starting now, nothing before this moment was captured.</p>`,
    buttons: [
      { action: "start", label: "Record me", default: true },
      { action: "stay", label: "Stay live only" },
    ],
    rejectClose: false,
  })
    .then((action) => {
      recordRequestOpen = false;
      if (action === "start") selfStartCapture();
    })
    .catch(() => {
      recordRequestOpen = false;
    });
}

/** The gate: a player's camera and mic are NOT captured until they press
 *  Start here — the GM's record press alone never records anyone else.
 *  Dismissing the dialog re-opens it (this is a binary moment: record or
 *  leave); once per recording cycle. */
function showRecordingNotice() {
  if (game.user.isGM || state.recordNoticeShown) return;
  state.recordNoticeShown = true;
  const ask = () =>
    foundry.applications.api.DialogV2.wait({
      window: { title: "The GM started recording" },
      content: `<p><b>Nothing is being recorded on your machine yet.</b> Choose how to take part
                in this recording:</p>
                <p><b>Record me</b> — your camera and microphone are captured in full quality
                (a red dot marks recorded participants).<br />
                <b>Live only</b> — you stay in the call and everyone sees and hears you, but
                nothing of yours is captured; your voice and face appear in no files.<br />
                <b>Leave</b> — disconnect from the session entirely.</p>
                <p>You can mute or turn your camera off at any time.</p>`,
      buttons: [
        { action: "start", label: "Record me", default: true },
        { action: "liveonly", label: "Live only — don't record me" },
        { action: "leave", label: "Leave session" },
      ],
      rejectClose: false,
    })
      .then((action) => {
        // The moment may have passed (GM stopped) — never start stale.
        if (!state.room || !state.recordingOn) return;
        if (action === "start") {
          startLocalCapture();
          ui.notifications.info("Session Recorder: your recording started.");
        } else if (action === "liveonly") {
          camWindows.get("self")?.setCapturing(false);
          broadcastCamState();
          ui.notifications.info("Session Recorder: sharing live only — nothing is recorded on your machine this cycle.");
        } else if (action === "leave") {
          teardown("You left the session — nothing was recorded on your machine.");
        } else {
          ask(); // dismissed without choosing: the question stands
        }
      })
      .catch(() => {});
  ask();
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
