/**
 * Shared module state and tiny helpers — the only file with mutable
 * cross-cutting state; everything else imports from here.
 */
export const MOD = "recorder-vtt";
export const SOCKET = `module.${MOD}`;
export const MYSTERY_MAN = "icons/svg/mystery-man.svg";

export const sdk = () => window.RecorderSDK;
export const setting = (key) => game.settings.get(MOD, key);

export const state = {
  /** @type {import("@recorder/sdk").Room | null} */
  room: null,
  recorderClient: null, // GM only
  camStream: null,
  recordingOn: false,
  draining: false,
  /** Set while a start/stop request is in flight; cleared by the next roster status change. */
  recordPending: false,
};

export const activeSession = () => {
  try {
    const raw = setting("activeSession");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function participantName(pid) {
  return state.room?.roster?.participants.find((p) => p.id === pid)?.display_name ?? "Player";
}

export function requireClient() {
  const token = setting("apiToken");
  if (!token) {
    ui.notifications.warn("Set your personal API token in the module settings first.");
    return null;
  }
  state.recorderClient ??= new (sdk().RecorderClient)({ apiBase: setting("apiBase"), token });
  return state.recorderClient;
}

export const errNotify = (err) => {
  console.error(`${MOD} |`, err);
  ui.notifications.error(`Session Recorder: ${err.message}`);
};
