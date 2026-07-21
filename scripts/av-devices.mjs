/**
 * Camera/mic devices: constraints, death-watch + re-acquire, mid-session
 * switching.
 */
import { MOD, state, errNotify } from "./state.mjs";
import { camWindows } from "./cam-windows.mjs";

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

export { camConstraints, watchCamTracks };
