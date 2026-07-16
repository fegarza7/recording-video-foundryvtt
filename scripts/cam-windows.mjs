/**
 * Cam windows: one floating ApplicationV2 tile per participant, the
 * cam/mic state that rides the Foundry socket, and the per-client cam
 * window layout persistence (position/size remembered per display name).
 */
import { MOD, SOCKET, MYSTERY_MAN, setting, state, participantName, errNotify } from "./state.mjs";
import { gmToggleParticipant } from "./session.mjs";

const camWindows = new Map(); // participantId -> CamWindow
/** Foundry-socket-shared mic/cam state, keyed by display name. */
const camStates = new Map(); // name -> { micOn, camOn }

// ---- cam-window layout persistence -----------------------------------------

function layoutKey(pid) {
  return pid === "self" ? game.user.name : participantName(pid);
}
function savedLayout(key) {
  return setting("camLayout")?.[key] ?? null;
}
function saveLayout(key, pos) {
  const all = { ...setting("camLayout") };
  all[key] = { left: pos.left, top: pos.top, width: pos.width, height: pos.height };
  game.settings.set(MOD, "camLayout", all);
}

// ---- cam state broadcast ----------------------------------------------------

function broadcastCamState() {
  const self = camWindows.get("self");
  game.socket.emit(SOCKET, {
    action: "cam-state",
    name: game.user.name,
    micOn: self?.micOn ?? true,
    camOn: self?.camOn ?? true,
  });
}

function refreshCamWindowFor(name) {
  for (const [pid, win] of camWindows) {
    if (pid !== "self" && participantName(pid) === name) {
      const st = camStates.get(name);
      win.setRemoteState(st?.micOn ?? true, st?.camOn ?? true);
    }
  }
}

// ---- portraits ---------------------------------------------------------------

function portraitFor(name) {
  const user = game.users.find((u) => u.name === name);
  return user?.character?.img || user?.avatar || MYSTERY_MAN;
}

// ---- audio -------------------------------------------------------------------

const audioEls = new Map();
function attachAudio(pid, stream) {
  let el = audioEls.get(pid);
  if (!el) {
    el = document.createElement("audio");
    el.autoplay = true;
    document.body.appendChild(el);
    audioEls.set(pid, el);
  }
  el.srcObject = stream;
  el.muted = camWindows.get(pid)?.localMuted ?? false;
}

function openCamWindow(pid, title, stream) {
  let win = camWindows.get(pid);
  if (!win) {
    win = new CamWindow(pid, title);
    camWindows.set(pid, win);
  }
  win.setStream(stream);
  win.render({ force: true });
}

function closeCamWindow(pid) {
  camWindows.get(pid)?.close();
  camWindows.delete(pid);
  audioEls.get(pid)?.remove();
  audioEls.delete(pid);
}

/** Reopen every known camera window (closing one is only visual —
 *  recording and streaming never depended on the windows). */
