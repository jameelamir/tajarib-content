# Deploy Tajarib to a VPS

This produces a hosted dashboard accessible from any browser, with auto-deploy on push to `main`. The whole stack runs in two Docker containers — app + webhook receiver.

## Requirements

- A VPS running Debian 12 / Ubuntu 22.04+ with root access
- ~10 GB disk for the app image (faster-whisper pulls in PyTorch)
- A domain (optional but recommended for TLS)

## One-shot install

```bash
ssh root@your-vps
curl -fsSL https://raw.githubusercontent.com/jameelamir/tajarib-content/main/scripts/install-vps.sh | bash
```

The installer:
1. Installs Docker + compose plugin
2. Clones the repo to `/opt/tajarib`
3. Prompts for `GROQ_API_KEY`, `LLM_API_KEY`, ports, and whether to enable multi-user view filter
4. Generates a webhook secret
5. Builds and starts both containers
6. Prints the dashboard URL and webhook URL

## After install

### 1. Reverse proxy + TLS (recommended)

Point a domain at the VPS and put the dashboard behind Caddy or Nginx. Example Caddyfile:

```
tajarib.example.com {
    reverse_proxy localhost:7430
}

webhook.example.com {
    reverse_proxy localhost:9000
}
```

### 2. Wire up GitHub webhook

In your GitHub repo → **Settings → Webhooks → Add webhook**:

- **Payload URL:** `https://webhook.example.com/webhook`
- **Content type:** `application/json`
- **Secret:** the value the installer printed (also stored in `/opt/tajarib/.env` as `WEBHOOK_SECRET`)
- **Events:** Just the push event.

Push to `main` → the VPS pulls and rebuilds automatically.

## Manual deploy

If you skip the webhook, you can deploy manually:

```bash
cd /opt/tajarib
git pull
docker compose up -d --build
```

## Multi-user view filter

To enable the Mine/Theirs/All view filter (no auth, just scoping), drop a `config/profiles.json` into the repo on the VPS:

```bash
cat > /opt/tajarib/config/profiles.json <<'EOF'
{ "profiles": ["jameel", "editor"] }
EOF
docker compose restart app
```

To disable it, remove the file.

## Logs and management

```bash
cd /opt/tajarib
docker compose logs -f app
docker compose logs -f webhook
docker compose restart app
docker compose down
```

## File layout

Everything stateful lives under `/opt/tajarib/`:

```
/opt/tajarib/
├── episodes/        # Source videos, transcripts, reels (mounted into app container)
├── uploads/         # Temp upload chunks
├── config/
│   ├── profiles.json  # Optional multi-user config
│   └── tajarib/       # API keys (mirrors ~/.tajarib inside container)
├── .env             # Secrets and ports
└── ... (repo files)
```

Volumes survive `docker compose down`. To wipe state, remove the dirs above.
