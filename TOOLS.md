# TOOLS.md - Local Notes

## Quick Commands

- `qmd search "query"` — search workspace notes
- Check `formats/` before writing any content

## Guest Research with Exa (Power Tool)

Exa is an AI search engine perfect for deep guest research. Use it for comprehensive background on guests and companies.

### Key Tools

**People Search** — find guest profiles, work history, education:
```bash
~/.openclaw/workspace/skills/exa-search/scripts/exa.sh people_search_exa query="CEO of [Company]" numResults:3
```

**Company Research** — company overview, news, key people:
```bash
~/.openclaw/workspace/skills/exa-search/scripts/exa.sh company_research_exa companyName="[Company Name]" numResults:3
```

**Web Search** — general research, recent news:
```bash
~/.openclaw/workspace/skills/exa-search/scripts/exa.sh web_search_exa query="[guest name] interview 2024" numResults:5
```

**Deep Research** — comprehensive multi-source analysis (15s-3min):
```bash
# Start research
~/.openclaw/workspace/skills/exa-search/scripts/exa.sh deep_researcher_start instructions="Research [guest name] background, current role, key achievements, recent interviews"
# Then poll with researchId until status=completed
```

### Research Workflow for Guests

1. **People search** for LinkedIn/profiles → work history, education, career path
2. **Company research** if they lead/own a company
3. **Web search** for recent interviews, articles, news
4. **Deep research** for comprehensive briefing document

### What Exa Returns

- Full work history with dates and titles
- Education background
- Company details (size, founded, industry)
- Recent news and mentions
- Links to profiles, articles, interviews

### Example Use Cases

- "Research Muhannad Al-Saffar from Siemens Energy" → people search + company research
- "Find recent Ahmed Al-Kinani interviews" → web search with category=news
- "Deep dive on Asiacell leadership changes" → deep researcher

Always synthesize Exa results into Tajarib-style talking points and context.

## Content Types

| Type | Location | Spec File |
|------|----------|-----------|
| Reel captions | episodes/{slug}/content/reel-caption-draft-v{N}.md | formats/reel-caption.md |
| YouTube desc | episodes/{slug}/content/yt-description-draft-v{N}.md | formats/youtube-description.md |
| Titles | episodes/{slug}/content/titles-draft-v{N}.md | (inline in request) |

## Language Reminders

- وية not ويا
- No چ
- تكدرون not شوفوا
- Frame guest opinions: "يرى..." / "بحسب..."
