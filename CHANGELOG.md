# Changelog

All notable changes to this project will be documented in this file.

## [1.0.23] - 2026-05-01

### Added
- Low-quality video preview toggle in the episode header (📶 HD ↔ 📶 LD), persisted to localStorage. When LD is on, every `/api/video` request gets `&q=low` and the server serves a cached `.low.mp4` derivative (720p max, H.264 CRF 28, AAC 96k, faststart) instead of the full-quality reel. First request for a given video kicks off ffmpeg in the background (non-blocking, in-flight tracked in a Set so parallel requests don't double-spawn) and falls back to the original — so video starts playing immediately with no transcoding delay; subsequent loads pick up the cached low version. Atomic write via `.tmp` → rename so partial transcodes never get served. New `X-Video-Quality` response header reports `low`, `full`, or `preparing`. Toggle swaps `src` on visible `<video>` elements in place, preserving playback position and play/pause state. Skipped on overlay editor previews (positioning needs full resolution) and download links (full file required).

## [1.0.22] - 2026-05-01

### Changed
- Reel-level pipeline jobs now run on two independent lanes per reel instead of one. Pressing **SUB** (subtitle burn) and **Generate captions** on the same reel no longer queues the second behind the first — they run in parallel, since one rewrites the reel's video file (ffmpeg) and the other only writes JSON metadata (LLM call). The lock in `server/pipeline.js` was previously keyed on `slug:reelId`, so any two reel-level steps shared a queue. It now splits into a `video` lane (`subtitle`, `overlay`, `crop`, `cut`) and a `meta` lane (`generate`), keyed `slug:reelId:video` vs `slug:reelId:meta`. Within a lane jobs still serialize (so overlay still waits for subtitle on the same reel — they share the working video file), and episode-level steps keep the bare `slug` key so transcribe still blocks the things that depend on it. The `runReelChain`, stop-by-slug, slug-rename remap, and graceful-shutdown paths all key off prefix matches and continue to find every running process unchanged.

## [1.0.21] - 2026-05-01

### Fixed
- Chunked uploads no longer get stranded if the browser tab closes (or the network drops) between the last chunk landing and the `/api/upload-complete` call. Previously the chunks would sit in `.uploads-state.json` forever and the user would never see the episode in the list — they'd just see a successful progress bar followed by nothing. The dashboard now sweeps `.uploads-state.json` on startup and hourly, finalizes any upload whose chunks are all on disk (using the slug/guest/role/mediaType captured at upload-init), and only prunes after 24 h if chunks are genuinely missing. A `status: "finalizing"` guard prevents the sweep from racing a client retry.
- Slug sanitization now preserves Unicode letters and digits (`\p{L}\p{N}`) instead of stripping everything that isn't `[a-zA-Z0-9_-]`. Arabic/Hebrew/Cyrillic titles like `الحرب الاخيرة` survive as `الحرب-الاخيرة` instead of collapsing to a string of dashes (which silently overwrote any earlier all-Arabic upload that hashed to the same dashed slug). Path-traversal characters (`/`, `..`) still get stripped. Affects every entry point: the simple `/api/upload`, the URL-download path, chunked init, chunked complete (with override), and `/api/rename-episode`.

## [1.0.20] - 2026-05-01

### Added
- Resumable uploads for plain video files. When a long upload drops mid-flight (network blip, browser close, server restart), pick the same file again and the upload picks up where it left off instead of restarting from 0. Files are now sent in 5 MB chunks via the existing `/api/upload-init` → `/api/upload-chunk` → `/api/upload-complete` plumbing (which was already on the backend but unused by the browser). The client tracks each in-flight upload in `localStorage` keyed by `name|size|lastModified`, validates against the server's chunk state on retry, and skips already-received chunks. The progress bar shows `↻ Resuming: …` when picking up a partial upload. Multi-track and SRT-attached uploads still use the existing single-POST path.

### Changed
- `/api/upload-complete` now accepts `slug`, `guest`, `role`, `mediaType`, and `transcribeMethod` overrides at completion, so settings reflect what the user typed on their final attempt rather than the first init. It also fires transcription (or logs the skip) the same way `/api/upload` does — chunked uploads previously completed silently with no transcription kicked off.

## [1.0.19] - 2026-04-29

### Fixed
- Manual LLM modals (e.g. asking for a reel caption or title) no longer pop up for every admin watching the dashboard. The server still broadcasts the prompt to all clients (no per-user identity), but each browser now only opens the modal for slugs *it* initiated work on. Logs and progress still stream to everyone — only the focus-stealing modal is filtered. Claims are tracked per tab via sessionStorage and carry across the temp-slug → real-slug rename that AI auto-titling triggers.

## [1.0.18] - 2026-04-29

### Added
- Episode-level hide / done / owner. Each episode in the sidebar now has the same `✓` (done) and `−` / `👁` (hide) buttons that reels already have, mirrored from the reel pattern. Done episodes drop into a collapsible **Done** folder at the bottom of the sidebar; hidden ones drop into **Hidden** below that. Both folders only render when non-empty, and clicking the header expands or collapses them. New endpoints: `POST /api/hide-episode` and `POST /api/done-episode`, both toggle `meta.json` flags in place.
- Owner picker in the episode header. When a workspace has a `profiles.json` (multi-user mode), the episode header gets an "owner" `<select>` next to the media-type picker, so an owner can be assigned (or reassigned) after upload — previously `meta.owner` was only set at upload time and had no UI to change. The chosen owner is persisted via the new `POST /api/set-episode-owner` endpoint and surfaces as a small purple chip on the sidebar row, so you can see at a glance who owns what.

## [1.0.17] - 2026-04-29

### Changed
- Moved the **↑ SRT** upload button into the Reel Transcript section, paired with the existing **↓ SRT** download button. Removed it from the Sub-step pipeline row (where it competed with the style dropdown and In-final toggle). Upload and download now sit side-by-side in the same place — a natural "swap transcript" pair, and the editor refreshes inline to show the uploaded SRT.

## [1.0.16] - 2026-04-29

### Added
- Rename option for reels and episodes. Episode header gets a "Rename" button next to the title that prompts for a new slug, sanitizes it (lowercased, alphanumeric + hyphens), checks for collisions, and renames the directory via the existing `renameEpisode()` plumbing — open clients switch over via the `episode-renamed` socket event. Reels get a ✎ button in both the sidebar row and middle reel-list row that prompts for a new hook; the new `/api/rename-reel` endpoint writes it to `analysis.json` (and `content.json` if present).

## [1.0.15] - 2026-04-29

### Changed
- Reel Transcript editor (standalone reel-uploads) now prefers `full-chunks.json` over `transcript.json`, mirroring the per-reel loader. Previously, uploading an SRT (↑ SRT) wrote new chunks but the editor still rendered the old whisper transcript, so the user couldn't edit the uploaded SRT in the panel.
- After ↑ SRT upload (per-reel and standalone), the transcript editor auto-refreshes to show the new chunks — no second click on "Load / Edit" needed before adjusting.

## [1.0.14] - 2026-04-29

### Changed
- Reel-upload view: top episode-pipeline chip bar now only shows Transcribe + Caption (and Compose for multi-track). The Subtitle and Overlay chips, which were duplicated here and in the per-reel pipeline below, have been removed from the top — the per-reel row is the canonical place for them since it has the richer controls (style dropdown, ↑ SRT upload, In final / Skip toggle, Customize). Cuts the "three Sub-buttons" clutter on uploaded reels.

## [1.0.13] - 2026-04-29

### Added
- Reel-upload pipeline (single uploaded reel, e.g. `war1`): `↑ SRT` button now also appears on the standalone Sub step. Uploaded SRT writes to `full-chunks.json` and clears `full-subtitled.mp4` / `full-final.mp4` so the next Sub re-burns. v1.0.10 only added the button to extracted reels; this fills in the missing case.

## [1.0.12] - 2026-04-29

### Added
- Reel pipeline: new "⬇ Download" button in the meta actions row (next to Trim/Done/Hide/Delete) downloads the reel MP4 with a friendly `<slug>-reel-<id>.mp4` filename. Button is hidden until the reel has at least one rendered stage (cut/cropped/subtitled/final). Backed by `?download=1` on `/api/video`, which sets `Content-Disposition: attachment` with a sanitized filename.

## [1.0.11] - 2026-04-29

### Changed
- Reel list views (sidebar under active episode + middle reel-list column) now group reels into Active / Done / Hidden sections. Done and Hidden are collapsible folders at the bottom — click the header to expand. Marking a reel done or hidden moves it into its folder regardless of cut/cropped/subtitled/final state.
- Middle reel-list column gained the missing Done (✓) button per row, matching the sidebar.
- Reel detail view (pipeline action bar) gained a "Mark Done" / "Done" button next to Hide.

## [1.0.10] - 2026-04-29

### Added
- Reel pipeline: new "↑ SRT" button next to the Sub step lets you upload an SRT file to replace a reel's existing transcript. The SRT is parsed into clip-time chunks, written to `reel-XX-chunks.json` with a matching state file (so the chunker doesn't try to remap them), and stale `-subtitled.mp4` / `-final.mp4` outputs are removed so the next Sub re-burns from the uploaded subtitles.

