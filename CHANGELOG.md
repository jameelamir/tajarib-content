# Changelog

All notable changes to this project will be documented in this file.

## [1.0.50] - 2026-05-23

### Fixed
- Buffer publishing again, after 0x0.st (the temp host v1.0.48 switched to) disabled uploads with "uploads disabled because it's been almost nothing but AI botnet spam for the past few months." Swapped to `uguu.se` (100MB limit — matches our 95MB compression cap exactly; 24h retention — enough for Buffer to fetch + post; HEAD requests return 200 with proper headers on file URLs, which is what Buffer's media-accessibility verifier needs). API is JSON (not plain text like 0x0.st), so the response parsing now uses `JSON.parse` and extracts `files[0].url`, with explicit errors for non-JSON or `success:false` responses so the next time a temp host changes its API we get a clear log line instead of `Upload returned invalid response`. `buffer.js`.

## [1.0.49] - 2026-05-23

### Fixed
- Two simultaneous "Re-sub" clicks on different reels no longer thrash the server. Previously each resub spawned its own `subtitle.js` child, which called `execFileSync("ffmpeg", ...)` to burn subs with libass + libx264 (CPU only, no GPU). Two parallel burns competed for the same cores and each ran 2-3× slower, plus the post-step `prewarmReelStep` would fire another low-quality ffmpeg right when the second resub was still running, so peak load could be 4 concurrent ffmpegs. From the UI it looked like both reels hung. Added a global ffmpeg slot gate in `server/pipeline.js` covering all heavy steps (`subtitle`, `overlay`, `crop`, `clean`, `cut`) across both spawn entry points (`_runStep` for single-step runs, `spawnReelStep` for batch `runReelsParallel`). Default limit is 2, overridable via `TAJARIB_FFMPEG_MAX` env var (set to `1` to fully serialize on slower machines). When the gate is full, additional requests log `⏳ Waiting for ffmpeg slot` and run as soon as a slot frees up. Slot is released in both `error` and `close` handlers so a crashed child can't leak the gate. `server/pipeline.js`.

## [1.0.48] - 2026-05-23

### Fixed
- Publishing to Buffer no longer fails with `HTTP 405 Not Allowed: Video URL is not accessible`. The temp host used to make the freshly-compressed reel reachable to Buffer's media-fetch was `litterbox.catbox.moe`, which rejects HEAD requests with 405 (and GET on the root with 403). Buffer's media-accessibility check uses HEAD, so every Facebook/Instagram/LinkedIn post was bouncing before it ever queued. Swapped to `0x0.st`, which serves HEAD properly. 72h retention preserved via the `expires=72` form field; 95MB compression cap in `server/publishing.js:8` keeps us well under 0x0.st's 512MB limit. `buffer.js`.

## [1.0.47] - 2026-05-22

### Fixed
- Reel Transcript and Caption sections now also track the episode slug, not just the reel id, so navigating across episodes correctly re-loads when the new episode's reel has the same id as the last-viewed reel from a previous episode (very common — reel ids are "01", "02", etc., so a v1.0.44 reader would see Episode A's reel 01 transcript persist when clicking reel 01 in Episode B). Added `reelTranscriptSlug` and `reelCaptionSlug` companion variables; preserve guards now require both slug AND reel id to match. `loadReelTranscript` captures `currentSlug` at call time into a local `slug` and uses a `stillCurrent()` closure for the post-await race guards, so a stale fetch from a previous episode can't clobber the newer reel's `reelChunksData` or `tlState.chunks` either. `public/js/reel-ui.js`.

## [1.0.46] - 2026-05-22

