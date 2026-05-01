FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PORT=7430

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      git \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir faster-whisper requests yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Register bundled fonts with fontconfig so libass (ASS subtitle filter) can
# resolve "SomarSans-Bold" by name when burning subtitles.
RUN mkdir -p /usr/share/fonts/opentype/somar \
    && cp /app/fonts/*.otf /usr/share/fonts/opentype/somar/ \
    && fc-cache -f

ARG GIT_SHA=dev
ARG BUILD_TIME=dev
RUN printf '{"sha":"%s","builtAt":"%s"}\n' "$GIT_SHA" "$BUILD_TIME" > /app/.version.json

EXPOSE 7430

CMD ["node", "dashboard.js"]
