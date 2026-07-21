import { errNotify } from "./state.mjs";
import { screenShare } from "./screen-share.mjs";

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

export { areaBox };
