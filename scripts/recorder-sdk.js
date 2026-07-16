"use strict";
var RecorderSDK = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key2 of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key2) && key2 !== except)
          __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    Api: () => Api,
    ApiError: () => ApiError,
    RecorderClient: () => RecorderClient,
    RecordingController: () => RecordingController,
    Room: () => Room,
    RtcClient: () => RtcClient,
    addPending: () => addPending,
    clearJoin: () => clearJoin,
    connectRoomSocket: () => connectRoomSocket,
    formatBytes: () => formatBytes,
    readJoin: () => readJoin,
    readPending: () => readPending,
    removePending: () => removePending,
    resumePendingUploads: () => resumePendingUploads,
    saveJoin: () => saveJoin,
    withTrackLock: () => withTrackLock
  });

  // src/api.ts
  var ApiError = class extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  };
  var Api = class {
    constructor(base = "", fetchFn = (...args) => fetch(...args), defaultBearer, useCookies = false) {
      this.base = base;
      this.fetchFn = fetchFn;
      this.defaultBearer = defaultBearer;
      this.useCookies = useCookies;
    }
    async req(method, path, opts = {}) {
      const headers = {};
      if (opts.json !== void 0) headers["content-type"] = "application/json";
      const bearer = opts.bearer ?? this.defaultBearer;
      if (bearer) headers["authorization"] = `Bearer ${bearer}`;
      const res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        credentials: !bearer && this.useCookies ? "include" : "omit",
        body: opts.json !== void 0 ? JSON.stringify(opts.json) : void 0
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, typeof body.error === "string" ? body.error : `request failed (${res.status})`);
      return body;
    }
    // auth
    signup(email, password) {
      return this.req("POST", "/v1/auth/signup", { json: { email, password } });
    }
    login(email, password) {
      return this.req("POST", "/v1/auth/login", { json: { email, password } });
    }
    logout() {
      return this.req("POST", "/v1/auth/logout");
    }
    me() {
      return this.req("GET", "/v1/auth/me");
    }
    // sessions (owner)
    listSessions() {
      return this.req("GET", "/v1/sessions");
    }
    createSession(name) {
      return this.req("POST", "/v1/sessions", { json: { name } });
    }
    getSession(id) {
      return this.req("GET", `/v1/sessions/${id}`);
    }
    deleteSession(id, confirmName) {
      return this.req("DELETE", `/v1/sessions/${id}`, { json: { confirmName } });
    }
    startSession(id) {
      return this.req("POST", `/v1/sessions/${id}/start`);
    }
    endSession(id) {
      return this.req("POST", `/v1/sessions/${id}/end`);
    }
    /** Stop recording AND disconnect everyone from the live call. */
    closeSession(id) {
      return this.req("POST", `/v1/sessions/${id}/close`);
    }
    rotateInvite(id) {
      return this.req("POST", `/v1/sessions/${id}/rotate-invite`);
    }
    setParticipantControls(sessionId, participantId, controls) {
      return this.req("POST", `/v1/sessions/${sessionId}/participants/${participantId}/controls`, { json: controls });
    }
    // join flow (public)
    joinInfo(inviteToken) {
      return this.req("GET", `/v1/join/${inviteToken}`);
    }
    join(inviteToken, displayName) {
      return this.req(
        "POST",
        `/v1/join/${inviteToken}`,
        { json: { displayName } }
      );
    }
    // room + tracks (join token)
    roster(sessionId, joinToken) {
      return this.req("GET", `/v1/rooms/${sessionId}/roster`, { bearer: joinToken });
    }
    createTrack(joinToken, kind, mimeType) {
      return this.req("POST", "/v1/tracks", { bearer: joinToken, json: { kind, mimeType } });
    }
    setRtc(sessionId, joinToken, rtcSessionId, published) {
      return this.req("POST", `/v1/rooms/${sessionId}/rtc`, {
        bearer: joinToken,
        json: { rtcSessionId, published }
      });
    }
    // downloads (owner)
    downloadUrl(trackId) {
      return this.req("POST", `/v1/tracks/${trackId}/download-url`);
    }
    // personal API tokens
    createApiToken(label) {
      return this.req("POST", "/v1/auth/tokens", { json: { label } });
    }
    listApiTokens() {
      return this.req("GET", "/v1/auth/tokens");
    }
    revokeApiToken(id) {
      return this.req("DELETE", `/v1/auth/tokens/${id}`);
    }
  };

  // src/rtc.ts
  var PUBLISH_LIMITS = [
    { match: (n) => n.startsWith("cam") && n.endsWith("-video"), maxBitrate: 7e5, scaleResolutionDownBy: 2, maxFramerate: 24 },
    { match: (n) => n.startsWith("screen") && n.endsWith("-video"), maxBitrate: 12e5, maxFramerate: 15 }
  ];
  var RtcClient = class {
    constructor(joinToken, apiBase = "") {
      this.joinToken = joinToken;
      this.apiBase = apiBase;
    }
    pc = null;
    sessionId = null;
    pendingMids = /* @__PURE__ */ new Map();
    publishedMids = /* @__PURE__ */ new Map();
    pulledKeys = /* @__PURE__ */ new Set();
    queue = Promise.resolve();
    onRemoteTrack = null;
    /** Fires within ~1-2s when a remote track's packets stop (publisher died,
     *  tab froze, network drop) and again when they resume. */
    onRemoteTrackLive = null;
    async sfu(path, body, method = "POST") {
      const headers = { authorization: `Bearer ${this.joinToken}` };
      if (body !== void 0) headers["content-type"] = "application/json";
      const res = await fetch(`${this.apiBase}/v1/realtime${path}`, {
        method,
        headers,
        body: body !== void 0 ? JSON.stringify(body) : void 0
      });
      if (res.status === 503) throw new Error("sfu-not-configured");
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok || parsed.errorCode) {
        throw new Error(`SFU ${path}: ${parsed.errorDescription ?? res.status}`);
      }
      return parsed;
    }
    /** Serialize SDP negotiations — concurrent renegotiations corrupt state. */
    locked(fn) {
      const next = this.queue.then(fn, fn);
      this.queue = next.catch(() => {
      });
      return next;
    }
    /** Returns false when the SFU isn't configured (placeholder mode). */
    async connect() {
      try {
        const res = await this.sfu("/sessions/new");
        if (!res.sessionId) return false;
        this.sessionId = res.sessionId;
      } catch (err) {
        if (err instanceof Error && err.message === "sfu-not-configured") return false;
        throw err;
      }
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        bundlePolicy: "max-bundle"
      });
      this.pc.ontrack = (e) => {
        const mid = e.transceiver.mid;
        const meta = mid ? this.pendingMids.get(mid) : void 0;
        if (!meta) return;
        e.track.onmute = () => this.onRemoteTrackLive?.(meta.participantKey, meta.trackName, false);
        e.track.onunmute = () => this.onRemoteTrackLive?.(meta.participantKey, meta.trackName, true);
        e.track.onended = () => this.onRemoteTrackLive?.(meta.participantKey, meta.trackName, false);
        this.onRemoteTrack?.({
          participantKey: meta.participantKey,
          trackName: meta.trackName,
          stream: new MediaStream([e.track]),
          kind: e.track.kind
        });
      };
      return true;
    }
    /** Publish tracks under `${prefix}-${kind}` names. Returns published names. */
    publish(stream, prefix) {
      return this.locked(async () => {
        const pc = this.pc;
        if (!pc || !this.sessionId) throw new Error("not connected");
        const transceivers = stream.getTracks().map((track) => ({
          track,
          tx: pc.addTransceiver(track, { direction: "sendonly" })
        }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const tracks = transceivers.map(({ track, tx }) => ({
          location: "local",
          mid: tx.mid,
          trackName: `${prefix}-${track.kind}`
        }));
        const res = await this.sfu(`/sessions/${this.sessionId}/tracks/new`, {
          sessionDescription: { sdp: pc.localDescription.sdp, type: "offer" },
          tracks
        });
        if (res.sessionDescription) {
          await pc.setRemoteDescription(res.sessionDescription);
        }
        for (const { track, tx } of transceivers) {
          if (tx.mid) this.publishedMids.set(`${prefix}-${track.kind}`, tx.mid);
        }
        for (const { track, tx } of transceivers) {
          const limits = PUBLISH_LIMITS.find((l) => l.match(`${prefix}-${track.kind}`));
          if (!limits) continue;
          const params = tx.sender.getParameters();
          params.encodings = [
            {
              ...params.encodings?.[0] ?? {},
              maxBitrate: limits.maxBitrate,
              scaleResolutionDownBy: limits.scaleResolutionDownBy,
              maxFramerate: limits.maxFramerate
            }
          ];
          tx.sender.setParameters(params).catch(() => {
          });
        }
        return tracks.map((t) => t.trackName);
      });
    }
    /** Pull one remote track; delivery arrives via onRemoteTrack. */
    pull(remoteSessionId, trackName, participantKey) {
      const key2 = `${remoteSessionId}:${trackName}`;
      if (this.pulledKeys.has(key2)) return Promise.resolve();
      this.pulledKeys.add(key2);
      return this.locked(async () => {
        const pc = this.pc;
        if (!pc || !this.sessionId) throw new Error("not connected");
        const res = await this.sfu(`/sessions/${this.sessionId}/tracks/new`, {
          tracks: [{ location: "remote", sessionId: remoteSessionId, trackName }]
        });
        const mid = res.tracks?.[0]?.mid;
        if (mid) this.pendingMids.set(mid, { participantKey, trackName });
        if (res.requiresImmediateRenegotiation && res.sessionDescription) {
          await pc.setRemoteDescription(res.sessionDescription);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.sfu(
            `/sessions/${this.sessionId}/renegotiate`,
            { sessionDescription: { sdp: answer.sdp, type: "answer" } },
            "PUT"
          );
        }
      }).catch((err) => {
        this.pulledKeys.delete(key2);
        console.error(`pull ${trackName} failed`, err);
      });
    }
    /** Stop publishing named tracks (stop-share / switch-share). */
    closeByName(trackNames) {
      return this.locked(async () => {
        if (!this.sessionId) return;
        const mids = trackNames.map((n) => this.publishedMids.get(n)).filter((m) => !!m);
        if (mids.length === 0) return;
        await this.sfu(
          `/sessions/${this.sessionId}/tracks/close`,
          { tracks: mids.map((mid) => ({ mid })), force: true },
          "PUT"
        );
        for (const n of trackNames) this.publishedMids.delete(n);
      }).catch((err) => console.error("closeByName failed", err));
    }
    close() {
      this.pc?.close();
      this.pc = null;
      this.sessionId = null;
    }
  };

  // src/roomSocket.ts
  function connectRoomSocket(sessionId, joinToken, onMessage, apiBase = "") {
    let ws = null;
    let closed = false;
    let attempts = 0;
    let heartbeat = null;
    const base = apiBase || location.origin;
    const url = `${base.replace(/^http/, "ws")}/v1/rooms/${sessionId}/ws?token=${encodeURIComponent(joinToken)}`;
    function open() {
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempts = 0;
        heartbeat = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
        }, 4e3);
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        try {
          onMessage(JSON.parse(e.data));
        } catch {
        }
      };
      ws.onclose = () => {
        ws = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (closed) return;
        attempts += 1;
        setTimeout(open, Math.min(1e3 * 2 ** attempts, 15e3));
      };
      ws.onerror = () => ws?.close();
    }
    open();
    return {
      close() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        const socket = ws;
        if (!socket) return;
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => socket.close();
        } else {
          socket.close();
        }
      },
      isConnected: () => ws?.readyState === WebSocket.OPEN
    };
  }

  // src/joinStore.ts
  var key = (sessionId) => `vr.join.${sessionId}`;
  function storageOrNull(storage) {
    if (storage) return storage;
    return typeof localStorage === "undefined" ? null : localStorage;
  }
  function readJoin(sessionId, storage) {
    const s = storageOrNull(storage);
    if (!s) return null;
    try {
      const raw = s.getItem(key(sessionId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function saveJoin(join, storage) {
    storageOrNull(storage)?.setItem(key(join.sessionId), JSON.stringify(join));
  }
  function clearJoin(sessionId, storage) {
    storageOrNull(storage)?.removeItem(key(sessionId));
  }

  // ../capture/src/buffer.ts
  var MIN_PART_SIZE = 5 * 1024 * 1024;
  var DEFAULT_PART_SIZE = MIN_PART_SIZE;
  function newManifest(trackId, partSizeBytes = DEFAULT_PART_SIZE) {
    if (partSizeBytes < MIN_PART_SIZE) {
      throw new Error(`partSizeBytes must be >= ${MIN_PART_SIZE} (R2 multipart minimum)`);
    }
    return {
      trackId,
      sealedThrough: 0,
      uploaded: [],
      currentPartBytes: 0,
      finished: false,
      bytesRecorded: 0,
      bytesUploaded: 0,
      partSizeBytes
    };
  }
  var ChunkBuffer = class _ChunkBuffer {
    constructor(store, manifest) {
      this.store = store;
      this.manifest = manifest;
    }
    manifest;
    static async open(store, trackId, partSizeBytes = DEFAULT_PART_SIZE) {
      const existing = await store.readManifest(trackId);
      if (existing) return new _ChunkBuffer(store, existing);
      const manifest = newManifest(trackId, partSizeBytes);
      await store.writeManifest(trackId, manifest);
      return new _ChunkBuffer(store, manifest);
    }
    get state() {
      return this.manifest;
    }
    async append(data) {
      if (this.manifest.finished) throw new Error("buffer is finished; cannot append");
      let offset = 0;
      while (offset < data.length) {
        const partNumber = this.manifest.sealedThrough + 1;
        const room = this.manifest.partSizeBytes - this.manifest.currentPartBytes;
        const slice = data.subarray(offset, offset + Math.min(room, data.length - offset));
        await this.store.appendCurrent(this.manifest.trackId, partNumber, slice);
        this.manifest.currentPartBytes += slice.length;
        this.manifest.bytesRecorded += slice.length;
        offset += slice.length;
        if (this.manifest.currentPartBytes === this.manifest.partSizeBytes) {
          this.manifest.sealedThrough = partNumber;
          this.manifest.currentPartBytes = 0;
        }
      }
      await this.store.writeManifest(this.manifest.trackId, this.manifest);
    }
    /** Seal whatever remains as the final part. Idempotent. */
    async finish() {
      if (this.manifest.finished) return;
      if (this.manifest.currentPartBytes > 0) {
        this.manifest.sealedThrough += 1;
        this.manifest.currentPartBytes = 0;
      }
      this.manifest.finished = true;
      await this.store.writeManifest(this.manifest.trackId, this.manifest);
    }
    readPart(partNumber) {
      return this.store.readPart(this.manifest.trackId, partNumber);
    }
    sealedUnuploaded() {
      const done = new Set(this.manifest.uploaded);
      const pending = [];
      for (let p = 1; p <= this.manifest.sealedThrough; p++) {
        if (!done.has(p)) pending.push(p);
      }
      return pending;
    }
    async markUploaded(partNumber, bytes) {
      if (!this.manifest.uploaded.includes(partNumber)) {
        this.manifest.uploaded.push(partNumber);
        this.manifest.uploaded.sort((a, b) => a - b);
        this.manifest.bytesUploaded += bytes;
      }
      await this.store.writeManifest(this.manifest.trackId, this.manifest);
      await this.store.deletePart(this.manifest.trackId, partNumber);
    }
    isFinalPart(partNumber) {
      return this.manifest.finished && partNumber === this.manifest.sealedThrough;
    }
    allUploaded() {
      return this.manifest.finished && this.sealedUnuploaded().length === 0;
    }
  };

  // ../capture/src/stores.ts
  var MemoryPartStore = class {
    parts = /* @__PURE__ */ new Map();
    manifests = /* @__PURE__ */ new Map();
    key(trackId, partNumber) {
      return `${trackId}/${partNumber}`;
    }
    async appendCurrent(trackId, partNumber, data) {
      const k = this.key(trackId, partNumber);
      const existing = this.parts.get(k) ?? [];
      existing.push(data.slice());
      this.parts.set(k, existing);
    }
    async readPart(trackId, partNumber) {
      const segments = this.parts.get(this.key(trackId, partNumber));
      if (!segments) return null;
      const total = segments.reduce((n, s) => n + s.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const s of segments) {
        out.set(s, offset);
        offset += s.length;
      }
      return out;
    }
    async deletePart(trackId, partNumber) {
      this.parts.delete(this.key(trackId, partNumber));
    }
    async readManifest(trackId) {
      const m = this.manifests.get(trackId);
      return m ? structuredClone(m) : null;
    }
    async writeManifest(trackId, manifest) {
      this.manifests.set(trackId, structuredClone(manifest));
    }
    async deleteTrack(trackId) {
      this.manifests.delete(trackId);
      for (const k of [...this.parts.keys()]) {
        if (k.startsWith(`${trackId}/`)) this.parts.delete(k);
      }
    }
  };
  var OpfsPartStore = class {
    root = null;
    static isSupported() {
      return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
    }
    async trackDir(trackId, create) {
      try {
        if (!this.root) {
          const opfs = await navigator.storage.getDirectory();
          this.root = await opfs.getDirectoryHandle("tracks", { create: true });
        }
        return await this.root.getDirectoryHandle(trackId, { create });
      } catch {
        return null;
      }
    }
    async appendCurrent(trackId, partNumber, data) {
      const dir = await this.trackDir(trackId, true);
      if (!dir) throw new Error("OPFS unavailable");
      const file = await dir.getFileHandle(`part-${partNumber}.bin`, { create: true });
      const existing = await file.getFile();
      const writable = await file.createWritable({ keepExistingData: true });
      await writable.write({ type: "write", position: existing.size, data: data.slice().buffer });
      await writable.close();
    }
    async readPart(trackId, partNumber) {
      const dir = await this.trackDir(trackId, false);
      if (!dir) return null;
      try {
        const file = await dir.getFileHandle(`part-${partNumber}.bin`);
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null;
      }
    }
    async deletePart(trackId, partNumber) {
      const dir = await this.trackDir(trackId, false);
      if (!dir) return;
      try {
        await dir.removeEntry(`part-${partNumber}.bin`);
      } catch {
      }
    }
    async readManifest(trackId) {
      const dir = await this.trackDir(trackId, false);
      if (!dir) return null;
      try {
        const file = await dir.getFileHandle("manifest.json");
        const blob = await file.getFile();
        return JSON.parse(await blob.text());
      } catch {
        return null;
      }
    }
    async writeManifest(trackId, manifest) {
      const dir = await this.trackDir(trackId, true);
      if (!dir) throw new Error("OPFS unavailable");
      const file = await dir.getFileHandle("manifest.json", { create: true });
      const writable = await file.createWritable();
      await writable.write(JSON.stringify(manifest));
      await writable.close();
    }
    async deleteTrack(trackId) {
      const dir = await this.trackDir(trackId, false);
      if (!dir || !this.root) return;
      try {
        await this.root.removeEntry(trackId, { recursive: true });
      } catch {
      }
    }
  };

  // ../capture/src/uploader.ts
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var Uploader = class {
    constructor(buffer, transport, opts = {}) {
      this.buffer = buffer;
      this.transport = transport;
      this.opts = opts;
    }
    stopped = false;
    completed = false;
    emit(inFlightBytes = 0) {
      const s = this.buffer.state;
      this.opts.onProgress?.({
        trackId: s.trackId,
        bytesRecorded: s.bytesRecorded,
        bytesUploaded: s.bytesUploaded + inFlightBytes,
        uploadedParts: s.uploaded.length,
        sealedParts: s.sealedThrough,
        finished: s.finished,
        completed: this.completed
      });
    }
    /** Ask the server which parts it already has and mark them locally. */
    async reconcile() {
      const remote = await this.transport.remoteParts(this.buffer.state.trackId);
      const local = new Set(this.buffer.state.uploaded);
      for (const p of remote) {
        if (local.has(p)) continue;
        const data = await this.buffer.readPart(p);
        await this.buffer.markUploaded(p, data?.length ?? this.buffer.state.partSizeBytes);
      }
    }
    async run() {
      const idle = this.opts.idleDelayMs ?? 500;
      const retryBase = this.opts.retryBaseMs ?? 1e3;
      const maxRetries = this.opts.maxRetries ?? 8;
      await this.reconcile();
      this.emit();
      while (!this.stopped) {
        const next = this.buffer.sealedUnuploaded()[0];
        if (next === void 0) {
          if (this.buffer.state.finished) break;
          await sleep(idle);
          continue;
        }
        const data = await this.buffer.readPart(next);
        if (data === null) {
          throw new Error(`part ${next} missing from local store (trackId=${this.buffer.state.trackId})`);
        }
        let attempt = 0;
        for (; ; ) {
          if (this.stopped) return;
          try {
            await this.transport.uploadPart(
              this.buffer.state.trackId,
              next,
              data,
              this.buffer.isFinalPart(next),
              (sent) => this.emit(Math.min(sent, data.length))
            );
            await this.buffer.markUploaded(next, data.length);
            this.emit();
            break;
          } catch (err) {
            attempt += 1;
            if (attempt > maxRetries) throw err;
            await sleep(retryBase * 2 ** (attempt - 1));
          }
        }
      }
      if (!this.stopped && this.buffer.allUploaded()) {
        await this.transport.completeTrack(this.buffer.state.trackId);
        this.completed = true;
        this.emit();
      }
    }
    /** Pause draining; a later run() picks up from the manifest. */
    stop() {
      this.stopped = true;
    }
  };

  // ../capture/src/recorder.ts
  var VIDEO_MIME_PREFERENCE = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  var AUDIO_MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  function pickMimeType(hasVideo, recorderCtor = MediaRecorder) {
    const candidates = hasVideo ? VIDEO_MIME_PREFERENCE : AUDIO_MIME_PREFERENCE;
    for (const c of candidates) {
      if (recorderCtor.isTypeSupported(c)) return c;
    }
    return "";
  }
  function record(stream, opts = {}, recorderCtor = MediaRecorder) {
    const hasVideo = stream.getVideoTracks().length > 0;
    const mimeType = opts.mimeType ?? pickMimeType(hasVideo, recorderCtor);
    const recorder = new recorderCtor(stream, {
      mimeType: mimeType || void 0,
      videoBitsPerSecond: opts.videoBitsPerSecond ?? (hasVideo ? 25e5 : void 0),
      audioBitsPerSecond: opts.audioBitsPerSecond ?? 128e3
    });
    const queue = [];
    let done = false;
    let error = null;
    let wake = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) queue.push(e.data);
      notify();
    };
    recorder.onstop = () => {
      done = true;
      notify();
    };
    recorder.onerror = (e) => {
      error = e.error ?? new Error("MediaRecorder error");
      done = true;
      notify();
    };
    recorder.start(opts.timesliceMs ?? 3e3);
    const chunks = {
      async *[Symbol.asyncIterator]() {
        for (; ; ) {
          while (queue.length > 0) yield queue.shift();
          if (error) throw error;
          if (done) return;
          await new Promise((r) => {
            wake = r;
          });
        }
      }
    };
    return {
      chunks,
      mimeType: mimeType || recorder.mimeType,
      stop() {
        if (recorder.state !== "inactive") recorder.stop();
      }
    };
  }

  // ../capture/src/transport.ts
  var HttpUploadTransport = class {
    constructor(baseUrl, joinToken, fetchFn = (...args) => fetch(...args)) {
      this.baseUrl = baseUrl;
      this.joinToken = joinToken;
      this.fetchFn = fetchFn;
    }
    headers() {
      return { authorization: `Bearer ${this.joinToken}` };
    }
    async uploadPart(trackId, partNumber, data, isFinal, onBytes) {
      const url = `${this.baseUrl}/v1/tracks/${trackId}/parts/${partNumber}${isFinal ? "?final=1" : ""}`;
      if (typeof XMLHttpRequest !== "undefined") {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", url);
          xhr.setRequestHeader("authorization", `Bearer ${this.joinToken}`);
          xhr.setRequestHeader("content-type", "application/octet-stream");
          xhr.upload.onprogress = (e) => onBytes?.(e.loaded);
          xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`uploadPart ${partNumber} failed: ${xhr.status}`));
          xhr.onerror = () => reject(new Error(`uploadPart ${partNumber} network error`));
          xhr.send(data.slice().buffer);
        });
      }
      const res = await this.fetchFn(url, {
        method: "PUT",
        headers: { ...this.headers(), "content-type": "application/octet-stream" },
        body: data.slice().buffer
      });
      if (!res.ok) throw new Error(`uploadPart ${partNumber} failed: ${res.status}`);
    }
    async completeTrack(trackId) {
      const res = await this.fetchFn(`${this.baseUrl}/v1/tracks/${trackId}/complete`, {
        method: "POST",
        headers: this.headers()
      });
      if (!res.ok) throw new Error(`completeTrack failed: ${res.status}`);
    }
    async remoteParts(trackId) {
      const res = await this.fetchFn(`${this.baseUrl}/v1/tracks/${trackId}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`remoteParts failed: ${res.status}`);
      const body = await res.json();
      return body.track.uploaded_parts ?? [];
    }
  };

  // ../capture/src/pipeline.ts
  function runTrackPipeline(recorder, opts) {
    const partSize = opts.partSizeBytes ?? DEFAULT_PART_SIZE;
    const done = (async () => {
      const buffer = await ChunkBuffer.open(opts.store, opts.trackId, partSize);
      const uploader = new Uploader(buffer, opts.transport, {
        ...opts.uploader,
        onProgress: opts.onProgress
      });
      const recording = (async () => {
        for await (const blob of recorder.chunks) {
          await buffer.append(new Uint8Array(await blob.arrayBuffer()));
          const s = buffer.state;
          opts.onProgress?.({
            trackId: s.trackId,
            bytesRecorded: s.bytesRecorded,
            bytesUploaded: s.bytesUploaded,
            uploadedParts: s.uploaded.length,
            sealedParts: s.sealedThrough,
            finished: s.finished,
            completed: false
          });
        }
        await buffer.finish();
      })();
      const uploading = uploader.run();
      await Promise.all([recording, uploading]);
    })();
    return {
      done,
      stop: () => recorder.stop()
    };
  }
  async function resumeTrackUpload(opts) {
    const existing = await opts.store.readManifest(opts.trackId);
    if (!existing) return;
    const buffer = await ChunkBuffer.open(opts.store, opts.trackId);
    await buffer.finish();
    const uploader = new Uploader(buffer, opts.transport, { ...opts.uploader, onProgress: opts.onProgress });
    await uploader.run();
  }

  // src/recording.ts
  var PENDING_KEY = "vr.pendingUploads";
  function storageOrNull2(storage) {
    if (storage) return storage;
    return typeof localStorage === "undefined" ? null : localStorage;
  }
  function readPending(storage) {
    const s = storageOrNull2(storage);
    if (!s) return [];
    try {
      const raw = s.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function addPending(entry, storage) {
    const s = storageOrNull2(storage);
    if (!s) return;
    const list = readPending(s).filter((p) => p.trackId !== entry.trackId);
    list.push(entry);
    s.setItem(PENDING_KEY, JSON.stringify(list));
  }
  function removePending(trackId, storage) {
    const s = storageOrNull2(storage);
    if (!s) return;
    s.setItem(PENDING_KEY, JSON.stringify(readPending(s).filter((p) => p.trackId !== trackId)));
  }
  function makeStore() {
    return OpfsPartStore.isSupported() ? new OpfsPartStore() : new MemoryPartStore();
  }
  async function withTrackLock(trackId, fn, locksOverride) {
    const locks = locksOverride ?? (typeof navigator !== "undefined" ? navigator.locks : void 0);
    if (!locks) return fn();
    return await locks.request(`vr.track.${trackId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return "locked";
      return fn();
    });
  }
  var BITRATES = {
    cam: 25e5,
    screen: 4e6,
    game: 4e6
  };
  var RecordingController = class {
    constructor(apiClient, joinToken, apiBase = "") {
      this.apiClient = apiClient;
      this.joinToken = joinToken;
      this.apiBase = apiBase;
    }
    store = makeStore();
    pipelines = [];
    progress = /* @__PURE__ */ new Map();
    onUpdate = null;
    /** First pipeline failure, surfaced to the UI instead of swallowed. */
    error = null;
    get active() {
      return this.pipelines.length > 0;
    }
    async start(kind, stream) {
      const handle = record(stream, { timesliceMs: 3e3, videoBitsPerSecond: BITRATES[kind] });
      const { track } = await this.apiClient.createTrack(this.joinToken, kind, handle.mimeType || "video/webm");
      addPending({ trackId: track.id, joinToken: this.joinToken });
      const pipeline = runTrackPipeline(handle, {
        trackId: track.id,
        store: this.store,
        transport: new HttpUploadTransport(this.apiBase, this.joinToken),
        onProgress: (p) => {
          this.progress.set(track.id, p);
          this.onUpdate?.();
        }
      });
      if (typeof navigator !== "undefined" && navigator.locks) {
        navigator.locks.request(`vr.track.${track.id}`, () => pipeline.done.catch(() => {
        })).catch(() => {
        });
      }
      pipeline.done.then(() => {
        removePending(track.id);
        return this.store.deleteTrack(track.id);
      }).catch((err) => {
        console.error(`upload pipeline failed for ${kind} track ${track.id}`, err);
        this.error = `${kind} upload failed: ${err instanceof Error ? err.message : String(err)}`;
        this.onUpdate?.();
      });
      this.pipelines.push({ trackId: track.id, kind, pipeline });
      return track.id;
    }
    /** Stop recording; uploads keep draining. */
    stopAll() {
      for (const p of this.pipelines) p.pipeline.stop();
    }
    /** Resolves when every pipeline drained to the server. */
    async waitAll() {
      await Promise.allSettled(this.pipelines.map((p) => p.pipeline.done));
    }
    totals() {
      let recorded = 0;
      let uploaded = 0;
      let completed = 0;
      for (const p of this.progress.values()) {
        recorded += p.bytesRecorded;
        uploaded += p.bytesUploaded;
        if (p.completed) completed += 1;
      }
      return { recorded, uploaded, completed, tracks: this.pipelines.length };
    }
  };
  async function resumePendingUploads(apiBase = "") {
    if (!OpfsPartStore.isSupported()) return { resumed: 0, remaining: readPending().length };
    const store = new OpfsPartStore();
    let resumed = 0;
    for (const entry of readPending()) {
      try {
        const result = await withTrackLock(entry.trackId, async () => {
          await resumeTrackUpload({
            trackId: entry.trackId,
            store,
            transport: new HttpUploadTransport(apiBase, entry.joinToken)
          });
          await store.deleteTrack(entry.trackId);
          removePending(entry.trackId);
          return "done";
        });
        if (result === "locked") continue;
        resumed += 1;
      } catch {
      }
    }
    return { resumed, remaining: readPending().length };
  }
  function formatBytes(n) {
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // src/events.ts
  var Emitter = class {
    listeners = {};
    on(event, cb) {
      (this.listeners[event] ??= /* @__PURE__ */ new Set()).add(cb);
      return () => this.listeners[event]?.delete(cb);
    }
    emit(event, ...args) {
      this.listeners[event]?.forEach((cb) => cb(...args));
    }
  };

  // src/room.ts
  var Room = class _Room extends Emitter {
    constructor(identity, deps = {}) {
      super();
      this.deps = deps;
      this.sessionId = identity.sessionId;
      this.participantId = identity.participantId;
      this.displayName = identity.displayName;
      this.apiBase = identity.apiBase ?? "";
      this.joinToken = identity.joinToken;
      this.api = (deps.createApi ?? ((base) => new Api(base)))(this.apiBase);
    }
    sessionId;
    participantId;
    displayName;
    api;
    apiBase;
    joinToken;
    socket = null;
    rtc = null;
    recorder = null;
    publishedByPrefix = /* @__PURE__ */ new Map();
    latestRoster = null;
    onlineIds = null;
    /** Join via an invite link/token — mints a fresh participant identity. */
    static async join(opts, deps = {}) {
      const api = (deps.createApi ?? ((base) => new Api(base)))(opts.apiBase ?? "");
      const r = await api.join(opts.inviteToken, opts.displayName);
      const room = new _Room(
        {
          apiBase: opts.apiBase,
          sessionId: r.session.id,
          joinToken: r.join_token,
          participantId: r.participant.id,
          displayName: opts.displayName
        },
        deps
      );
      room.connectSocket();
      return room;
    }
    /** Reconnect with an identity obtained earlier (e.g. restored from storage) — no re-join. */
    static resume(identity, deps = {}) {
      const room = new _Room(identity, deps);
      room.connectSocket();
      return room;
    }
    connectSocket() {
      const connect = this.deps.connectSocket ?? connectRoomSocket;
      this.socket = connect(this.sessionId, this.joinToken, (payload) => this.handleMessage(payload), this.apiBase);
    }
    handleMessage(payload) {
      const p = payload;
      if (p.type === "roster" && p.session) {
        this.latestRoster = {
          session: p.session,
          participants: p.participants ?? [],
          tracks: p.tracks ?? [],
          you: this.latestRoster?.you ?? { participant_id: this.participantId, is_owner: false }
        };
        this.emit("roster", this.latestRoster);
      } else if (p.type === "presence" && p.online) {
        this.onlineIds = new Set(p.online);
        this.emit("presence", this.onlineIds);
      } else if (p.type === "control" && p.action) {
        this.emit("control", p.action);
      }
    }
    get roster() {
      return this.latestRoster;
    }
    get online() {
      return this.onlineIds;
    }
    /** Whether this participant is also the session's owner (host). */
    get isOwner() {
      return this.latestRoster?.you.is_owner ?? false;
    }
    /**
     * Connect to the live call. Returns false when the SFU isn't configured
     * server-side — recording still works fully either way.
     */
    async connectLiveCall() {
      const rtc = (this.deps.createRtc ?? ((token, base) => new RtcClient(token, base)))(this.joinToken, this.apiBase);
      rtc.onRemoteTrack = ({ participantKey, trackName, stream }) => {
        this.emit("stream", participantKey, kindOf(trackName), trackName, stream);
      };
      rtc.onRemoteTrackLive = (participantKey, trackName, live) => {
        this.emit("streamLive", participantKey, kindOf(trackName), trackName, live);
      };
      const ok = await rtc.connect();
      if (ok) this.rtc = rtc;
      return ok;
    }
    /**
     * Pull one participant's tracks of a given kind (e.g. only 'cam', never
     * 'screen') — this is how a consumer shows webcams without the map.
     */
    pull(participantId, kind) {
      if (!this.rtc) return;
      const target = this.latestRoster?.participants.find((p) => p.id === participantId);
      if (!target?.rtc_session_id) return;
      for (const name of target.published ?? []) {
        if (kindOf(name) === kind) this.rtc.pull(target.rtc_session_id, name, participantId);
      }
    }
    /**
     * Publish a local stream (camera, screen, canvas — anything). Calling
     * this again with the same prefix atomically replaces what was
     * published under it and re-announces the new names, which is what
     * makes "switch share" visible to everyone instead of only the host.
     */
    async publish(stream, prefix) {
      if (!this.rtc) throw new Error("connectLiveCall() must succeed before publishing");
      const names = await this.rtc.publish(stream, prefix);
      this.publishedByPrefix.set(prefix, names);
      await this.announcePublished();
      return names;
    }
    async unpublish(prefix) {
      const names = this.publishedByPrefix.get(prefix);
      if (!names || !this.rtc) return;
      await this.rtc.closeByName(names);
      this.publishedByPrefix.delete(prefix);
      await this.announcePublished();
    }
    async announcePublished() {
      if (!this.rtc?.sessionId) return;
      const all = [...this.publishedByPrefix.values()].flat();
      await this.api.setRtc(this.sessionId, this.joinToken, this.rtc.sessionId, all);
    }
    // ---- recording: independent of the live call ------------------------------
    /** Start locally recording a stream at full quality; uploads as it records. */
    async startRecording(kind, stream) {
      this.recorder ??= (this.deps.createRecorder ?? ((api, token, base) => new RecordingController(api, token, base)))(
        this.api,
        this.joinToken,
        this.apiBase
      );
      return this.recorder.start(kind, stream);
    }
    /** Stop recording; uploads keep draining until waitForUploads() resolves. */
    stopRecording() {
      this.recorder?.stopAll();
    }
    async waitForUploads() {
      await this.recorder?.waitAll();
    }
    recordingProgress() {
      return this.recorder?.totals() ?? { recorded: 0, uploaded: 0, completed: 0, tracks: 0 };
    }
    /** First recording pipeline failure, if any — surfaced instead of swallowed. */
    get recordingError() {
      return this.recorder?.error ?? null;
    }
    /** Tear down the live call and socket. Local camera/screen tracks are the caller's — stop those yourself. */
    leave() {
      this.socket?.close();
      this.rtc?.close();
      this.recorder?.stopAll();
    }
  };
  function kindOf(trackName) {
    return trackName.split("-")[0] ?? trackName;
  }

  // src/client.ts
  var RecorderClient = class {
    api;
    apiBase;
    constructor(opts) {
      this.apiBase = opts.apiBase ?? "";
      this.api = new Api(this.apiBase, void 0, opts.token);
    }
    listSessions() {
      return this.api.listSessions();
    }
    createSession(name) {
      return this.api.createSession(name);
    }
    getSession(id) {
      return this.api.getSession(id);
    }
    /** Requires confirmName to exactly match the session's name. */
    deleteSession(id, confirmName) {
      return this.api.deleteSession(id, confirmName);
    }
    startRecording(sessionId) {
      return this.api.startSession(sessionId);
    }
    stopRecording(sessionId) {
      return this.api.endSession(sessionId);
    }
    /** Stops recording (if running) AND disconnects every participant from the live call. */
    closeForEveryone(sessionId) {
      return this.api.closeSession(sessionId);
    }
    rotateInvite(sessionId) {
      return this.api.rotateInvite(sessionId);
    }
    /** Host-enforced mute/hide — the target participant's client applies it to their own recording. */
    setParticipantControls(sessionId, participantId, controls) {
      return this.api.setParticipantControls(sessionId, participantId, controls);
    }
    /** A time-limited signed download link for one completed track. */
    getDownloadUrl(trackId) {
      return this.api.downloadUrl(trackId);
    }
    /** Join this session's live room as a participant — e.g. the host recording their own camera. */
    joinRoom(inviteToken, displayName) {
      return Room.join({ apiBase: this.apiBase, inviteToken, displayName });
    }
  };
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=recorder-sdk.js.map
