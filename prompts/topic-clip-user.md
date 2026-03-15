I have a podcast transcript and I want to extract a clip about: "{{topic}}"

Transcript:
{{transcriptText}}

Find the most relevant continuous segment (30-90 seconds) that discusses "{{topic}}".
Return ONLY a JSON object with this format:
{
  "start_time": <seconds>,
  "end_time": <seconds>,
  "hook": "<engaging one-sentence hook>",
  "caption": "<arabic caption for social media with emojis and hashtags>"
}

The hook should be attention-grabbing and the caption should be ready for Instagram/TikTok.
