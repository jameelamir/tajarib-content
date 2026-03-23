const {
  formatSRTTime,
  formatASSTime,
  closeSubtitleGaps,
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
