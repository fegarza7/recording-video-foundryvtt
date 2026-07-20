/**
 * The green room: every join — player or GM — goes through this window.
 * Live camera preview, device selection, join-muted toggles, and explicit
 * consent before any media is shared with the session. Browser permission
 * is NOT consent; this screen is.
 */
import { MOD, PORTAL_URL, setting, errNotify } from "./state.mjs";
import { joinRoom } from "./session.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let app = null;

/** Open (or re-focus) the green room for an invite. */
export function openGreenRoom(invite, isRejoin) {
  if (app?.rendered) {
    app.bringToFront?.();
    return;
  }
  app = new GreenRoom(invite, isRejoin);
  app.start().catch(errNotify);
}

class GreenRoom extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "recvtt-green-room",
    classes: ["recvtt-control", "recvtt-green-room"],
    window: { title: "Join recording session", resizable: false, minimizable: false },
    position: { width: 420, height: "auto" },
  };
  static PARTS = {
    body: { template: `modules/${MOD}/templates/green-room.hbs` },
  };

  constructor(invite, isRejoin) {
    super({ window: { title: isRejoin ? "Rejoin recording session" : "Join recording session" } });
    this.invite = invite;
    this.preview = null; // MediaStream while the window is open
    this.cams = [];
    this.mics = [];
    this.camId = setting("camDevice") || "";
    this.micId = setting("micDevice") || "";
    this.camOff = false;
    this.micMuted = false;
    this.consent = false;
    this.joining = false;
    this.error = "";
    // Guards against the camera-light leak: a getUserMedia that resolves
    // AFTER close (or after a newer device pick) must be stopped, not kept.
    this._closed = false;
    this._gen = 0;
  }

  async start() {
    await this._acquirePreview();
    await this.render({ force: true });
  }

  /** (Re)acquire the preview stream for the currently selected devices.
   *  Also the moment device labels become readable (permission granted). */
  async _acquirePreview() {
    const gen = ++this._gen;
    this._stopPreview();
    this.error = "";
    const video = this.camId ? { deviceId: { exact: this.camId } } : true;
    const audio = this.micId ? { deviceId: { exact: this.micId } } : true;
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch {
      // A remembered device may be unplugged — retry with defaults once.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.camId = "";
        this.micId = "";
      } catch (err) {
        this.error = `Could not access your camera/microphone: ${err.message}`;
        return;
      }
    }
    // Arrived late? The window closed (or a newer device was picked) while
    // we waited — releasing the tracks here is what turns the light off.
    if (this._closed || gen !== this._gen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.preview = stream;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;
    this.cams = devices.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: label(d, i, "Camera") }));
    this.mics = devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: label(d, i, "Microphone") }));
    // Reflect what we actually got (default device resolution).
    this.camId ||= this.preview.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    this.micId ||= this.preview.getAudioTracks()[0]?.getSettings().deviceId ?? "";
  }

  _stopPreview() {
    this.preview?.getTracks().forEach((t) => t.stop());
    this.preview = null;
  }

  async _prepareContext(_options) {
    return {
      cams: this.cams.map((c) => ({ ...c, selected: c.id === this.camId })),
      mics: this.mics.map((m) => ({ ...m, selected: m.id === this.micId })),
      camOff: this.camOff,
      micMuted: this.micMuted,
      consent: this.consent,
      canJoin: this.consent && !this.joining && !this.error,
      error: this.error,
      securityUrl: `${PORTAL_URL}/security`,
    };
  }

  _onRender(_context, _options) {
    const el = this.element;
    const video = el.querySelector("video");
    if (video && this.preview) video.srcObject = this.preview;

    el.querySelector("[data-recvtt=cam]")?.addEventListener("change", (e) => {
      this.camId = e.target.value;
      this._acquirePreview().then(() => this.render()).catch(errNotify);
    });
    el.querySelector("[data-recvtt=mic]")?.addEventListener("change", (e) => {
      this.micId = e.target.value;
      this._acquirePreview().then(() => this.render()).catch(errNotify);
    });
    el.querySelector("[data-recvtt=camoff]")?.addEventListener("change", (e) => {
      this.camOff = e.target.checked;
      this.render();
    });
    el.querySelector("[data-recvtt=micmuted]")?.addEventListener("change", (e) => {
      this.micMuted = e.target.checked;
    });
    el.querySelector("[data-recvtt=consent]")?.addEventListener("change", (e) => {
      this.consent = e.target.checked;
      const join = this.element.querySelector("[data-recvtt=join]");
      if (join) join.disabled = !(this.consent && !this.joining && !this.error);
    });
    el.querySelector("[data-recvtt=cancel]")?.addEventListener("click", () => this.close());
    el.querySelector("[data-recvtt=join]")?.addEventListener("click", () => this._join().catch(errNotify));
  }

  async _join() {
    if (this.joining || !this.consent) return;
    this.joining = true;
    await game.settings.set(MOD, "camDevice", this.camId);
    await game.settings.set(MOD, "micDevice", this.micId);
    const opts = { camId: this.camId, micId: this.micId, camOff: this.camOff, micMuted: this.micMuted };
    // joinRoom acquires its own stream; free the devices first (some
    // cameras refuse to be opened twice).
    this._stopPreview();
    await this.close();
    try {
      await joinRoom(this.invite, opts);
    } catch (err) {
      ui.notifications.error(`Session Recorder: could not join — ${err.message}`);
    }
  }

  /** X button, Cancel, or Join — every path funnels through close():
   *  release the devices here, unconditionally. */
  async close(options) {
    this._closed = true;
    this._gen++;
    this._stopPreview();
    app = null;
    return super.close(options);
  }
}
