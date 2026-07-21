/**
 * Screen sharing (one live 'screen' stream: area OR tab/window) and the
 * area rectangle (visual only; streaming lives in screenShare).
 */
import { state } from "./state.mjs";
import { refreshToolbar } from "./toolbar.mjs";
import { areaBox } from "./area-box.mjs";

const screenShare = {
  mode: null, // 'area' | 'window'
  stream: null,
  _cropLoop: null,

  /** Capture this tab cropped to the area frame. Region Capture API when
   *  available; canvas-crop fallback otherwise. */
  async startArea() {
    if (!state.room) {
      ui.notifications.warn("Session Recorder: join the session first (Sessions & connection).");
      return;
    }
    this.stop();
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 24, max: 30 } },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      });
    } catch (err) {
      if (err?.name === "NotAllowedError") return; // user cancelled the picker
      throw err;
    }
    const frame = areaBox.el?.querySelector(".recvtt-area-frame");
    if (!frame) {
      display.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = display.getVideoTracks()[0];
    if (window.CropTarget && track.cropTo) {
      await track.cropTo(await CropTarget.fromElement(frame));
      this.stream = display;
    } else {
      this.stream = this._canvasCrop(display, frame);
    }
    this.mode = "area";
    track.addEventListener("ended", () => this.stop());
    await this._publish("streaming the boxed area");
  },

  /** Straight to the browser picker (tab/window/screen). selfBrowserSurface
   *  re-includes this tab — Chrome hides the caller's own tab by default. */
  async startWindow() {
    if (!state.room) {
      ui.notifications.warn("Session Recorder: join the session first (Sessions & connection).");
      refreshToolbar();
      return;
    }
    this.stop();
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 15, max: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: "include",
      });
    } catch (err) {
      refreshToolbar(); // reset the toolbar toggle
      if (err?.name === "NotAllowedError") return; // user cancelled the picker
      throw err;
    }
    this.stream = display;
    this.mode = "window";
    display.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());
    await this._publish("streaming the selected tab/window");
  },

  _canvasCrop(display, frame) {
    const video = document.createElement("video");
    video.srcObject = display;
    video.muted = true;
    video.play();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const draw = () => {
      if (!video.videoWidth) return;
      const scaleX = video.videoWidth / window.innerWidth;
      const scaleY = video.videoHeight / window.innerHeight;
      const r = frame.getBoundingClientRect();
      canvas.width = Math.round(r.width * scaleX);
      canvas.height = Math.round(r.height * scaleY);
      ctx.drawImage(video, r.left * scaleX, r.top * scaleY, r.width * scaleX, r.height * scaleY, 0, 0, canvas.width, canvas.height);
    };
    this._cropLoop = setInterval(draw, 1000 / 24);
    const out = canvas.captureStream(24);
    // Keep the raw display capture alive behind the canvas.
    out._recvttSource = display;
    return out;
  },

  async _publish(what) {
    await state.room.publish(this.stream, "screen");
    // Gate on capturing, not session status: a player who hasn't pressed
    // "Start my recording" yet must not have their screen captured either.
    if (state.capturing) await state.room.startRecording("screen", this.stream);
    areaBox.setStreamingUi(this.mode === "area");
    refreshToolbar();
    ui.notifications.info(`Session Recorder: ${what}.`);
  },

  /** Stop sharing. Pass a mode to stop only if that mode is the live one. */
  stop(onlyMode) {
    if (onlyMode && this.mode !== onlyMode) return;
    if (this._cropLoop) clearInterval(this._cropLoop);
    this._cropLoop = null;
    if (this.stream) {
      state.room?.unpublish("screen").catch(() => {});
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream._recvttSource?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.mode = null;
    }
    areaBox.setStreamingUi(false);
    refreshToolbar();
  },
};

export { screenShare, areaBox };
