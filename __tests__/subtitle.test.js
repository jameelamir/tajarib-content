const {
  formatSRTTime,
  formatASSTime,
  closeSubtitleGaps,
  remapChunksForCuts,
  filterWordsForCuts,
  chunkWords,
  generateSRT,
  generateASS,
  reelWordsFromTranscript,
  MAX_GAP_FILL,
  TITLE_DURATION,
} = require("../subtitle");

describe("formatSRTTime", () => {
  test("formats zero", () => {
    expect(formatSRTTime(0)).toBe("00:00:00,000");
  });

  test("formats seconds with milliseconds", () => {
    expect(formatSRTTime(1.5)).toBe("00:00:01,500");
    expect(formatSRTTime(0.123)).toBe("00:00:00,123");
  });

  test("formats minutes and hours", () => {
    expect(formatSRTTime(65.25)).toBe("00:01:05,250");
    expect(formatSRTTime(3661.1)).toBe("01:01:01,099");
  });

  test("pads all components correctly", () => {
    expect(formatSRTTime(5)).toBe("00:00:05,000");
    expect(formatSRTTime(61)).toBe("00:01:01,000");
  });
});

describe("formatASSTime", () => {
  test("formats zero", () => {
    expect(formatASSTime(0)).toBe("0:00:00.00");
  });

  test("formats with centiseconds (not milliseconds)", () => {
    expect(formatASSTime(1.5)).toBe("0:00:01.50");
    expect(formatASSTime(0.12)).toBe("0:00:00.12");
  });

  test("formats larger values", () => {
    expect(formatASSTime(65.25)).toBe("0:01:05.25");
    expect(formatASSTime(3661.1)).toBe("1:01:01.09");
  });

  test("hours are not zero-padded (ASS convention)", () => {
    expect(formatASSTime(0)).toMatch(/^0:/);
    expect(formatASSTime(7200)).toMatch(/^2:/);
  });
});

describe("closeSubtitleGaps", () => {
  test("closes small gaps by extending earlier chunk", () => {
    const chunks = [
      { start: 0, end: 2, text: "first" },
      { start: 3, end: 5, text: "second" },
    ];
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(3); // gap of 1s was closed
  });

  test("does not close gaps larger than MAX_GAP_FILL", () => {
    const chunks = [
      { start: 0, end: 2, text: "first" },
      { start: 2 + MAX_GAP_FILL + 1, end: 10, text: "second" },
    ];
    const originalEnd = 2;
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(originalEnd);
  });

  test("closes gap exactly at MAX_GAP_FILL threshold", () => {
    const chunks = [
      { start: 0, end: 2, text: "first" },
      { start: 2 + MAX_GAP_FILL, end: 10, text: "second" },
    ];
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(2 + MAX_GAP_FILL);
  });

  test("handles empty array", () => {
    const chunks = [];
    expect(() => closeSubtitleGaps(chunks)).not.toThrow();
  });

  test("handles single chunk", () => {
    const chunks = [{ start: 0, end: 2, text: "only" }];
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(2);
  });

  test("closes multiple consecutive gaps", () => {
    const chunks = [
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b" },
      { start: 4, end: 5, text: "c" },
    ];
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(2);
    expect(chunks[1].end).toBe(4);
  });

  test("does not modify chunks that already overlap or touch", () => {
    const chunks = [
      { start: 0, end: 3, text: "first" },
      { start: 3, end: 5, text: "second" },
    ];
    closeSubtitleGaps(chunks);
    expect(chunks[0].end).toBe(3);
  });
});

