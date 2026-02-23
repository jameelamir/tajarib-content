# Tajarib Pipeline

Podcast production dashboard for the Tajarib podcast.

## Features

- **Upload & Process**: Full episodes or pre-cut reels
- **AI Pipeline**: Transcribe → Analyze → Generate → Cut → Subtitle
- **Content Editor**: Edit captions, descriptions with AI feedback
- **Mobile Ready**: Works on desktop, tablet, and phone
- **Zapier Integration**: One-click publish to social media

## Quick Start

```bash
npm install
node dashboard.js
```

Dashboard runs at `http://localhost:7430`

## File Structure

```
├── dashboard.js          # Main server
├── index.html            # Dashboard UI
├── public/               # Static assets
├── episodes/             # Episode data (gitignored)
├── uploads/              # Upload temp (gitignored)
├── *.js                  # Pipeline scripts
└── formats/              # Prompt templates
```

## Version History

| Version | Date | Notes |
|---------|------|-------|
| v7 | 2025-02-23 | Mobile responsive + Publish button |
| v6 | 2025-02-21 | Episode & Reel workflows |
| v5 | 2025-02-21 | Buffer integration |
| v1 | 2025-02-21 | Initial production pipeline |

## License

Private — Tajarib Podcast
