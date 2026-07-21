/**
 * GM-only actions: create/close the session, record toggle, enforce
 * participant controls.
 */
import { MOD, SOCKET, state, activeSession, requireClient, moduleProject } from "./state.mjs";
import { openGreenRoom } from "./green-room.mjs";
import { renderSettingsIfOpen } from "./dialogs.mjs";
import { refreshToolbar } from "./toolbar.mjs";
import { teardown } from "./session.mjs";

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
