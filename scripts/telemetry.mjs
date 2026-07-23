/**
 * Camera telemetry: what the machine actually delivers vs what we asked
 * for. Answers "is this player's camera/machine struggling?" with data in
 * the session Diagnostics instead of guesswork. Collection only — no
 * behavior changes.
 */
import { state } from "./state.mjs";

const SAMPLE_MS = 60_000; // one routine sample per minute
const LOW_FPS = 24; // below this, log immediately as a warning
const LOW_GAP_MS = 30_000; // but never spam: min gap between low warnings

const cam = {
  video: null, // hidden <video> consuming the cam stream (frame counter)
  frames: 0,
  windowStart: 0,
  lastLowLog: 0,
  timer: null,
  rvfcId: null,
};

/** One-time context: requested vs granted settings + machine class. */
function logCamSettings() {
  const track = state.camStream?.getVideoTracks()[0];
  if (!track || !state.room) return;
  const s = track.getSettings();
  const cores = navigator.hardwareConcurrency ?? "?";
  const mem = navigator.deviceMemory ? `${navigator.deviceMemory}GB` : "?";
  state.room.log(
    "info",
    "cam-settings",
    `requested 1280x720@30; got ${s.width}x${s.height}@${Math.round(s.frameRate ?? 0)} | ${track.label || "unknown camera"} | ${cores} cores, ${mem} RAM`,
  );
}

/** Count presented frames via requestVideoFrameCallback on a hidden
 *  element; each callback is one delivered frame. */
function armFrameCounter() {
  const video = cam.video;
  if (!video || typeof video.requestVideoFrameCallback !== "function") return;
  const onFrame = () => {
    cam.frames += 1;
    // Self-heal after device switch / re-acquire: follow the live stream.
    if (video.srcObject !== state.camStream && state.camStream) {
      video.srcObject = state.camStream;
      video.play().catch(() => {});
    }
    cam.rvfcId = video.requestVideoFrameCallback(onFrame);
  };
  cam.rvfcId = video.requestVideoFrameCallback(onFrame);
}

function sample(routine) {
  if (!state.room) return;
  const elapsed = (performance.now() - cam.windowStart) / 1000;
  if (elapsed < 5) return; // window too small to mean anything
  const fps = cam.frames / elapsed;
  cam.frames = 0;
  cam.windowStart = performance.now();

  const low = fps < LOW_FPS;
  if (!routine && !low) return; // off-cycle checks only report trouble
  if (low && !routine) {
    const now = performance.now();
    if (now - cam.lastLowLog < LOW_GAP_MS) return;
    cam.lastLowLog = now;
  }
  state.room.log(low ? "warn" : "info", "cam-fps", `${fps.toFixed(1)}fps delivered (30 requested)${state.capturing ? " while recording" : ""}`);
}

/** Start after joining a room (needs state.camStream + state.room). */
export function startCamTelemetry() {
  stopCamTelemetry();
  if (!state.camStream || !state.room) return;
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.display = "none";
    video.srcObject = state.camStream;
    document.body.appendChild(video);
    video.play().catch(() => {});
    cam.video = video;
    cam.frames = 0;
    cam.windowStart = performance.now();
    armFrameCounter();
    logCamSettings();
    // Routine sample each minute; a quick low-fps check every 15s between.
    let tick = 0;
    cam.timer = setInterval(() => {
      tick += 1;
      sample(tick % 4 === 0);
    }, SAMPLE_MS / 4);
  } catch {
    /* telemetry must never break a session */
  }
}

export function stopCamTelemetry() {
  clearInterval(cam.timer);
  cam.timer = null;
  if (cam.video && cam.rvfcId && typeof cam.video.cancelVideoFrameCallback === "function") {
    cam.video.cancelVideoFrameCallback(cam.rvfcId);
  }
  cam.rvfcId = null;
  cam.video?.remove();
  cam.video = null;
}