describe("generateSRT", () => {
  const sampleWords = [
    { word: "بسم", start: 10.0, end: 10.5 },
    { word: "الله", start: 10.5, end: 11.0 },
    { word: "الرحمن", start: 11.0, end: 11.5 },
    { word: "الرحيم", start: 11.5, end: 12.0 },
    { word: "أهلاً", start: 12.5, end: 13.0 },
    { word: "وسهلاً", start: 13.0, end: 13.5 },
    { word: "بكم", start: 13.5, end: 14.0 },
    { word: "في", start: 14.0, end: 14.3 },
    { word: "حلقة", start: 14.3, end: 14.8 },
    { word: "جديدة", start: 14.8, end: 15.3 },
  ];

  test("generates valid SRT format", () => {
    const srt = generateSRT(sampleWords, 10.0);
    const blocks = srt.trim().split("\n\n");

    // Should have at least one block
    expect(blocks.length).toBeGreaterThan(0);

    // First block should start with entry number 1
    expect(blocks[0]).toMatch(/^1\n/);

    // Each block should follow SRT format: number, timestamps, text
    for (const block of blocks) {
      const lines = block.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toMatch(/^\d+$/); // entry number
      expect(lines[1]).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/); // timestamps
      expect(lines[2].length).toBeGreaterThan(0); // text content
    }
  });

  test("applies startOffset to word timestamps", () => {
    const srt = generateSRT(sampleWords, 10.0);
    // First word starts at 10.0, offset is 10.0, so adjusted start is 0.0
    expect(srt).toContain("00:00:00,000");
  });

  test("skips words before startOffset", () => {
    const srt = generateSRT(sampleWords, 12.0);
    // Words before 12.0 should be skipped
    expect(srt).not.toContain("بسم");
  });

  test("adds title card when provided", () => {
    const srt = generateSRT(sampleWords, 10.0, "عنوان الحلقة");
    // First entry should be the title card
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain("عنوان الحلقة");
    // Title should span TITLE_DURATION seconds
    expect(srt).toContain(`00:00:00,000 --> ${formatSRTTime(TITLE_DURATION)}`);
    // Regular subtitles should start from entry 2
    expect(srt).toContain("\n2\n");
  });

  test("chunks words into groups of ~6 or ~2 seconds", () => {
    const srt = generateSRT(sampleWords, 10.0);
    const blocks = srt.trim().split("\n\n");
    for (const block of blocks) {
      const textLine = block.split("\n")[2];
      const wordCount = textLine.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(7); // allow slight flexibility
    }
  });

  test("handles empty words array", () => {
    const srt = generateSRT([], 0);
    expect(srt.trim()).toBe("");
  });

  test("handles single word", () => {
    const srt = generateSRT([{ word: "مرحباً", start: 0, end: 1 }], 0);
    expect(srt).toContain("مرحباً");
    expect(srt).toMatch(/^1\n/);
  });

  test("preserves Arabic diacritics", () => {
    const words = [
      { word: "بِسْمِ", start: 0, end: 0.5 },
      { word: "اللَّهِ", start: 0.5, end: 1.0 },
      { word: "الرَّحْمَنِ", start: 1.0, end: 1.5 },
    ];
    const srt = generateSRT(words, 0);
    expect(srt).toContain("بِسْمِ");
    expect(srt).toContain("اللَّهِ");
    expect(srt).toContain("الرَّحْمَنِ");
  });
});

