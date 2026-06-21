# Running the backend + Redis with Docker

The Vite **frontend stays on your laptop** (`cd client && npm run dev`). Docker
runs only the **backend + 3 Redis cache nodes**.

## 1. Install Docker Desktop (Windows 11)

1. Download: <https://www.docker.com/products/docker-desktop/>
   (direct installer: <https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe>)
2. Run the installer; keep **"Use WSL 2 instead of Hyper-V"** checked (default).
3. Reboot if asked. Launch **Docker Desktop** and wait until the whale icon in the
   system tray is steady (not animating) — that means the engine is running.
4. Verify in a terminal:
   ```bash
   docker --version
   docker compose version
   ```
   Both should print a version. (`docker compose`, two words — the modern v2 CLI.)

## 2. Commands

Run these from the repo root (the folder with `docker-compose.yml`).

| Command | What it does |
|---|---|
| `docker compose up --build` | Builds the backend image and starts backend + 3 Redis. Use `--build` after code/dependency or Dockerfile changes. Add `-d` to run detached (in the background). |
| `docker compose up` | Same, but reuses the existing backend image (faster; no rebuild). |
| `docker compose down` | Stops and removes the containers and the network. Your SQLite DB survives (it lives on disk via the bind mount). |
| `docker compose ps` | Lists the containers and their health status. |
| `docker compose logs -f backend` | Follows the backend logs (Ctrl-C to stop following). |
| `docker compose exec backend npm run seed` | Seeds the DB **inside** the container (do this once after the first `up`; needs the ORCAS file at `server/data/orcas.tsv.gz` — see README "Dataset"). |
| `docker compose restart backend` | Restarts just the backend. |

**First-time sequence:**
```bash
# 1. download ORCAS to server/data/orcas.tsv.gz (see README "Dataset")
docker compose up --build -d          # start everything in the background
docker compose exec backend npm run seed   # load the dataset
cd client && npm run dev              # start the frontend on your laptop
```
Then open the Vite URL. The frontend's existing proxy points at `localhost:3001`,
which is the backend's published port — no frontend change needed.

## 3. How to tell it's working

- **`docker compose ps`** — all four services `running`; the three redis show
  `healthy` (the healthcheck runs `redis-cli ping`).
- **`docker compose logs backend`** should contain, near the top:
  ```
  [cache] redis node-0 connected (redis-node-0:6379)
  [cache] redis node-1 connected (redis-node-1:6379)
  [cache] redis node-2 connected (redis-node-2:6379)
  [server] listening on http://localhost:3001
  ```
  Three `connected` lines (NOT `UNREACHABLE`) = the backend reached all nodes.
- **Hit a route:** `curl "http://localhost:3001/suggest?q=you"` twice — the logs
  show `MISS` then `HIT`, and `[hash-ring] route ...` lines.
- **Check Redis directly:**
  ```bash
  docker compose exec redis-node-0 redis-cli ping          # -> PONG
  docker compose exec redis-node-0 redis-cli keys '*'      # -> cached keys like "basic:you"
  ```
- **`curl http://localhost:3001/metrics`** — `cache.overall.hitRate` rises as you
  re-query, and `cache.overall.errors` stays `0` when all nodes are up.

## 4. If a container fails to start — where to look first

1. **`docker compose ps`** — which service is not `running`/`healthy`?
2. **`docker compose logs <service>`** (e.g. `docker compose logs backend`) — the
   error is almost always in the last 20 lines.
3. **Common causes:**
   - **Port already in use** (`bind: address already in use`): something on your
     laptop is using 3001 / 6379 / 6380 / 6381. Stop it, or change the left side
     of the `"3001:3001"` mappings in `docker-compose.yml`.
   - **Backend logs `UNREACHABLE` for redis:** the backend started before Redis
     was ready. `depends_on: condition: service_healthy` should prevent this;
     if it persists, `docker compose restart backend`.
   - **`better-sqlite3` / "invalid ELF header" / native binding error:** the
     host's `node_modules` leaked into the container. Rebuild clean:
     ```bash
     docker compose down
     docker compose up --build
     ```
     (The `.dockerignore` + the anonymous `/app/node_modules` volume exist to
     prevent exactly this — a clean rebuild resets the volume.)
   - **Edits not picked up:** the dev command uses `nodemon --legacy-watch`
     (polling) because Docker Desktop on Windows doesn't forward file events over
     bind mounts. If it still misses changes, `docker compose restart backend`.
   - **Docker engine not running:** "cannot connect to the Docker daemon" — open
     Docker Desktop and wait for the whale icon to settle.
