# Session Recorder for FoundryVTT

Record every player's webcam **locally in full quality** while you play —
uploads happen resumably in the background, and the GM downloads clean,
per-player video files after the session. The live call inside Foundry is
just a low-bitrate preview; recording quality never depends on anyone's
connection.

Live webcam windows for the whole party (draggable, resizable, positions
remembered per player), GM-enforced mute/camera controls, screen or
area streaming for your map, and a built-in browser for all your sessions
and downloads.

## Install

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/fegarza7/recording-video-foundryvtt/releases/latest/download/module.json
```

Works the same on The Forge (Bazaar → custom manifest URL).

## Requirements

- **Run Foundry in a browser** (Chrome/Edge recommended). The desktop
  (Electron) app doesn't reliably support screen-share pickers.
- A recorder platform account for the GM. Generate a **personal API
  token** on the dashboard (API tokens page) and paste it into the
  module settings. Players need nothing — no accounts.

## Quick start

1. Module settings: paste your API token.
2. Click the **video icon** in the left toolbar.
3. **Sessions & connection → Create session** — allow your camera.
   Players get a join prompt automatically.
4. Hit the **record button** (circle). Red square = recording.
5. When you stop, everyone keeps their tab open until uploads hit 100%.
6. **Sessions & downloads** (film icon) lists every session's files.

## Notes

- "Stream an area" captures this browser tab cropped to the box — pick
  **This Tab** in Chrome's dialog when it appears.
- Chrome hides the current tab in the tab-share list by default; the
  module re-enables it, but if a tab is missing, that's why.
- Recording continues even if you close a camera window — reopen them
  with the camera toolbar button.

## License

MIT — see [LICENSE](LICENSE).