describe("generateASS", () => {
  const sampleWords = [
    { word: "كلمة", start: 0, end: 0.5 },
    { word: "أولى", start: 0.5, end: 1.0 },
    { word: "ثم", start: 1.0, end: 1.3 },
    { word: "كلمة", start: 1.3, end: 1.8 },
    { word: "ثانية", start: 1.8, end: 2.3 },
    { word: "وثالثة", start: 2.3, end: 2.8 },
  ];

  test("generates valid ASS format with script info", () => {
    const ass = generateASS(sampleWords, 0, null, { width: 1080, height: 1920 });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("ScriptType: v4.00+");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
  });

  test("animated style produces two layers per subtitle", () => {
    const ass = generateASS(sampleWords, 0, null, { width: 1080, height: 1920 }, "animated");
    const dialogueLines = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
    // Each subtitle chunk gets 2 layers (Highlight, Text) — shadow is handled by ffmpeg gradient
    expect(dialogueLines.length % 2).toBe(0);
    expect(dialogueLines.some(l => l.includes("Highlight,"))).toBe(true);
    expect(dialogueLines.some(l => l.includes("Text,"))).toBe(true);
  });

  test("static style produces single layer per subtitle", () => {
    const ass = generateASS(sampleWords, 0, null, { width: 1080, height: 1920 }, "static");
    const dialogueLines = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
    // Each chunk gets 1 line in static mode
    expect(dialogueLines.length).toBeGreaterThan(0);
    expect(dialogueLines.every(l => l.startsWith("Dialogue: 0,"))).toBe(true);
  });

  test("adds title card entries when provided", () => {
    const ass = generateASS(sampleWords, 0, "عنوان", { width: 1080, height: 1920 }, "animated");
    const dialogueLines = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
    // Title card gets 3 layers too (TitleHighlightGlow, TitleHighlight, TitleText)
    expect(dialogueLines.some(l => l.includes("TitleText"))).toBe(true);
    expect(dialogueLines.some(l => l.includes("عنوان"))).toBe(true);
  });

  test("scales font sizes relative to video dimensions", () => {
    const ass720 = generateASS(sampleWords, 0, null, { width: 720, height: 1280 });
    const ass1080 = generateASS(sampleWords, 0, null, { width: 1080, height: 1920 });
    // 1280/1920 ≈ 0.667 scale factor
    // Default font size 80 * 0.667 ≈ 53
    expect(ass720).toContain("PlayResY: 1280");
    expect(ass1080).toContain("PlayResY: 1920");
  });

  test("defaults to 1080x1920 when no dimensions provided", () => {
    const ass = generateASS(sampleWords, 0);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  test("handles empty words array", () => {
    const ass = generateASS([], 0);
    expect(ass).toContain("[Script Info]");
    // Should have style definitions but no dialogue
    const dialogueLines = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
    expect(dialogueLines.length).toBe(0);
  });
});

describe("constants", () => {
  test("MAX_GAP_FILL is a reasonable value", () => {
    expect(MAX_GAP_FILL).toBeGreaterThan(0);
    expect(MAX_GAP_FILL).toBeLessThanOrEqual(5);
  });

  test("TITLE_DURATION is defined", () => {
    expect(TITLE_DURATION).toBe(5);
  });
});

describe("reelWordsFromTranscript", () => {
  test("returns words array directly when segment word count matches", () => {
    const transcript = {
      segments: [
        {
          start: 0, end: 2,
          text: "hello world",
          words: [
            { word: "hello", start: 0, end: 1 },
            { word: "world", start: 1, end: 2 },
          ],
        },
      ],
    };
    const result = reelWordsFromTranscript(transcript);
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("hello");
    expect(result[1].word).toBe("world");
  });

  test("synthesizes timing for missing first word in segment", () => {
    // Whisper sometimes omits word-level timestamps for the first word of a segment
    const transcript = {
      segments: [
        {
          start: 0, end: 2,
          text: "first second",
          words: [
            // "first" is missing — only "second" has a timestamp
            { word: "second", start: 1.0, end: 2.0 },
          ],
        },
      ],
    };
    const result = reelWordsFromTranscript(transcript);
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("first");
    expect(result[0].start).toBeCloseTo(0, 1);
    expect(result[1].word).toBe("second");
    expect(result[1].start).toBe(1.0);
  });

  test("handles transcript with no segments by returning words array", () => {
    const transcript = {
      words: [{ word: "test", start: 0, end: 1 }],
    };
    const result = reelWordsFromTranscript(transcript);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("test");
  });

  test("handles empty segments array by returning words array", () => {
    const transcript = {
      segments: [],
      words: [{ word: "fallback", start: 0, end: 1 }],
    };
    const result = reelWordsFromTranscript(transcript);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("fallback");
  });
});

describe("chunkWords", () => {
  test("groups words into chunks respecting 6-word limit", () => {
    const words = Array.from({ length: 10 }, (_, i) => ({
      word: `w${i}`, start: i * 0.3, end: (i + 1) * 0.3,
    }));
    const chunks = chunkWords(words, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.split(" ").length).toBeLessThanOrEqual(6);
    }
  });

  test("breaks at sentence-ending punctuation", () => {
    const words = [
      { word: "hello.", start: 0, end: 0.5 },
      { word: "world", start: 0.5, end: 1.0 },
    ];
    const chunks = chunkWords(words, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("hello.");
    expect(chunks[1].text).toBe("world");
  });

  test("applies startOffset to adjust timestamps", () => {
    const words = [
      { word: "test", start: 10, end: 10.5 },
      { word: "word", start: 10.5, end: 11 },
    ];
    const chunks = chunkWords(words, 10);
    expect(chunks[0].start).toBeCloseTo(0);
  });

  test("skips words before startOffset", () => {
    const words = [
      { word: "skip", start: 5, end: 5.5 },
      { word: "keep", start: 10, end: 10.5 },
    ];
    const chunks = chunkWords(words, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("keep");
  });
});

describe("remapChunksForCuts", () => {
  test("no-op when boundaries and cuts are unchanged", () => {
    const chunks = [
      { text: "hello", start: 0, end: 2 },
      { text: "world", start: 2, end: 4 },
    ];
    const result = remapChunksForCuts(chunks, 60, 120, [], 60, 120, []);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: "hello", start: 0, end: 2 });
    expect(result[1]).toMatchObject({ text: "world", start: 2, end: 4 });
  });

  test("internal cut removes overlapping chunk and shifts later chunks", () => {
    // Reel 60-120s, chunks at 0-20, 20-30, 30-50 (video-relative)
    // Add cut from 80-90 (episode time) = 20-30 (reel-relative)
    const chunks = [
      { text: "before cut", start: 0, end: 20 },
      { text: "in the cut", start: 20, end: 30 },
      { text: "after cut", start: 30, end: 50 },
    ];
    const result = remapChunksForCuts(chunks, 60, 120, [], 60, 120, [{ from: 80, to: 90 }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: "before cut", start: 0, end: 20 });
    // After chunk shifts left by 10s (cut duration)
    expect(result[1].text).toBe("after cut");
    expect(result[1].start).toBeCloseTo(20);
    expect(result[1].end).toBeCloseTo(40);
  });

  test("boundary shrink at start removes early chunks and shifts", () => {
    // Old reel 60-120s, new reel 70-120s (start moved 10s later)
    const chunks = [
      { text: "early", start: 0, end: 8 },
      { text: "kept", start: 12, end: 20 },
    ];
    const result = remapChunksForCuts(chunks, 60, 120, [], 70, 120, []);
    // "early" at episode 60-68 is outside new bounds (starts at 70)
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("kept");
    // Episode time 72-80, new reel starts at 70 → video time 2-10
    expect(result[0].start).toBeCloseTo(2);
    expect(result[0].end).toBeCloseTo(10);
  });

  test("boundary shrink at end removes late chunks", () => {
    const chunks = [
      { text: "kept", start: 0, end: 10 },
      { text: "removed", start: 40, end: 50 },
    ];
    // Old reel 60-120s, new reel 60-105s (end moved 15s earlier)
    const result = remapChunksForCuts(chunks, 60, 120, [], 60, 105, []);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("kept");
  });

  test("chunk spanning a cut boundary is dropped", () => {
    // Chunk from 15-35 spans the cut at 20-30
    const chunks = [
      { text: "spans cut", start: 15, end: 35 },
    ];
    const result = remapChunksForCuts(chunks, 60, 120, [], 60, 120, [{ from: 80, to: 90 }]);
    expect(result).toHaveLength(0);
  });

  test("multiple cuts shift chunks correctly", () => {
    // Two cuts: 80-85 and 95-100 (episode time), reel 60-120
    const chunks = [
      { text: "a", start: 0, end: 15 },   // episode 60-75, before both cuts
      { text: "b", start: 28, end: 33 },   // episode 88-93, between cuts
      { text: "c", start: 42, end: 55 },   // episode 102-115, after both cuts
    ];
    const result = remapChunksForCuts(chunks, 60, 120, [], 60, 120, [{ from: 80, to: 85 }, { from: 95, to: 100 }]);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ text: "a", start: 0, end: 15 });
    // "b" at episode 88-93: 5s cut before it (80-85) → shifts left by 5
    expect(result[1].text).toBe("b");
    expect(result[1].start).toBeCloseTo(23);
    expect(result[1].end).toBeCloseTo(28);
    // "c" at episode 102-115: 10s total cuts before it → shifts left by 10
    expect(result[2].text).toBe("c");
    expect(result[2].start).toBeCloseTo(32);
    expect(result[2].end).toBeCloseTo(45);
  });

  test("returns empty array for empty input", () => {
    expect(remapChunksForCuts([], 0, 60, [], 0, 60, [])).toEqual([]);
    expect(remapChunksForCuts(null, 0, 60, [], 0, 60, [])).toEqual([]);
  });

  test("old cuts are undone before applying new cuts", () => {
    // Old reel had cut 80-90, chunks are already in old-cut timeline
    // Video: [60-80](0-20), [90-120](20-50) — chunk at video 25 = episode 95
    // New: remove old cut, add new cut 100-110
    const chunks = [
      { text: "before", start: 0, end: 15 },  // episode 60-75
      { text: "after", start: 25, end: 40 },   // episode 95-110 (after old cut)
    ];
    const result = remapChunksForCuts(
      chunks,
      60, 120, [{ from: 80, to: 90 }],   // old state
      60, 120, [{ from: 100, to: 110 }]   // new state
    );
    // "before" at episode 60-75: no new cuts before it → stays at 0-15
    expect(result[0]).toMatchObject({ text: "before", start: 0, end: 15 });
    // "after" at episode 95-110: spans the NEW cut (100-110) → dropped
    expect(result).toHaveLength(1);
  });
});