## [1.0.9] - 2026-04-29

### Added
- Inline AI-revise feedback row under the reel caption editor (both per-reel detail view and standalone reel-full view). Type a note like "make it shorter" or "lead with the hook" and hit ↩ Revise — the LLM rewrites the caption in place. Reuses the same `feedbackRow()` / `/api/feedback` plumbing already wired up for YouTube titles and episode content blocks, so it works in manual LLM mode too.

## [1.0.8] - 2026-04-29

### Fixed
- "Copy Full Prompt" (and Copy System / Copy User) buttons in the LLM modal now actually write to the clipboard on the production dashboard. The site is served over plain HTTP, where `navigator.clipboard` is undefined; the buttons called it directly with no fallback so the click silently did nothing. Routed all three through `copyToClipboard()` in `utils.js`, which now gates the modern API on `window.isSecureContext` and falls back to a `document.execCommand('copy')` textarea — and surfaces an error toast instead of lying about success when the fallback fails.

## [1.0.7] - 2026-04-28

### Changed
- Reel pipeline: the Sub step now shows a single inline action button ("In final" / "Skip") alongside the Highlight/Background dropdown, matching the Overlay step's pattern. Removed the redundant "Preview on / Preview off" toggle and its dead supporting code (`toggleSubtitles`, `hideSubtitles`, `&subs=off` URL plumbing).

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
