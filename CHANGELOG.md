# Changelog

All notable changes to this project will be documented in this file.

## [1.0.6] - 2026-04-28

### Fixed
- `subtitle.js` no longer fails with "Source video not found" when `meta.rawVideo` carries a stale absolute path baked in by an older container layout (e.g. `/app/episodes/...` from before the move to `/data/episodes/...`). It now prefers `meta.rawVideo` when the file actually exists, falls back to the same basename inside the current episode dir, and finally scans for any `raw.*` file. Unblocks Sub on uploaded reels whose meta was written under the old path.

## [1.0.5] - 2026-04-28

### Fixed
- CLI scripts (`subtitle.js`, `analyze.js`, `crop.js`, `overlay.js`, `generate.js`, `cut.js`, `compose.js`, `analyze-clips.js`) now honor the `EPISODES_DIR` env var via `utils.js`. Previously the dashboard read/wrote `/data/episodes` (the mounted persistent volume) but spawned child processes fell back to `/episodes` inside the container, so Sub/Re-sub on uploaded reels reported "No transcript.json found" even when the transcript existed.

## [1.0.4] - 2026-04-28

### Changed
- Version chip in the sidebar header is now monospace, larger, and color-coded by build age (green <60min, indigo <24h, grey older). Easier to glance at after a deploy.
- Static-file route now sends `Cache-Control: no-cache` for HTML/JS/CSS so browsers always pick up the latest build immediately after a deploy. Eliminates the "stale upload.js still showing the old Groq warning" class of bug.

## [1.0.3] - 2026-04-28

### Changed
- Unified persistent storage under a single data root (`/opt/tajarib-data/` on the VPS, mounted as `/data`). Repo is now code-only and disposable; episodes/uploads/configs/guests live outside the git tree and survive every redeploy.
- Global config dir is configurable via `TAJARIB_CONFIG_DIR` (defaults to `~/.tajarib` for local dev).
- `guests.json` is now read/written from the persistent config dir; the in-repo file is treated as a one-time seed for fresh installs.
- `profiles.json` lookup now prefers the persistent config dir.

### Fixed
- SUB button on uploaded reels (`reel_full` / `reel_cut`): no longer rejects with "not applicable" when the reel has no transcript. Subtitle/crop/overlay are now allowed for reel uploads, and the existing auto-transcribe-then-subtitle chain handles the missing-transcript case.

### Added
- `/api/version` endpoint exposing running version, short commit SHA, and build timestamp.
- Version chip in the dashboard sidebar header (turns green when the running build is fresh).
- Webhook deploys now stamp each build with the current SHA + UTC timestamp via Docker build args.

## [1.0.1] - 2026-03-23

### Fixed
- Subtitle/transcript mismatch: reconcile missing first-word timestamps from Whisper segments using `reelWordsFromTranscript()`, which merges `segments[].text` with `segments[].words[]` to cover gaps
- Transcript editor now shows exact subtitle chunks (same chunking logic as subtitle.js) scoped to reel duration — editor and burned subs now match exactly
- `hasLoadedEditor` guard used wrong CSS selector (`.seg-word`) that never matched; changed to `#rt-seg-list` so socket updates no longer reset the transcript editor
- Lower-third MOV animation cut off abruptly — changed `enable='between(t,ltStart,ltEnd)'` to `enable='gte(t,ltStart)'` with `eof_action=pass` so animation plays to its natural end
- Shadow overlay darkened subtitle area — shadow is now cropped to top half of frame only (`crop=W:H/2:0:0,pad=W:H:0:0`) so subtitles remain clearly visible

### Changed
- Transcript editor renamed "Save & Re-sub" (was "Save & Re-burn Subs") for consistency with "Save & Re-cut"
- Transcript editor saves to `reel-XX-chunks.json` (subtitle chunks) instead of raw Whisper word timestamps
- Removed transcript editor modal — superseded by the Reel Transcript panel and boundary adjuster
- Overlay config is now saved as workspace-wide default when saving episode config; new episodes inherit settings automatically
- Overlay config fallback chain: episode-specific → workspace default → hardcoded defaults

### Added
- `reelWordsFromTranscript()` exported from subtitle.js for reconciling incomplete Whisper word-level timestamps
- `workspace-level overlay-config.json` as global default for new episodes
- Test coverage for `reelWordsFromTranscript()` including missing-first-word synthesis
- Updated stale tests to match refactored subtitle layer count (2 layers) and 60s teaser skip behavior