describe("saved chunks merging with extended boundaries", () => {
  test("proofread chunks can be combined with new chunks for extended end", () => {
    // Simulate: proofread chunks cover 0-5s, reel extended to 8s
    const proofreadChunks = [
      { text: "proofread first", start: 0, end: 2 },
      { text: "proofread second", start: 2, end: 5 },
    ];
    // New words from episode transcript for the extended portion
    const newWords = [
      { word: "new", start: 65, end: 65.5 },
      { word: "content", start: 65.5, end: 66.0 },
    ];
    // chunkWords with offset 60 (simulating startSec=60, chunksEnd=5, so words at 60+5=65)
    const newChunks = chunkWords(newWords, 60);
    const merged = [...proofreadChunks, ...newChunks];
    closeSubtitleGaps(merged);

    expect(merged).toHaveLength(3);
    expect(merged[0].text).toBe("proofread first");
    expect(merged[1].text).toBe("proofread second");
    expect(merged[2].text).toBe("new content");
    // Gap between proofread and new should be closed
    expect(merged[1].end).toBe(merged[2].start);
  });

  test("proofread chunks can be combined with new chunks for extended start", () => {
    // Simulate: proofread chunks cover 3-8s, reel extended to start earlier at 0s
    const newWords = [
      { word: "earlier", start: 50, end: 50.5 },
      { word: "words", start: 50.5, end: 51.0 },
    ];
    const proofreadChunks = [
      { text: "proofread content", start: 3, end: 6 },
    ];
    const prependChunks = chunkWords(newWords, 50);
    // Ensure prepended chunks end before proofread start
    if (prependChunks.length) {
      const last = prependChunks[prependChunks.length - 1];
      if (last.end > 3) last.end = 3;
    }
    const merged = [...prependChunks, ...proofreadChunks];
    closeSubtitleGaps(merged);

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("earlier words");
    expect(merged[1].text).toBe("proofread content");
  });
});

