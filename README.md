# Session Recorder for FoundryVTT

[![Latest release](https://img.shields.io/github/v/release/fegarza7/recording-video-foundryvtt)](https://github.com/fegarza7/recording-video-foundryvtt/releases/latest)
[![Foundry compatibility](https://img.shields.io/badge/FoundryVTT-v12%20–%20v14-orange)](https://foundryvtt.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Record every player's webcam **locally, in full quality**, while you play.
The live call inside Foundry is just a low-bitrate preview — each
participant's camera records on their own machine in HD (720p) and uploads
resumably in the background. After the session, the GM downloads one clean,
editor-ready video file per player. Recording quality never depends on
anyone's internet connection.

<!-- ─────────────────────────────────────────────────────────────────────
  📹 PLACEHOLDER — usage video
  Replace with a 2–3 minute walkthrough. Example markup:

  [![Watch the walkthrough](docs/images/video-thumbnail.png)](https://www.youtube.com/watch?v=XXXXXXXX)
────────────────────────────────────────────────────────────────────── -->

<!-- ─────────────────────────────────────────────────────────────────────
  🖼️ PLACEHOLDER — hero screenshot
  Suggested shot: a session in progress — cam windows along the bottom,
  red recording dots visible, toolbar open. Save as docs/images/hero.png:

  ![Session Recorder in a live game](docs/images/hero.png)
────────────────────────────────────────────────────────────────────── -->

## Features

- 🎥 **Full-quality local recording** — every participant records their own
  camera and microphone at constant quality; network hiccups never touch
  the files. Live webcam windows for the whole party (draggable,
  resizable, positions remembered per player).
- ✅ **Consent first, always** — every join opens a green room: preview
  your camera, pick your devices, join muted or camera-off, and agree
  explicitly before anything is shared. When the GM starts recording,
  **nothing records on a player's machine until they confirm** — choose
  *Record me*, *Live only* (stay in the call, appear in zero files), or
  *Leave*. A red dot marks recorded participants; a "live only" badge
  marks those who aren't.
- 🎲 **Game view recording** — record the board itself, from any player's
  point of view: the scene, tokens, and movement in Full HD (1080p) with
  **no chat, character sheets, or UI** in frame. The GM requests, the
  player accepts, one click stops it.
- 🖥️ **Screen & area streaming** — share a tab, a window, or a cropped
  region of your screen with the party, recorded in Full HD (1080p) as its
  own file.
- ☁️ **Uploads that survive anything** — recordings upload in resumable
  chunks during play. Closed tab, crash, lost Wi-Fi: it picks up where it
  left off, automatically, next time Foundry opens.
- 📊 **Live upload progress** — Sessions & Downloads shows each
  recording's upload percentage climbing in real time and flips to a
  download button the moment it finishes.
- 🎚️ **GM table controls** — enforce mute or camera-off for any player
  (visible to everyone), plus per-player local mute for your own ears only.
- 🔁 **Built for real sessions** — cameras auto-reconnect if a device
  dies mid-game, dropped feeds heal themselves, missed players are
  re-prompted when recording starts, and past sessions can be reactivated
  to record more.
- 📁 **Tidy by design** — all module sessions live in their own
  "FoundryVTT Session Recorder" project on the platform dashboard; delete
  with typed-name confirmation and a 7-day restore window.

<!-- 🖼️ PLACEHOLDER — feature screenshots (suggested trio):
  ![Green room](docs/images/green-room.png)
  ![Recording choice dialog](docs/images/record-consent.png)
  ![Sessions & downloads with upload progress](docs/images/downloads.png)
-->

## Requirements

- **FoundryVTT v12+** (verified up to v14), opened **in a browser** —
  Chrome or Edge recommended. The desktop (Electron) app doesn't reliably
  support screen-share pickers. Firefox works; its recordings are WebM
  instead of MP4.
- **A secure connection to your Foundry server** — browsers only allow
  camera access over `https://` or `localhost`. If your server is remote
  and plain `http://`, cameras will be blocked by the browser itself.
- **GM only:** a recorder platform account and a **personal API token**
  (dashboard → Settings → API keys), pasted into the module settings.
  **Players need nothing** — no accounts, no installs beyond the module
  the GM already provides.

> **Beta note:** the platform is currently in closed beta. Accounts and
> tokens are provided to testers directly — reach out via
> [issues](https://github.com/fegarza7/recording-video-foundryvtt/issues)
> if you'd like in.

## Install

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/fegarza7/recording-video-foundryvtt/releases/latest/download/module.json
```

Works the same on The Forge (Bazaar → custom manifest URL). Enable the
module in your world, then follow the quick start below.

## Quick start

1. **Module settings** → paste your personal API token (GM only).
2. Click the **video icon** in the left scene toolbar — that's the
   Session Recorder menu.
3. **Sessions & connection → Create session.** The green room opens:
   check your camera, pick devices, consent, join. Every player gets the
   same invitation and green room automatically.
4. Hit the **record button** (circle). You start recording immediately;
   each player confirms their choice — record, live only, or leave.
   Red dots show exactly who is being recorded.
5. Optionally: stream your screen or an area, or open **Game view** and
   request a player's board to record alongside the cameras.
6. Stop recording when done. Everyone keeps Foundry open until their
   upload hits 100% — progress is visible per player.
7. **Sessions & downloads** (film icon): watch uploads complete live and
   download every file. Sessions can be reactivated later to record more.

## Security & privacy

Short version — the long one lives on the
[security page](https://recorder-portal-staging.pages.dev/security):

- **Recording happens on your device.** The full-quality capture is
  local; only encrypted uploads leave your machine (TLS everywhere).
- **Browser permission is not consent.** Nothing is captured or shared
  before you approve it in the green room, and nothing *records* until
  you confirm at recording start. A red dot is visible whenever you're
  being recorded, and you can mute, disable your camera, switch devices,
  or leave at any time.
- **Live only really means not recorded.** Participants record only
  their *own* camera and mic — never the incoming call — so a live-only
  player's face and voice appear in **no files, anywhere**.
- **Private storage, no public links.** Downloads are signed links that
  expire after one hour, and only the session host can create them.
- **You control retention.** Hosts can delete sessions any time; deletion
  has a 7-day restorable grace period, then files are permanently purged.
- **No AI, no third parties.** Recordings are never analyzed, used for
  training, or shared.

## File formats

- Webcams: MP4 (H.264) at HD (720p) — drops straight into any editor.
- Screen shares and game view: MP4 (H.264, `avc3`) at Full HD (1080p) —
  this variant tolerates mid-recording resolution changes (window
  resizes) that would corrupt standard MP4s. Some strict platforms
  refuse `avc3` uploads; if one does, a quick re-encode fixes it:
  `ffmpeg -i in.mp4 -c:v libx264 -crf 18 -preset fast -pix_fmt yuv420p -movflags +faststart -c:a copy out.mp4`
- Firefox records WebM (VP9) instead of MP4.

## Tips & troubleshooting

- "Stream an area" captures this browser tab cropped to the box — pick
  **This Tab** in Chrome's dialog when it appears. Chrome normally hides
  the current tab in that list; the module re-enables it.
- Closing a camera window is only visual — recording never depends on
  the windows. Reopen them all with the camera toolbar button.
- If an upload was interrupted, just open Foundry again — it resumes
  automatically and tells you when everything is safe.
- Something misbehaving? The GM can check the session's **Diagnostics**
  on the platform dashboard — every participant's connection events are
  logged there. Bug reports with those logs (or the browser console,
  F12) are gold: [open an issue](https://github.com/fegarza7/recording-video-foundryvtt/issues).

## License

MIT — see [LICENSE](LICENSE). The Session Recorder platform service is a
separate, proprietary product; this module is the open-source client.
