#!/usr/bin/env bash
# Tajarib VPS installer — interactive bootstrap.
# Tested on Debian 12 / Ubuntu 22.04 / Ubuntu 24.04. Run as root or with sudo.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jameelamir/tajarib-content.git}"
APP_DIR="${APP_DIR:-/opt/tajarib}"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ask() { read -r -p "$1: " "$2" </dev/tty; }
ask_secret() { read -r -s -p "$1: " "$2" </dev/tty; echo; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo." >&2
    exit 1
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    say "Docker already installed"
    return
  fi
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

clone_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    say "Repo already at $APP_DIR — pulling latest"
    git -C "$APP_DIR" fetch --all --prune
    git -C "$APP_DIR" reset --hard "origin/${BRANCH:-main}"
  else
    say "Cloning $REPO_URL into $APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
  fi
}

write_env() {
  local env_file="$APP_DIR/.env"
  if [ -f "$env_file" ] && [ "${OVERWRITE_ENV:-0}" != "1" ]; then
    say "$env_file already exists — leaving it alone (set OVERWRITE_ENV=1 to replace)"
    return
  fi
  say "Configuring .env"
  ask_secret "GROQ_API_KEY"      GROQ
  ask_secret "LLM_API_KEY (Anthropic / Haimaker)" LLMK
  local SECRET
  SECRET=$(openssl rand -hex 32)
  ask "Webhook port [9000]" WPORT; WPORT=${WPORT:-9000}
  ask "App host port [7430]"  APORT; APORT=${APORT:-7430}
  ask "Deploy branch [main]"  BR;    BR=${BR:-main}

  cat > "$env_file" <<EOF
GROQ_API_KEY=$GROQ
LLM_API_KEY=$LLMK
WEBHOOK_SECRET=$SECRET
WEBHOOK_BRANCH=$BR
HOST_PORT=$APORT
WEBHOOK_PORT=$WPORT
EOF
  chmod 600 "$env_file"
  echo
  echo "Webhook secret (paste into GitHub repo → Settings → Webhooks → Secret):"
  echo "$SECRET"
}

setup_profiles() {
  local pf="$APP_DIR/config/profiles.json"
  mkdir -p "$APP_DIR/config" "$APP_DIR/config/tajarib" "$APP_DIR/episodes" "$APP_DIR/uploads"
  if [ -f "$pf" ]; then
    say "profiles.json already exists at $pf"
    return
  fi
  ask "Enable multi-user view filter? (y/N)" MU
  if [ "${MU:-N}" = "y" ] || [ "${MU:-N}" = "Y" ]; then
    ask "Comma-separated profile names (e.g. jameel,editor)" NAMES
    local json="["
    local first=1
    IFS=',' read -ra ARR <<<"$NAMES"
    for n in "${ARR[@]}"; do
      n=$(echo "$n" | xargs)
      [ -z "$n" ] && continue
      [ $first -eq 0 ] && json+=", "
      json+="\"$n\""
      first=0
    done
    json+="]"
    echo "{\"profiles\": $json}" > "$pf"
    say "Wrote $pf"
  fi
}

start_stack() {
  say "Building and starting containers (this may take a while on first run)"
  cd "$APP_DIR"
  docker compose up -d --build
}

print_summary() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")
  source "$APP_DIR/.env"
  cat <<EOF

────────────────────────────────────────────────
✅ Tajarib is up.

  Dashboard:    http://$ip:${HOST_PORT:-7430}
  Webhook URL:  http://$ip:${WEBHOOK_PORT:-9000}/webhook

Next steps:
  1. Point a domain at this server and proxy ${HOST_PORT:-7430} (caddy/nginx + TLS).
  2. In GitHub → repo → Settings → Webhooks → Add webhook:
       Payload URL:  http://<your-domain>/webhook   (or http://$ip:${WEBHOOK_PORT:-9000}/webhook)
       Content type: application/json
       Secret:       (already printed above)
       Events:       Just the push event.
  3. Push to ${WEBHOOK_BRANCH:-main} → the VPS auto-pulls and rebuilds.

Logs:   docker compose logs -f app
        docker compose logs -f webhook
────────────────────────────────────────────────
EOF
}

main() {
  require_root
  install_docker
  clone_repo
  write_env
  setup_profiles
  start_stack
  print_summary
}

main "$@"
