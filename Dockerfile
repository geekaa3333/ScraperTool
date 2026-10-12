# Scraper Tool — production image
#
# Two things drive the base image choice:
#   1. Playwright needs a specific Chromium build plus a pile of shared
#      libraries. Installing those by hand is the usual source of "works on my
#      machine" scraper failures.
#   2. `mcr.microsoft.com/playwright` already contains the browser AND the
#      matching OS libraries, pinned to the Playwright version in package.json.
#      Pinning matters: a Chromium from a different build than the driver
#      expects fails at launch, not at install.
#
# The image is deliberately large. A scraper image is shipped once to a host
# and then runs for weeks; size costs disk once, whereas a missing shared library
# costs uptime.

FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# `node` already exists in this base image; `ubuntu` is used for extra tooling.
USER root

# Tini reaps orphaned child processes. Without an init, Chromium and its
# renderer processes can survive a crash as zombies and slowly exhaust memory —
# a real problem for a process that stays up for days.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall the world.
# better-sqlite3 ships prebuilds for this platform; if one is missing the
# build falls back to node-gyp, which needs python3 + make + g++.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts=false || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build

# Run unprivileged. A web service has no reason to be root.
RUN useradd -m -u 10001 scraper \
 && mkdir -p /app/data \
 && chown -R scraper:scraper /app
USER scraper

# Bind on all interfaces inside the container so the platform's router can
# reach it. The process is still protected by the platform's auth layer.
ENV HOST=0.0.0.0 \
    PORT=4310 \
    NODE_ENV=production \
    SELLERCTRL_DB=/app/data/sellerctrl.db

EXPOSE 4310

# Liveness: is the process up. Readiness: can it actually scrape.
# These are deliberately different — a liveness probe that failed on a
# temporary Amazon block would restart a perfectly healthy service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/ready" || exit 1

# tini as PID 1 so signals reach Node and children are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]