/**
 * The capture gate: nothing records on a player's machine without their
 * explicit choice.
 */
import { state, errNotify } from "./state.mjs";
import { camWindows, broadcastCamState } from "./cam-windows.mjs";
import { screenShare } from "./screen-share.mjs";
import { teardown } from "./session.mjs";

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

export { startLocalCapture, showRecordRequest, showRecordingNotice };
