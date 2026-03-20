const { findSegmentByText, formatTimestamp } = require("../utils");
const { resolveTimestamps } = require("../analyze");

// Sample transcript segments (realistic Arabic podcast data)
const segments = [
  { start: 0, end: 5.2, text: "بسم الله الرحمن الرحيم" },
  { start: 5.2, end: 12.8, text: "أهلاً وسهلاً بكم في حلقة جديدة من بودكاست تجارب" },
  { start: 12.8, end: 20.1, text: "اليوم عندنا ضيف مميز جداً" },
  { start: 20.1, end: 28.5, text: "راح نتكلم عن تجربته في ريادة الأعمال" },
  { start: 28.5, end: 35.0, text: "وكيف بدأ مشروعه من الصفر" },
  { start: 35.0, end: 42.3, text: "خلونا نبدأ بالسؤال الأول" },
  { start: 42.3, end: 50.0, text: "كيف كانت البداية وما هي التحديات" },
  { start: 50.0, end: 58.7, text: "التحديات كانت كثيرة بصراحة" },
  { start: 58.7, end: 65.0, text: "أول شي واجهته هو التمويل" },
  { start: 65.0, end: 72.4, text: "ما كان عندي أي خبرة في هذا المجال" },
];

describe("findSegmentByText", () => {
  test("exact match returns segment start time", () => {
    const result = findSegmentByText(segments, "بسم الله الرحمن الرحيم");
    expect(result).toBe(0);
  });

  test("partial match within a segment", () => {
    const result = findSegmentByText(segments, "حلقة جديدة من بودكاست تجارب");
    expect(result).toBe(5.2);
  });

  test("match across two consecutive segments (sliding window)", () => {
    const result = findSegmentByText(segments, "ضيف مميز جداً راح نتكلم عن تجربته");
    expect(result).toBe(12.8);
  });

  test("returns null for completely unrelated text", () => {
    const result = findSegmentByText(segments, "this text does not appear anywhere");
    expect(result).toBeNull();
  });

  test("returns null for empty excerpt", () => {
    expect(findSegmentByText(segments, "")).toBeNull();
    expect(findSegmentByText(segments, null)).toBeNull();
  });

  test("returns null for empty segments array", () => {
    expect(findSegmentByText([], "some text")).toBeNull();
  });

  test("fuzzy match via word overlap scoring", () => {
    // Partial overlap — enough words to pass 0.3 threshold
    const result = findSegmentByText(segments, "التحديات كانت كثيرة");
    expect(result).toBe(50.0);
  });

  test("handles extra whitespace in excerpt", () => {
    const result = findSegmentByText(segments, "  بسم  الله   الرحمن  الرحيم  ");
    expect(result).toBe(0);
  });
});

describe("formatTimestamp", () => {
  test("formats seconds as MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(65)).toBe("01:05");
    expect(formatTimestamp(3599)).toBe("59:59");
  });

  test("handles fractional seconds by flooring", () => {
    expect(formatTimestamp(5.2)).toBe("00:05");
    expect(formatTimestamp(72.9)).toBe("01:12");
  });

  test("pads single-digit values", () => {
    expect(formatTimestamp(9)).toBe("00:09");
    expect(formatTimestamp(60)).toBe("01:00");
  });
});

describe("resolveTimestamps", () => {
  test("resolves text_start/text_end to MM:SS timestamps on cuts", () => {
    const analysis = {
      cuts: [
        { text_start: "بسم الله الرحمن الرحيم", text_end: "ضيف مميز جداً" },
      ],
    };

    resolveTimestamps(analysis, segments);

    expect(analysis.cuts[0].start).toBe("00:00");
    expect(analysis.cuts[0].end).toBe("00:12");
    expect(analysis.cuts[0].text_start).toBeUndefined();
    expect(analysis.cuts[0].text_end).toBeUndefined();
  });

  test("resolves reels the same way as cuts", () => {
    const analysis = {
      reels: [
        { id: 1, text_start: "خلونا نبدأ بالسؤال الأول", text_end: "أول شي واجهته هو التمويل" },
      ],
    };

    resolveTimestamps(analysis, segments);

    expect(analysis.reels[0].start).toBe("00:35");
    expect(analysis.reels[0].end).toBe("00:58");
  });

  test("resolves chapters (only text_start)", () => {
    const analysis = {
      chapters: [
        { text_start: "التحديات كانت كثيرة بصراحة", title: "التحديات" },
      ],
    };

    resolveTimestamps(analysis, segments);

    expect(analysis.chapters[0].start).toBe("00:50");
  });

  test("drops cuts/reels/chapters where matching fails", () => {
    const analysis = {
      cuts: [
        { text_start: "nonexistent text", text_end: "also nonexistent" },
        { text_start: "بسم الله الرحمن الرحيم", text_end: "ضيف مميز جداً" },
      ],
      reels: [
        { id: 1, text_start: "does not exist anywhere", text_end: "nope" },
      ],
      chapters: [
        { text_start: "missing chapter text" },
      ],
    };

    resolveTimestamps(analysis, segments);

    expect(analysis.cuts).toHaveLength(1);
    expect(analysis.reels).toHaveLength(0);
    expect(analysis.chapters).toHaveLength(0);
  });

  test("preserves existing start/end if no text refs", () => {
    const analysis = {
      cuts: [{ start: "01:00", end: "02:00" }],
    };

    resolveTimestamps(analysis, segments);

    expect(analysis.cuts[0].start).toBe("01:00");
    expect(analysis.cuts[0].end).toBe("02:00");
  });

  test("handles missing sections gracefully", () => {
    const analysis = {};
    expect(() => resolveTimestamps(analysis, segments)).not.toThrow();
    expect(analysis.cuts).toBeUndefined();
  });
});
