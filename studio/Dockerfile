# Ootto Studio container: Node 22, bundled ffmpeg (ffmpeg-static), and yt-dlp for reel links.
# Build:  docker build -t ootto-studio .
# Run:    docker compose up -d   (see docker-compose.yml and docs/DEPLOY.md)
ARG NODE_IMAGE=node:22-bookworm-slim

# yt-dlp downloads reel links (Instagram, TikTok, YouTube Shorts); uploads work without it.
# The official single-file build needs no Python. Rebuild the image to get a newer yt-dlp.
FROM ${NODE_IMAGE} AS ytdlp
ARG TARGETARCH
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /tmp/yt-dlp-amd64
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 /tmp/yt-dlp-arm64
RUN cp "/tmp/yt-dlp-${TARGETARCH:-amd64}" /usr/local/bin/yt-dlp

FROM ${NODE_IMAGE}
COPY --from=ytdlp /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY assets ./assets
COPY scripts/check.mjs ./scripts/check.mjs

# Data (library, rendered reels, saved keys) lives in /data: mount a volume there.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