describe("filterWordsForCuts", () => {
  it("returns words unchanged when no cuts", () => {
    const words = [
      { start: 100, end: 101, word: "a" },
      { start: 102, end: 103, word: "b" },
    ];
    const result = filterWordsForCuts(words, 100, 110, []);
    expect(result).toEqual(words);
  });

  it("removes words inside cut zone and shifts words after cut", () => {
    // Reel: 100-130, cut 110-115 (5s cut)
    const words = [
      { start: 100, end: 101, word: "before" },
      { start: 112, end: 113, word: "cut-content" },
      { start: 120, end: 121, word: "after" },
    ];
    const result = filterWordsForCuts(words, 100, 130, [{ from: 110, to: 115 }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ start: 100, end: 101, word: "before" }); // unchanged
    expect(result[1]).toEqual({ start: 115, end: 116, word: "after" }); // shifted left by 5s
  });

  it("handles multiple cuts", () => {
    // Reel: 100-150, cuts: 110-115 (5s), 130-135 (5s)
    const words = [
      { start: 100, end: 101, word: "a" },
      { start: 112, end: 113, word: "cut1" },
      { start: 120, end: 121, word: "b" },
      { start: 132, end: 133, word: "cut2" },
      { start: 140, end: 141, word: "c" },
    ];
    const result = filterWordsForCuts(words, 100, 150, [
      { from: 110, to: 115 },
      { from: 130, to: 135 },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ start: 100, end: 101, word: "a" }); // no shift
    expect(result[1]).toEqual({ start: 115, end: 116, word: "b" }); // shift -5
    expect(result[2]).toEqual({ start: 130, end: 131, word: "c" }); // shift -10
  });
});