### Added
- Guest filter selection now persists across page refreshes. Previously the sidebar guest filter lived only in the in-memory `guestFilter` variable, so reloading the page (or coming back tomorrow) cleared whatever guest you had filtered to. Now `setGuestFilter()` writes the active filter to `localStorage['tajarib-guest-filter']` (removing the key when cleared so an empty filter doesn't linger), and `init.js` restores it after `refresh()` completes by populating the `#ep-guest-filter` input and re-invoking `setGuestFilter()` so the sidebar renders filtered on first paint. Follows the same `tajarib-*` localStorage key convention used for `tajarib-selected-slug`, `tajarib-default-media`, and `tajarib-section-*`. `public/js/episode-ui.js`, `public/js/init.js`.

## [1.0.45] - 2026-05-22

### Added
- Restart Server button in Settings → Server. One click and the dashboard container restarts itself, no more "ssh into the VPS and `docker restart tajarib-app`" detour. The button proxies through the existing `tajarib-webhook` container (which already has the docker socket and runs outside the app, so it can restart the app without killing itself mid-request). Implementation: `POST /restart-app` on the webhook, HMAC-signed with the existing `WEBHOOK_SECRET` (same secret + same `sha256=` envelope as the GitHub deploy webhook, separate `x-tajarib-signature` header to avoid colliding with GitHub's `x-hub-signature-256`); `POST /api/restart-app` on the dashboard signs an empty body and proxies to `http://webhook:9000/restart-app` over the compose default network (configurable via `WEBHOOK_INTERNAL_HOST` if the topology changes). Returns 503 if `WEBHOOK_SECRET` is unset, 502 on webhook unreachable, 504 on a 5s timeout. Double-click guarded by a `restarting` flag in the webhook and `btn.disabled` in the UI. `scripts/webhook-receiver.js`, `server/routes/settings.js`, `index.html`, `public/js/config.js`.

## [1.0.44] - 2026-05-22

### Fixed
- Caption section now updates when navigating between reels. The preserve-edits guard only checked `document.activeElement === captionTextarea`, but reel-list-items are `<div>` elements and clicking a div does not blur a focused textarea. So once the user had clicked into the caption and switched reels, the textarea kept focus, the guard returned true, and the previous reel's caption stayed on screen. Added `reelCaptionReelId` tracking (mirrors `reelTranscriptReelId`) and now require both focus AND that the textarea belongs to the current reel before preserving. `public/js/reel-ui.js`.

### Changed
- Reel Transcript section now auto-loads on reel switch instead of requiring a Load / Edit button click. The button is removed (dock toggle stays). When the user clicks a reel, `loadReelTranscript(reelId)` fires automatically as part of `renderReelDetail`. Added a race-guard in `loadReelTranscript` that bails out if `reelTranscriptReelId` changes between awaits (covers fast A → B navigation while A's fetch is in flight), so a stale fetch can't clobber the newer reel's `reelChunksData` or `tlState.chunks`. The 5-second refresh poll doesn't re-trigger the fetch because the existing `loadedForCurrentReel` check preserves the already-initiated state. `public/js/reel-ui.js`.

## [1.0.43] - 2026-05-22

### Fixed
- Guest filter and per-card guest line now actually appear on the dashboard. v1.0.41 and v1.0.42 added the filter HTML to `public/index.html`, but the server (`server/routes/static.js`) serves the root-level `index.html` (the modular dashboard that loads `style.css` externally) at `/`, and falls back to `public/` only for sub-paths. So the filter was only visible at the explicit `/index.html` URL, not at `/`. Added the filter input directly under `.sidebar-header` in the root `index.html` so it shows on the page everyone actually uses, and moved the `.ep-filter-bar` and `.ep-guest-line` styles into `public/style.css` (the file the modular dashboard loads). `index.html`, `public/style.css`.

## [1.0.42] - 2026-05-22

### Changed
- Guest filter input now sits directly under the sidebar header (above the Episode/Reel media type buttons) instead of buried below the two upload zones, Space-Saving Tip, and Zapier Connected boxes. Previously the filter rendered ~512px down the sidebar, so on any normal viewport it was below the fold and easy to miss. Now it is the first thing under the title, with a `🔍` prefix in the placeholder to read more obviously as a search box. `public/index.html`.

## [1.0.41] - 2026-05-19

### Added
- Guest name now appears on every episode card in the sidebar, directly under the slug, as a clickable `👤 Guest · Role` line. Clicking the chip auto-applies that guest as a filter on the new "Filter by guest" input above the episode list. The filter is a case-insensitive substring match across the active, Done, and Hidden buckets, and Done/Hidden auto-expand while a filter is active so matches in those folders are visible. Clearing the filter (`×` button) restores the previous folder open/closed state. When no episodes match, the list shows a small "No episodes match" empty state instead of going blank. Implementation: `guestFilter` state plus `setGuestFilter`, `clearGuestFilter`, `filterByGuest`, and a `jsAttr` helper for safely embedding guest names in inline handlers (guest names can contain quotes, so the existing single-quote escape pattern used for slugs is not safe). `public/js/episode-ui.js`, `public/index.html`.

## [1.0.40] - 2026-05-08

### Changed
- LD (low-quality preview) toggle now actually feels low-quality on slow internet. Previous settings (720p / CRF 28 / 96k audio) shrank files only modestly; new settings are 540p / CRF 30 / 64k audio, typically 2–3× smaller. The biggest user-visible fix is mid-session auto-swap: the original behavior was that the *first* watch of any video always served the full file (because ffmpeg ran in the background and `ensureLowQuality` returned `null` until done), so toggling LD looked like a no-op. The browser now polls a new `&probe=1` endpoint on `/api/video` every ~5s while the server is still transcoding (`X-Video-Quality: preparing`), and as soon as the `.low.mp4` is ready the player reloads with the small file at the same playhead position — so even on first watch you transition to the small file within seconds rather than paying the full-file bandwidth cost. Existing cached `.low.mp4` files generated with the old settings are now detected as stale via a `LD_SPEC` version marker (`v2-540p-crf30-a64k`) written to a `.low.mp4.spec` sidecar, so they regenerate on next request instead of serving the old (less compressed) cache. Publishing pipeline is unaffected — `download=1` and `publish-routes.js` continue to bypass the low-quality file. `server/low-quality.js`, `server/routes/media-routes.js`, `public/js/state.js`.

## [1.0.39] - 2026-05-06

### Added
- "0-Gap" button in the reel transcript section that closes every gap between consecutive subtitle chunks: each chunk's end is set to the next chunk's start so subtitles flow continuously with no on-screen blank moments. Pure timestamp normalization — text isn't touched, in-progress edits are synced first, the timeline subtitle track re-renders to reflect the new bounds, and a status line reports the number of gaps closed. Behavior matches the existing split/merge helpers: changes live in memory until you hit Save. `public/js/reel-ui.js`.

## [1.0.38] - 2026-05-05

### Added
- New **Clean** step in the per-reel pipeline, sitting between **Cut** and **Crop**, that strips filler words and silences from a cut reel. Filler removal matches against a conservative list (English `um/uh/uhm/er/hmm/mm`, Iraqi-Arabic `اه/يعني/إيه`) and is text-based, so it works whether the transcript came from Whisper or an uploaded SRT. Silence removal walks the gaps between consecutive word timestamps and cuts any gap longer than the chosen threshold (Tight >0.5s, Med >0.7s default, Light >1.0s, or off). Each removed range gets 80ms of padding on either side so cuts feel natural rather than choppy. Output is `reel-NN-cleaned.mp4` — the original `reel-NN.mp4` is preserved, and `crop.js` automatically prefers the cleaned source when it exists. Subtitles re-sync automatically because `subtitle.js` already re-transcribes the cropped reel. Per-reel `reel-NN-transcript.json` (real Whisper word timing) is preferred over the episode transcript when available, since SRT-uploaded transcripts have synthesized zero-gap word timing that defeats silence detection. Cleaning refuses to run if it would gut the reel (>99% removed) or all words are inside cut zones. Implementation: new `clean.js` script + plumbing in `server/pipeline.js` (clean joins the `video` concurrency lane), `server/routes/pipeline-routes.js` (passes `silenceThreshold`/`removeFillers`), `server/episodes.js` (exposes `cleaned` reel state), `server/low-quality.js` (LD preview prewarm), `crop.js` (input fallback), `cut.js` (extends downstream-stale cleanup to include `-cleaned.mp4`), and `public/js/reel-ui.js` (Clean button + silence threshold dropdown + fillers checkbox in the per-reel pipeline strip). Bulk "process-reels" still skips Clean — it stays opt-in per reel because over-aggressive trimming on reflective interviews can sound jumpcut-y.

## [1.0.37] - 2026-05-05

### Added
- Persistent overlay asset library with visual thumbnail picker. Every overlay slot (Sponsor, Logo, Lower Third, CTA) now renders a horizontal-scroll strip of preview thumbnails sourced from the existing `/api/assets/file/<name>` endpoint, with the selected file highlighted by an accent border and a `+` button that opens the upload dialog. Logo previously had no upload UI at all in the overlay panel — only X/Y/Scale sliders that assumed a file named `logo.{ext}` already existed in `assets/`. CTA had a bare `<input type="file">` with no way to swap back to a previously uploaded button. Both now match what Sponsor and Lower Third already had. New helpers in `public/js/overlay.js`: `renderAssetPickerStripHTML(opts)` returns the placeholder markup, `populateAssetPickerStrip(stripId, typeFilter, currentFile, selectFn)` fills it via `/api/assets/browse`. New CSS classes in `public/style.css`: `.asset-picker-strip`, `.asset-thumb`, `.asset-thumb.selected`, `.asset-upload-btn`. New select/upload handlers `selectLogoAsset`, `uploadLogoAsset`, `selectCTAAsset`.

### Fixed
- Logo and CTA uploads no longer overwrite each other. `POST /api/upload-asset` was saving logo files to a fixed `assets/logo.{ext}` and CTA files to `assets/cta{ext}`, so each new upload destroyed the previous one. Sponsor and lower-third already preserved the original filename — logo and CTA now do the same (`server/routes/media-routes.js:285-289`). User can keep many logos and CTA images side by side and switch between them via the picker. Compositor (`overlay.js`) now resolves the logo from `config.logo.file` first, then falls back to the legacy `logo.{ext}` lookup; CTA resolution is symmetric, reading `config.cta.imagePath` (which already existed in the config schema but was being ignored). The live drag-and-drop preview canvas (`getOverlayElements`, `drawLiveOverlay` in `public/js/overlay.js`) was updated to honor the same config fields, so a custom-named logo shows in the canvas preview, not just the rendered FFmpeg output.

### Changed
- `assets/.preview-*` (the WebM VP9 alpha previews generated on demand by `/api/assets/video/<name>` for live overlay playback in the browser) are now gitignored, matching the existing `.thumb-*` rule. They are regenerated automatically when the source asset changes.

## [1.0.36] - 2026-05-05

### Added
- "Recut from source" action on each reel in episode mode. When the existing cut has drifted (timestamps no longer reliable, e.g. after re-trim, transcript edits, or upstream pipeline changes), the new button matches the reel's transcript text against the episode word-level transcript and re-cuts a fresh raw clip at the matching boundaries — no dependence on the stored start/end. Useful when you have a finished reel and want to start fresh from the source. Flow: click ↺ Recut on a reel, the system runs a dry-run match and shows a confirm dialog with old vs new times and match confidence; on accept it updates `analysis.json`, wipes stale derived files (cut, cropped, subtitled, final, chunks, ASS), and triggers the standard `cut` step to render a new raw clip — crop/sub/overlay then need to be redone. Implementation: new `POST /api/recut-from-source` in `server/routes/reel-routes.js`, new aligner `alignReelTextToEpisode` in `utils.js` (Arabic-aware: strips diacritics, normalizes alef/ya/ta-marbuta, tolerates morphological prefixes/suffixes like `لكن`/`لكننا`; bag-of-words sliding window finds the matching region in the episode, then cluster-density localizes precise start/end). Validated against real reel transcripts: matches stored timestamps within ~2s; synthetic round-trips match within 1s at 95% confidence.

## [1.0.35] - 2026-05-05

### Added
- Copy transcript button in the reel transcript section, alongside the SRT upload/download buttons. Joins all chunk text with newlines, syncs in-progress edits first, and uses the existing `copyToClipboard()` toast util. `public/js/reel-ui.js`.

## [1.0.34] - 2026-05-05

### Fixed
- Sponsor / logo / CTA / lower-third overlay uploads no longer fail with `EXDEV: cross-device link not permitted` on the production VPS. Formidable writes the temp file to `UPLOADS_DIR` (`/data/uploads`, the bind-mounted host volume), but `/api/upload-asset` was finalizing it to `<repo>/assets` (`/app/assets` inside the container, on the container's overlay filesystem). `fs.renameSync` across filesystems errors with `EXDEV`. Fixed by wrapping the rename in the same `EXDEV` → `copyFileSync` + `unlinkSync` fallback that `server/routes/upload-routes.js` already uses for episode video uploads. `media-routes.js:293`.

## [1.0.33] - 2026-05-05

### Changed
- Hybrid-mode "Fill manually" choice now shows the LLM prompt to copy-paste into your own Claude — same flow as top-level Manual mode, just per-step. Previously v1.0.31 wrote empty placeholders and asked you to type the result yourself, which wasn't what users meant by "manual" — they wanted the prompt so they could run it through whatever model they prefer. Implementation: child processes (`analyze.js`, `generate.js`, `compose.js`) get spawned with `TAJARIB_FORCE_MANUAL=1` env var when the user picks manual; `llm.js` checks that env var in `getConfig()` and forces `mode='manual'` for that spawn, which makes `llm.chat()` return null and triggers the existing exit-42 → `llm-prompt` socket flow. In-process callers (`/api/feedback`, `/api/generate-title`, `/api/analyze-clips`) pass a `forceManual` opt through `callClaude` → `llm.chat({forceManual: true})` for the same effect without env vars.

### Removed
- `server/manual-steps.js` (the empty-placeholder writer) — no longer needed since manual mode now routes through the existing paste flow for every step.
- `#llm-title-modal` HTML, `openManualTitleModal` / `submitManualTitle` / `cancelManualTitle` JS, and the `POST /api/llm-title-input` endpoint — replaced by the standard paste prompt for manual title generation.

## [1.0.32] - 2026-05-05

### Added
- Upload progress bar for overlay assets (sponsor, lower-third, CTA). The three overlay upload flows in `public/js/overlay.js` now drive the same `#upload-progress` element that the main video upload already uses, so the user sees `Uploading sponsor: 12.3 / 45.6 MB (27%)` and a fill bar instead of a frozen UI while a multi-megabyte `.mov` is in flight. Implementation switches from `fetch()` (which can't report upload progress) to `XMLHttpRequest` via a new `uploadAssetWithProgress(file, type, label)` helper. No backend changes — `/api/upload-asset` keeps the same multipart contract.

## [1.0.31] - 2026-05-05

### Added
- Three-mode LLM setting in Settings → Generation. Replaces the old Manual Mode checkbox with a 3-way radio: **API** (every step runs automatically via the LLM), **Hybrid** (per-step "AI or manual?" popup), and **Manual** (existing paste-from-claude.ai flow). Hybrid is the new default for fresh installs. Existing users with `manualMode: true` migrate to **Manual**; existing users with `manualMode: false` migrate to **API**. Settings round-trip via `mode` field in `auth.json`; legacy `manualMode` boolean is still accepted on POST for old clients but always replaced by `mode` on save.
- Hybrid-mode choice modal. When an LLM step kicks off in hybrid mode, a popup asks "Use AI" or "Fill manually" before any API call is made. The choice is per-step, not per-LLM-call, so a `generate` run that would normally hit the API 5+ times is one decision instead of five popups. Wired into `analyze`, `generate`, `compose`, `generate-title`, `analyze-clips`, and the AI feedback/revision endpoint. Choice resolved via `POST /api/llm-step-decision` with a server-side timeout of 5 minutes (defaults to manual). The auto-titling flow that runs after transcription also goes through the same choice gate, so users no longer have an LLM call fired silently in the background.
- Per-step manual paths. When the user picks "Fill manually" at the choice modal: `generate` writes empty caption / YouTube description / announcement placeholders to `content.json` for every reel from `analysis.json`, and the existing reel-ui textareas surface as ready-to-fill — this is the path the user explicitly asked for ("give me an option to generate caption manually if I don't want to rely on the one made"). `generate-title` opens a text input modal for typing the slug-style title yourself. `analyze` writes a minimal `analysis.json` and points the user to "Find & Create Reel" on the transcript for manual reel picking. `analyze-clips` and `compose` skip with informative toasts. AI feedback/revision becomes a no-op so the user can edit the textarea directly. New module: `server/manual-steps.js` holds the placeholder writers; new modals: `#llm-choice-modal` and `#llm-title-modal` in `index.html`; new client functions in `public/js/state.js`.

### Changed
- Top-level **Manual** mode is fully preserved — `askLlmModeChoice` returns `"ai"` for both `auto` and `manual` modes, so the existing paste-from-claude.ai flow (driven by `llm.chat()` returning `null` when there's no key) still kicks in for users who have been relying on it. Only `hybrid` mode triggers the new choice popup. This avoids regressing the existing user-base that has been using Manual Mode to paste from their own Claude.

## [1.0.30] - 2026-05-05

### Added
- Already-finished reel uploads (`reel_full` media type) now expose an **Add Overlay** action with the same ⚙ Customize panel as the post-cut reel detail view. Previously the entire pipeline strip was hidden for `reel_full`, so there was no way to apply sponsor/logo/lower-third/CTA overlays to a reel uploaded as a finished file even though `overlay.js` already handles that case (`overlay.js:287-293`) and the backend explicitly allows the step (`server/routes/pipeline-routes.js:22-25`). Once an overlay has been applied the button flips to a green ✓ Overlay and re-clicking re-runs with `--force` so the user can iterate on the overlay config without re-uploading. The original upload stays untouched as the raw video; output is written to `full-final.mp4`.

### Fixed
- The standalone overlay-config customize panel was loading `type=subtitled` as the canvas background video, which 404'd for fresh `reel_full` uploads (no `full-subtitled.mp4` exists) and left the customize canvas blank. The frontend now falls back to `type=raw` when `ep.steps.subtitled` is false, so the live drag-and-drop preview renders against the actual uploaded video.

## [1.0.29] - 2026-05-04

### Fixed
- LLM responses that inline reasoning as `<think>…</think>` inside the content field (Haimaker / MiniMax models do this when not using the separate `reasoning_content` field) now have the think block stripped before text is returned to callers. The captured reasoning is moved into the existing `reasoning` return field so debugging stays clean. Previously the raw `<think>…</think>` block leaked through to whatever consumed the response — most visibly into reel caption text shown in the UI. Fixed centrally in `llm.js` so every caller benefits, not just the caption path.

## [1.0.28] - 2026-05-01

### Added
- yt-dlp now reads YouTube cookies from `$TAJARIB_CONFIG_DIR/yt-cookies.txt` (default `/data/config/yt-cookies.txt` in the container, persisted across rebuilds via the existing `/opt/tajarib-data` volume mount). YouTube blocks datacenter IPs with a "Sign in to confirm you're not a bot" gate, so the previous v1.0.26 download fix worked from a residential laptop but still failed instantly from the VPS. With a Netscape-format cookies file from a logged-in YouTube session in place, both video downloads (`/api/download-url`) and YouTube transcript fetches authenticate and bypass the gate. The file is optional — if it's not present, yt-dlp runs cookieless as before, which keeps local dev and dev-without-cookies setups working unchanged. Implementation: `server/global-config.js` exports `getYtdlpCookieArgs()` which returns `["--cookies", path]` when the file exists or `[]` when it doesn't, and both yt-dlp call sites spread it into their args array.

## [1.0.27] - 2026-05-01

### Added
- Interrupted chunked uploads now appear in a dedicated sidebar section between the upload progress bar and the episode list. Each one shows the filename, percentage complete, chunk count, an amber progress bar, and two buttons. **Resume** opens a file picker — re-pick the same file (matched by name + size) and the existing chunked-upload path picks up exactly where it left off, only sending the missing chunks. **Delete** confirms, then removes the server-side chunk directory and state entry, and clears any matching localStorage fingerprint so the dead upload doesn't try to resume on next pick. The list is owner-scoped (when profiles are enabled, you only see your own uploads, and you can't cancel someone else's), refreshes on init, after every chunked upload completes, and on every socket `status-update`. Uploads currently transferring in this tab are filtered out so they don't show up as "interrupted." Backed by two new endpoints — `GET /api/uploads-pending` and `POST /api/upload-cancel` — and a new `_activeChunkedUploadIds` set in the client that tracks in-flight uploads via a `try/finally` around the chunk loop.

### Changed
- Re-picking a file that has an in-progress chunked upload now pre-fills the upload modal with the slug, guest, role, media type, and transcription method that were entered the first time. Previously the modal opened blank and you had to type everything again, even though the saved metadata was sitting on the server and would be overwritten on finalize anyway. The modal title now flips to "🔄 Resume Upload (XX% done)" and the button reads "Resume Upload" so it's clear you're continuing rather than starting fresh. Empty/AI-generated slugs stay empty (no `temp-…` placeholder leaks into the slug field). If the saved guest is no longer in the dropdown, it falls back to the free-text input. A `pendingFile !== file` guard prevents stale pre-fills if you pick a different file before the status check resolves. Powered by extending `/api/upload-status` to return the saved metadata fields and `chunkSize` (the latter so cross-tab/cross-device resume works without depending on a stale localStorage value).

## [1.0.26] - 2026-05-01

### Fixed
- YouTube downloads in **Add from URL** were failing or silently falling back to a lower-quality stream on many videos. The yt-dlp format string required `bestvideo[ext=mp4]+bestaudio[ext=m4a]`, but YouTube's 1080p tracks usually ship as webm/vp9 + opus, so no matching mp4/m4a pair existed and yt-dlp would either fail or drop to the `best[ext=mp4]/best` fallback (typically 360p or 720p). Format selector relaxed to `bestvideo[height<=1080]+bestaudio/best` (matches what works in a manual yt-dlp call); `--merge-output-format mp4` already remuxes the result, so the final file on disk is still mp4.
- yt-dlp itself was being installed from Debian's apt repo in the Dockerfile, which lags upstream by months. YouTube changes its player code regularly, so apt's yt-dlp routinely breaks downloads until a backport ships. Moved to `pip3 install yt-dlp` alongside the existing `faster-whisper` line — pip pulls the current PyPI release, which tracks YouTube changes within days. Requires a container rebuild on the VPS to take effect.

## [1.0.25] - 2026-05-01

### Changed
- Low-quality reel previews are now pre-generated during the pipeline instead of waiting for the first LD-toggle click. After every reel-building step that produces a video file (`cut`, `crop`, `subtitle`, `overlay`) finishes with exit 0, the server fires a fire-and-forget ffmpeg transcode for the file that step just produced (e.g., `reel-001-final.mp4` → `reel-001-final.low.mp4`). By the time the user toggles 📶 LD, the cached low version is usually ready — no fallback to full-quality, no delay. The transcoder helper was extracted from `server/routes/media-routes.js` into a shared `server/low-quality.js` module so both the on-demand path (`/api/video?q=low`) and the proactive pipeline hook share the same in-flight Set, atomic `.tmp` → rename behavior, and 720p / CRF 28 / AAC 96k settings.

## [1.0.24] - 2026-05-01

### Changed
- The single **Save & Re-sub** button in the Reel Transcript editor splits into two: **Save** (writes chunk edits to `reel-XX-chunks.json`) and **Re-sub** (re-burns the subtitle file from saved chunks). Previously every text tweak forced a full ffmpeg re-burn, which made small proofreading passes feel heavy. Now you can correct ten chunks in a row with cheap saves and only re-burn once at the end.

### Added
- Autosave in the Reel Transcript editor. Every 10 s, if any chunk has unsaved edits (`.tm-text.edited`), the editor writes the chunks JSON in the background. Re-sub never runs automatically — only when you click the button. Guarded against overlapping saves so concurrent autosave + manual save can't trample each other.

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