function showAllCams() {
  if (!state.room) {
    ui.notifications.warn("Session Recorder: join a session first (Sessions & connection).");
    return;
  }
  for (const win of camWindows.values()) win.render({ force: true });
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CamWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["recvtt-cam"],
    window: { title: "Camera", resizable: true, minimizable: true },
    position: { width: 320, height: 210 },
  };
  static PARTS = { body: { template: `modules/${MOD}/templates/cam.hbs` } };

  constructor(pid, title) {
    const saved = savedLayout(
      pid === "self" ? game.user.name : (state.room?.roster?.participants.find((p) => p.id === pid)?.display_name ?? pid),
    );
    super({
      id: `recvtt-cam-${pid}`,
      window: { title },
      position: saved ? { left: saved.left, top: saved.top, width: saved.width, height: saved.height } : {},
    });
    this.pid = pid;
    this.stream = null;
    this.recording = false;
    this.stale = false;
    this.micOn = true; // own choice (self) / their choice via module socket (remote)
    this.camOn = true;
    this.platformMicMuted = false; // GM-enforced, from the roster
    this.platformCamMuted = false;
    this.localMuted = false; // my-ears-only mute of a remote participant
    this._saveDebounce = null;
  }
  /** Persist position/size (debounced) whenever the window moves or resizes. */
  setPosition(position = {}) {
    const pos = super.setPosition(position);
    if (pos && pos.left != null && pos.width != null) {
      clearTimeout(this._saveDebounce);
      this._saveDebounce = setTimeout(() => saveLayout(layoutKey(this.pid), pos), 400);
    }
    return pos;
  }
  get isSelf() {
    return this.pid === "self";
  }
  setStream(stream) {
    this.stream = stream;
    this._wire();
  }
  setRecording(on) {
    this.recording = on;
    this.render();
  }
  setStale(stale) {
    this.stale = stale;
    this.render();
  }
  /** Remote peers' own mic/cam choice, learned over the Foundry socket. */
  setRemoteState(micOn, camOn) {
    this.micOn = micOn;
    this.camOn = camOn;
    this.render();
  }
  /** GM-enforced flags from the roster. On self, also enforce on tracks. */
  setPlatformState(micMuted, camMuted) {
    if (this.platformMicMuted === micMuted && this.platformCamMuted === camMuted) return;
    this.platformMicMuted = micMuted;
    this.platformCamMuted = camMuted;
    if (this.isSelf) this._applyTracks();
    this.render();
  }
  async _prepareContext(_options) {
    const name = this.isSelf ? game.user.name : participantName(this.pid);
    const camOff = !this.camOn || this.platformCamMuted;
    return {
      recording: this.recording,
      stale: this.stale && !camOff,
      isSelf: this.isSelf,
      isGM: game.user.isGM && !this.isSelf,
      micOn: this.micOn && !this.platformMicMuted,
      camOn: !camOff,
      gmMicMuted: this.platformMicMuted,
      gmCamMuted: this.platformCamMuted,
      localMuted: this.localMuted,
      portrait: portraitFor(name),
    };
  }
  _onRender(_context, _options) {
    const el = this.element;
    el.querySelector("[data-a=mic]")?.addEventListener("click", () => this._toggleMic());
    el.querySelector("[data-a=cam]")?.addEventListener("click", () => this._toggleCam());
    el.querySelector("[data-a=localmute]")?.addEventListener("click", () => this._toggleLocalMute());
    el.querySelector("[data-a=gmmic]")?.addEventListener("click", () => gmToggleParticipant(this.pid, "mic").catch(errNotify));
    el.querySelector("[data-a=gmcam]")?.addEventListener("click", () => gmToggleParticipant(this.pid, "cam").catch(errNotify));
    this._wire();
  }
  /** One formula for our real tracks: local choice AND not GM-muted. */
  _applyTracks() {
    if (!this.isSelf || !state.camStream) return;
    state.camStream.getAudioTracks().forEach((t) => (t.enabled = this.micOn && !this.platformMicMuted));
    state.camStream.getVideoTracks().forEach((t) => (t.enabled = this.camOn && !this.platformCamMuted));
  }
  _toggleMic() {
    if (!this.isSelf || !state.camStream) return;
    if (this.platformMicMuted) {
      ui.notifications.warn("Session Recorder: the GM muted you — they control this.");
      return;
    }
    this.micOn = !this.micOn;
    this._applyTracks();
    broadcastCamState();
    this.render();
  }
  _toggleCam() {
    if (!this.isSelf || !state.camStream) return;
    if (this.platformCamMuted) {
      ui.notifications.warn("Session Recorder: the GM disabled your camera — they control this.");
      return;
    }
    this.camOn = !this.camOn;
    this._applyTracks();
    broadcastCamState();
    this.render();
  }
  /** My-ears-only: mutes this participant's audio element locally. */
  _toggleLocalMute() {
    this.localMuted = !this.localMuted;
    const audio = audioEls.get(this.pid);
    if (audio) audio.muted = this.localMuted;
    this.render();
  }
  _wire() {
    const el = this.element;
    const video = el?.querySelector?.("video");
    if (video && this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      video.muted = this.isSelf; // never play your own mic back at you
    }
  }
}

export {
  camWindows,
  camStates,
  openCamWindow,
  closeCamWindow,
  showAllCams,
  attachAudio,
  refreshCamWindowFor,
  broadcastCamState,
  portraitFor,
};
