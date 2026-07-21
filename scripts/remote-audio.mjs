import { camWindows } from "./cam-windows.mjs";

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

function detachAudio(pid) {
  audioEls.get(pid)?.remove();
  audioEls.delete(pid);
}

function remoteAudioEl(pid) {
  return audioEls.get(pid);
}

export { attachAudio, detachAudio, remoteAudioEl };
