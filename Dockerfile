FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PORT=7430

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      yt-dlp \
      git \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir faster-whisper requests

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 7430

CMD ["node", "dashboard.js"]
