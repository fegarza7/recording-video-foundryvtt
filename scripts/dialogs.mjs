/**
 * The two control-panel windows: Settings (sessions & connection) and
 * Videos (sessions & downloads browser).
 */
import { MOD, sdk, state, activeSession, requireClient, errNotify } from "./state.mjs";
import { gmCreateSession, gmCloseForEveryone, promptJoin } from "./session.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let settingsApp = null;
let videosApp = null;

// ---- settings window (sessions & connection) --------------------------------

function openSettings() {
  settingsApp ??= new SettingsWindow();
  settingsApp.render({ force: true });
}

/** Called by session.mjs instead of reaching into the singleton directly. */
function renderSettingsIfOpen() {
  if (settingsApp?.rendered) settingsApp.render();
}

class SettingsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "recvtt-settings",
    classes: ["recvtt-control"],
    window: {
      title: "Recorder — sessions & connection",
      resizable: false,
      minimizable: true,
    },
    position: { width: 320, height: "auto" },
  };
  static PARTS = {
    body: { template: `modules/${MOD}/templates/settings.hbs` },
  };
  async _prepareContext(_options) {
    const active = activeSession();
    const roster = state.room?.roster;
    const status = roster?.session.status ?? (active ? "connecting…" : "none");
    const progress = state.room?.recordingProgress() ?? { recorded: 0, uploaded: 0, tracks: 0 };
    const fmt = sdk().formatBytes;
    return {
      isGM: game.user.isGM,
      hasSession: !!active,
      joined: !!state.room,
      status,
      uploadLine: progress.tracks > 0 ? `${fmt(progress.uploaded)} / ${fmt(progress.recorded)} uploaded` : "",
      recordingError: state.room?.recordingError ?? "",
      participants: (roster?.participants ?? []).map((p) => {
        const bytes = (roster?.tracks ?? [])
          .filter((t) => t.participant_id === p.id)
          .reduce((n, t) => n + (t.bytes_uploaded ?? 0), 0);
        return { name: p.display_name, uploaded: fmt(bytes) };
      }),
    };
  }
  _onRender(_context, _options) {
    const el = this.element;
    el.querySelector("[data-recvtt=create]")?.addEventListener("click", () => gmCreateSession().catch(errNotify));
    el.querySelector("[data-recvtt=close]")?.addEventListener("click", () => gmCloseForEveryone().catch(errNotify));
    el.querySelector("[data-recvtt=join]")?.addEventListener("click", () => {
      const active = activeSession();
      if (active) promptJoin(active.invite, true);
    });
  }
}

// ---- videos window (all sessions, all downloads) -----------------------------

function openVideos() {
  videosApp ??= new VideosWindow();
  videosApp.load().catch(errNotify);
}

class VideosWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "recvtt-videos",
    classes: ["recvtt-control", "recvtt-videos"],
    window: {
      title: "Recorder — sessions & downloads",
      resizable: true,
      minimizable: true,
    },
    position: { width: 420, height: 480 },
  };
  static PARTS = {
    body: { template: `modules/${MOD}/templates/videos.hbs` },
  };

  sessions = [];
  expanded = null; // { id, participants, tracks }
  loading = false;

  async load() {
    const client = requireClient();
    if (!client) return;
    this.loading = true;
    this.render({ force: true });
    const { sessions } = await client.listSessions();
    this.sessions = sessions;
    this.loading = false;
    this.render({ force: true });
  }
  async expand(sessionId) {
    // Second click on the open session collapses it.
    if (this.expanded?.id === sessionId) {
      this.expanded = null;
      this.render({ force: true });
      return;
    }
    const client = requireClient();
    if (!client) return;
    const detail = await client.getSession(sessionId);
    const names = new Map(detail.participants.map((p) => [p.id, p.display_name]));
    this.expanded = {
      id: sessionId,
      tracks: detail.tracks.map((t) => ({
        id: t.id,
        label: `${names.get(t.participant_id) ?? "Player"} · ${t.kind}`,
        when: t.started_at ? new Date(t.started_at).toLocaleString() : "",
        complete: t.status === "complete",
        size: sdk().formatBytes(t.bytes_uploaded ?? 0),
      })),
    };
    this.render({ force: true });
  }
  async download(trackId) {
    const client = requireClient();
    if (!client) return;
    const { url } = await client.getDownloadUrl(trackId);
    const a = document.createElement("a");
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  async _prepareContext(_options) {
    const activeId = activeSession()?.sessionId;
    return {
      loading: this.loading,
      sessions: this.sessions.map((ses) => ({
        id: ses.id,
        name: ses.name,
        status: ses.status,
        isCurrent: ses.id === activeId,
        created: new Date(ses.created_at).toLocaleDateString(),
        expanded: this.expanded?.id === ses.id ? this.expanded : null,
      })),
    };
  }
  _onRender(_context, _options) {
    const el = this.element;
    el.querySelectorAll("[data-session]").forEach((row) =>
      row.addEventListener("click", () => this.expand(row.dataset.session).catch(errNotify)),
    );
    el.querySelectorAll("[data-track]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.download(btn.dataset.track).catch(errNotify);
      }),
    );
  }
}

export { openSettings, openVideos, renderSettingsIfOpen };
