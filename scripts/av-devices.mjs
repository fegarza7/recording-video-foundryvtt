/**
 * Camera/mic devices: constraints, death-watch + re-acquire, mid-session
 * switching.
 */
import { MOD, state, errNotify } from "./state.mjs";
import { camWindows } from "./cam-windows.mjs";

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };

/** The profile ladder, best first. The session's quality policy (the
 *  host's plan, from the join response) caps which rungs are allowed;
 *  runtime throttling steps DOWN the allowed rungs, never up. An
 *  achievable profile delivered smoothly beats an ambitious one missed. */
const LADDER = [
  { width: 1920, height: 1080, fps: 30, label: "Full HD (1080p) @ 30" },
  { width: 1280, height: 720, fps: 30, label: "HD (720p) @ 30" },
  { width: 854, height: 480, fps: 30, label: "480p @ 30" },
  { width: 854, height: 480, fps: 15, label: "480p @ 15" },
];

function allowedLadder() {
  const p = state.qualityPolicy;
  // No policy (old server / not joined yet): today's default, 720p down.
  if (!p) return LADDER.slice(1);
  const allowed = LADDER.filter((r) => r.width <= p.max_width && r.height <= p.max_height && r.fps <= p.max_fps);
  return allowed.length ? allowed : LADDER.slice(1);
}

/** The rung we're currently targeting (ceiling minus throttle steps). */
export function currentProfile() {
  const ladder = allowedLadder();
  return ladder[Math.min(state.profileStep, ladder.length - 1)];
}

/** Base constraints + the devices chosen in the green room (if any). */
function camConstraints() {
  const prefs = state.avPrefs ?? {};
  const profile = currentProfile();
  return {
    video: {
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.fps },
      ...(prefs.camId ? { deviceId: { exact: prefs.camId } } : {}),
    },
    audio: { ...AUDIO_CONSTRAINTS, ...(prefs.micId ? { deviceId: { exact: prefs.micId } } : {}) },
  };
}

let lastStepDownAt = 0;

/**
 * Runtime throttle: drop one rung when telemetry says the machine can't
 * sustain the current profile. Applies at a SEGMENT boundary (cams are
 * avc1 — mid-file resolution changes corrupt them): the fresh stream
 * replaces the live one and, if capturing, recording continues as a new
 * file — the exact device-switch path users already know.
 */
export async function stepDownProfile(reason) {
  const ladder = allowedLadder();
  if (state.profileStep >= ladder.length - 1) return false; // at the floor
  if (Date.now() - lastStepDownAt < 60_000) return false; // one step per minute
  if (!state.room || !state.camStream) return false;
  lastStepDownAt = Date.now();

  state.profileStep += 1;
  const profile = currentProfile();
  state.room.log("warn", "profile-stepdown", `${profile.label} (${reason})`);
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(camConstraints());
  } catch (err) {
    state.profileStep -= 1; // couldn't apply — stay where we were
    state.room.log("error", "profile-stepdown-failed", err.message);
    return false;
  }
  await adoptFreshStream(fresh);
  ui.notifications.info(`Session Recorder: video quality reduced to ${profile.label} to keep things smooth.`);
  return true;
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

export { camConstraints, watchCamTracks };
