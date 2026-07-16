/**
 * Screen sharing (one live 'screen' stream: area OR tab/window) and the
 * area rectangle (visual only; streaming lives in screenShare).
 */
import { state, errNotify } from "./state.mjs";
import { refreshToolbar } from "./toolbar.mjs";

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

  /** Straight to the browser picker: tab, window, or entire screen.
   *  selfBrowserSurface puts THIS tab back in the Chrome Tab list —
   *  Chrome hides the calling tab from itself by default. */
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
    if (state.recordingOn) await state.room.startRecording("screen", this.stream);
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

const areaBox = {
  el: null,

  toggle() {
    if (this.el) {
      screenShare.stop("area");
      this.remove();
    } else {
      this.create();
    }
  },

  create() {
    const el = document.createElement("div");
    el.id = "recvtt-area";
    el.innerHTML = `
      <div class="recvtt-area-toolbar">
        <span class="recvtt-area-grip" title="Drag to move"><i class="fas fa-arrows-alt"></i></span>
        <button type="button" data-a="stream" title="Stream this area"><i class="fas fa-play"></i> Stream</button>
        <button type="button" data-a="stop" title="Stop streaming" style="display:none"><i class="fas fa-stop"></i> Stop</button>
        <button type="button" data-a="close" title="Remove"><i class="fas fa-times"></i></button>
      </div>
      <div class="recvtt-area-frame"></div>
      <div class="recvtt-area-handle" title="Drag to resize"></div>`;
    document.body.appendChild(el);
    const w = 640;
    el.style.width = `${w}px`;
    el.style.height = `${Math.round((w * 9) / 16) + 28}px`;
    el.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
    el.style.top = `${Math.round(window.innerHeight * 0.15)}px`;

    el.querySelector("[data-a=stream]").addEventListener("click", () => screenShare.startArea().catch(errNotify));
    el.querySelector("[data-a=stop]").addEventListener("click", () => screenShare.stop("area"));
    el.querySelector("[data-a=close]").addEventListener("click", () => {
      screenShare.stop("area");
      this.remove();
    });
    this._drag(el.querySelector(".recvtt-area-grip"), el);
    this._resize(el.querySelector(".recvtt-area-handle"), el);
    this.el = el;
  },

  remove() {
    this.el?.remove();
    this.el = null;
  },

  setStreamingUi(on) {
    if (!this.el) return;
    this.el.classList.toggle("recvtt-streaming", on);
    this.el.querySelector("[data-a=stream]").style.display = on ? "none" : "";
    this.el.querySelector("[data-a=stop]").style.display = on ? "" : "none";
  },

  _drag(grip, el) {
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX - el.offsetLeft;
      const startY = e.clientY - el.offsetTop;
      const move = (ev) => {
        el.style.left = `${ev.clientX - startX}px`;
        el.style.top = `${ev.clientY - startY}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },

  _resize(handle, el) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startW = el.offsetWidth;
      const startX = e.clientX;
      const move = (ev) => {
        const w = Math.max(320, startW + (ev.clientX - startX));
        el.style.width = `${w}px`;
        el.style.height = `${Math.round((w * 9) / 16) + 28}px`; // keep 16:9 (+toolbar)
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },

};

export { screenShare, areaBox };
