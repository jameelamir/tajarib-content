# Changelog

All notable changes to this project will be documented in this file.

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
