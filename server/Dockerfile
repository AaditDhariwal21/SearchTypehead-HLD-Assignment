# Backend image: Node + Express + better-sqlite3 + ioredis.
#
# BASE IMAGE CHOICE — node:22-bookworm-slim (Debian, glibc):
#   better-sqlite3 ships a NATIVE binding. We deliberately do NOT use an Alpine
#   image: Alpine uses musl libc, for which better-sqlite3 has no prebuilt binary,
#   so it would fall back to compiling from source (needing python3/make/g++).
#   On Debian/glibc + Node 22 on linux-x64, `npm install` downloads a PREBUILT
#   binary — no compiler, no build tools, fast and reliable. "slim" keeps the
#   image small while still being glibc-based.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first, as their own layer, so they're only re-installed
# when package files change (not on every source edit). node_modules is built
# HERE, inside Linux, so the better-sqlite3 binary matches the container — this
# is why we must NOT let the host's (Windows) node_modules leak in (see the
# .dockerignore, and the anonymous volume in docker-compose.yml for dev).
COPY package*.json ./
RUN npm install

# Copy the rest of the source. In dev this is overlaid by a bind mount, but
# baking it in keeps the image runnable on its own too.
COPY . .

EXPOSE 3001

# Dev command uses nodemon in polling mode (--legacy-watch). WHY polling: Docker
# Desktop on Windows does not forward filesystem change events across a bind
# mount, so ordinary inotify-based watching wouldn't pick up your local edits.
CMD ["npm", "run", "dev:docker"]
