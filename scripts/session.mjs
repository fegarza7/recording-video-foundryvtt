/**
 * Session lifecycle: joining the live room, roster-driven recording,
 * GM actions, teardown, and the module-socket messages.
 */
import { MOD, SOCKET, state, setting, sdk, activeSession, requireClient, participantName, errNotify } from "./state.mjs";
import {
  camWindows,
  camStates,
  openCamWindow,
  closeCamWindow,
  attachAudio,
  refreshCamWindowFor,
  broadcastCamState,
} from "./cam-windows.mjs";
import { screenShare, areaBox } from "./screen-share.mjs";
import { refreshToolbar } from "./toolbar.mjs";
import { renderSettingsIfOpen } from "./dialogs.mjs";

export function onSocketMessage(msg) {
  switch (msg?.action) {
    case "session-started":
      promptJoin(msg.invite, false);
      break;
    case "session-closed":
      teardown("The GM closed the recording session.");
      break;
    case "hello":
      // A client joined and wants everyone's current mic/cam state.
      if (state.room) broadcastCamState();
      break;
    case "cam-state":
      camStates.set(msg.name, { micOn: msg.micOn, camOn: msg.camOn });
      refreshCamWindowFor(msg.name);
      break;
  }
}

// ---- GM actions --------------------------------------------------------------

export async function gmCreateSession() {
  const client = requireClient();
  if (!client) return;
  const name = `${game.world.title} — ${new Date().toLocaleDateString()}`;
  const { session } = await client.createSession(name);
  await game.settings.set(
    MOD,
    "activeSession",
    JSON.stringify({ sessionId: session.id, invite: session.invite_token }),
  );
  game.socket.emit(SOCKET, { action: "session-started", invite: session.invite_token });
  await joinRoom(session.invite_token);
  renderSettingsIfOpen();
  refreshToolbar();
}

export async function gmSetRecording(on) {
  const client = requireClient();
  const active = activeSession();
  if (!client || !active) return;
  try {
    if (on) await client.startRecording(active.sessionId);
    else await client.stopRecording(active.sessionId);
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

export async function promptJoin(invite, isRejoin) {
  if (state.room) return;
  const verb = isRejoin ? "Rejoin" : "Join";
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Session Recorder" },
    content: `<p>The GM ${isRejoin ? "has a recording session running" : "started a recording session"}.</p>
              <p>${verb} with your webcam? Your camera records <b>locally in full quality</b> and uploads in the background — the live call quality doesn't affect your recording.</p>`,
    rejectClose: false,
  });
  if (!ok) return;
  try {
    await joinRoom(invite);
  } catch (err) {
    console.error(`${MOD} | join failed`, err);
    ui.notifications.error(`Session Recorder: could not join — ${err.message}`);
  }
}

export async function joinRoom(invite) {
  if (state.room) return;
  const apiBase = setting("apiBase");
  state.camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });

  state.room = await sdk().Room.join({ apiBase, inviteToken: invite, displayName: game.user.name });

  openCamWindow("self", `${game.user.name} (you)`, state.camStream);

  state.room.on("roster", onRoster);
  state.room.on("stream", (pid, kind, trackName, stream) => {
    if (kind !== "cam") return; // webcams only — the map IS the Foundry canvas
    if (trackName.endsWith("-video")) {
      openCamWindow(pid, participantName(pid), stream);
      refreshCamWindowFor(participantName(pid));
    } else {
      attachAudio(pid, stream);
    }
  });
  state.room.on("streamLive", (pid, kind, trackName, live) => {
    if (kind === "cam" && trackName.endsWith("-video")) camWindows.get(pid)?.setStale(!live);
  });
  state.room.on("presence", (online) => {
    for (const [pid] of camWindows) {
      if (pid !== "self" && !online.has(pid)) closeCamWindow(pid);
    }
  });
  state.room.on("control", (action) => {
    if (action === "close")
      teardown("The GM ended the session. Uploads finish in the background — keep Foundry open until done.");
  });

  const live = await state.room.connectLiveCall();
  if (live) await state.room.publish(state.camStream, "cam");
  else ui.notifications.warn("Session Recorder: live preview unavailable; recording still works.");

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
    state.room.startRecording("cam", state.camStream).catch((err) => {
      state.recordingOn = false;
      ui.notifications.error(`Session Recorder: recording failed — ${err.message}`);
    });
    if (screenShare.stream) {
      state.room.startRecording("screen", screenShare.stream).catch(errNotify);
    }
    camWindows.get("self")?.setRecording(true);
    ui.notifications.info("Session Recorder: recording started.");
    refreshToolbar();
  }
  if (status !== "recording" && state.recordingOn && !state.draining) {
    state.recordPending = false;
    state.recordingOn = false;
    state.draining = true;
    state.room.stopRecording();
    camWindows.get("self")?.setRecording(false);
    ui.notifications.info("Session Recorder: recording stopped — uploading the remainder…");
    state.room.waitForUploads().then(() => {
      state.draining = false;
      ui.notifications.info("Session Recorder: all uploads complete. Your recording is safe.");
      renderSettingsIfOpen();
    });
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
  safely(() => state.room?.leave());
  state.room = null;
  state.recordingOn = false;
  safely(() => state.camStream?.getTracks().forEach((t) => t.stop()));
  state.camStream = null;
  safely(() => screenShare.stop());
  safely(() => areaBox.remove());
  for (const pid of [...camWindows.keys()]) safely(() => closeCamWindow(pid));
  if (message && wasActive) ui.notifications.info(`Session Recorder: ${message}`);
  safely(() => refreshToolbar());
}
