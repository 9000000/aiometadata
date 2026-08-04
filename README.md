# ![AIOMETADATA](https://github.com/cedya77/aiometadata/blob/dev/public/logo.png) AIOMetadata: The Ultimate Stremio Metadata Addon

**AIOMetadata** is a next-generation, power-user-focused metadata addon for [Stremio](https://www.stremio.com/). It aggregates and enriches movie, series, and anime metadata from multiple sources (TMDB, TVDB, MyAnimeList, AniList, IMDb, TVmaze, Fanart.tv, MDBList, and more), giving you full control over catalog sources, artwork, and search.

---

## 🚀 Features

- **Multi-Source Metadata**: Choose your preferred provider for each type (movie, series, anime) — TMDB, TVDB, MAL, AniList, IMDb, TVmaze, etc.
- **Rich Artwork**: High-quality posters, backgrounds, and logos from TMDB, TVDB, Fanart.tv, AniList, and more, with language-aware selection and fallback.
- **Anime Power**: Deep anime support with MAL, AniList, Kitsu, AniDB, and TVDB/IMDb mapping, including studio, genre, decade, and schedule catalogs.
- **Custom Catalogs**: Add, reorder, and delete catalogs (including MDBList, streaming, and custom lists) in a sortable UI.
- **Streaming Catalogs**: Integrate streaming provider catalogs (Netflix, Disney+, etc.) with region and monetization filters.
- **Dynamic Search**: Enable/disable search engines per type (movie, series, anime) and use AI-powered search (Gemini) if desired.
- **User Config & Passwords**: Secure, per-user configuration with password and optional addon password protection. Trusted UUIDs for seamless re-login.
- **Global & Self-Healing Caching**: Redis-backed, ETag-aware, and self-healing cache for fast, reliable metadata and catalog responses.
- **Advanced ID Mapping**: Robust mapping between all major ID systems (MAL, TMDB, TVDB, IMDb, AniList, AniDB, Kitsu, TVmaze).
- **Modern UI**: Intuitive React/Next.js configuration interface with drag-and-drop, tooltips, and instant feedback.

---

## 🛠️ Installation

### 1. Hosted Instance

Visit your hosted instance's `/configure` page.  
Configure your catalogs, providers, and preferences.  
Save your config and install the generated Stremio addon URL.

### 2. Self-Hosting (Docker Compose)

```yaml
services:
  aiometadata:
    image: ghcr.io/cedya77/aiometadata:latest
    container_name: aiometadata
    restart: unless-stopped
    ports:
      - "3232:3232"  # Remove this if using Traefik
    # expose:  # Uncomment if using Traefik
    #   - 3232
    init: true
    env_file:
      - .env
    # labels:  # Optional: Remove if not using Traefik
    #   - "traefik.enable=true"
    #   - "traefik.http.routers.aiometadata.rule=Host(`${AIOMETADATA_HOSTNAME?}`)"
    #   - "traefik.http.routers.aiometadata.entrypoints=websecure"
    #   - "traefik.http.routers.aiometadata.tls.certresolver=letsencrypt"
    #   - "traefik.http.routers.aiometadata.middlewares=authelia@docker"
    #   - "traefik.http.services.aiometadata.loadbalancer.server.port=3232"
    #   - "traefik.http.routers.aiometadata.service=aiometadata"
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/data:/app/addon/data
    depends_on:
      aiometadata_redis:
        condition: service_healthy
    tty: true
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3232/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  aiometadata_redis:
    image: redis:latest
    container_name: aiometadata_redis
    restart: unless-stopped
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/cache:/data
    command: redis-server --appendonly yes --save 3600 1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  #aiometadata_postgres:
  #  image: postgres:latest
  #  container_name: aiometadata_postgres
  #  restart: unless-stopped
  #  environment:
  #    - POSTGRES_DB=aiometadata
  #    - POSTGRES_USER=postgres
  #    - POSTGRES_PASSWORD=password
  #  volumes:
  #    - ${DOCKER_DATA_DIR}/aiometadata/postgres:/var/lib/postgresql/data
  #  healthcheck:
  #    test: ["CMD-SHELL", "pg_isready -U postgres -d aiometadata"]
  #    interval: 10s
  #    timeout: 5s
  #    retries: 5
```

Create a `.env` file with your API keys and settings as shown in [.env.example](.env.example) 

Then run:
```bash
docker compose up -d
```

### 3. Image Cache (Optional)

Cache artwork on disk so repeated requests are served locally instead of re-fetched from upstream. Combined with comprehensive cache warming, images load instantly.

#### Option A — Built-in (recommended)

The cache is part of the addon itself — no extra container, port, or volume. Set one variable:

```yaml
  aiometadata:
    # ...your existing service...
    environment:
      - ENABLE_BUILTIN_POSTER_CACHE=true
```

Images are served from `https://your-addon-host/poster-cache/...` and stored under `addon/data/poster-cache`, which is already inside the `/app/addon/data` volume from the compose file above — so the cache survives restarts with no additional mount.

**What gets cached.** Posters and the addon's own rendered images are cached by default. Every other image type is opt-in, so enabling the cache never changes disk usage unexpectedly:

| Variable | Default | Caches |
|----------|---------|--------|
| `POSTER_CACHE_BACKGROUNDS` | `false` | Background artwork — the largest images served, so the biggest bandwidth win |
| `POSTER_CACHE_LANDSCAPE_POSTERS` | `false` | Landscape poster artwork |
| `POSTER_CACHE_LOGOS` | `false` | Logo artwork |
| `POSTER_CACHE_THUMBNAILS` | `false` | Episode thumbnails — by far the most numerous; a long-running series adds hundreds |
| `POSTER_CACHE_PROCESSED_IMAGES` | `true` | Images the addon renders itself: rating-overlaid posters and the blur/resize/banner-to-background transforms, so each one runs once |

These are also toggles in the dashboard's **Settings** tab, and the **Operations** tab shows disk usage broken down by image type, with per-type clear buttons and a **Refresh** box for dropping a single image.

Custom art URLs are passed through unchanged rather than rendered, so they count as the image type they are: a custom logo needs `POSTER_CACHE_LOGOS`, a custom background needs `POSTER_CACHE_BACKGROUNDS`, whether or not the art proxy is on.

**Staleness.** Cached images are validated by a hash of their bytes, so replacing the artwork at a URL your art pattern points to makes clients re-download it rather than keep the old copy. To force it immediately, paste the image URL (or the `/poster-cache/…` URL) into **Refresh** on the Operations tab — no need to clear a whole image type.

**Sizing.** Two budgets, evicted least-recently-used once exceeded:

| Variable | Default | Caps |
|----------|---------|------|
| `POSTER_CACHE_MAX_SIZE` | `10g` | **Disk** used by the cache |
| `POSTER_CACHE_MEMORY_SIZE` | `128m` | **RAM** held for the hottest images, in front of the disk cache. Set to `0` for disk only. |

The memory tier sits on top of the addon's own footprint, so budget roughly `baseline + POSTER_CACHE_MEMORY_SIZE`.

**Smaller TMDB renditions.** The other lever on storage is asking TMDB for less in the first place. TMDB serves `/t/p/original` as the file the uploader supplied — like logos that are frequently lossless PNGs and overly large, far more than any client renders. These work whether or not the image cache is on. The first three are off by default; posters are the exception and are already sized:

| Variable | Default | Requests | Saving |
|----------|---------|----------|--------|
| `PREFER_SMALLER_LOGOS_TMDB` | `false` | Logos at `w500` | ~12× — the safest of the three, since logos are rendered small |
| `PREFER_SMALLER_LANDSCAPE_TMDB` | `false` | Landscape posters at `w780` | ~11.6× — clients draw these as catalog tiles, not full-screen |
| `PREFER_SMALLER_BACKDROPS_TMDB` | `false` | Backgrounds at `w1280` | ~5.1× — the only genuine quality trade; leave it off if backgrounds are rendered full-screen on a 4K display |
| `PREFER_SMALLER_POSTERS_TMDB` | `true` | Posters at `w600_and_h900_bestv2` | Already on — this is the long-standing default. Set it to `false` for `original` posters, which is the most expensive of the four to flip: posters are the highest-volume class, one per catalog tile |

For the first three a sized rendition is only requested when the asset is actually larger than that size. TMDB upscales rather than refusing, so asking for more than an asset has would make it both blurrier and bigger — the addon falls back to `original` in that case. Posters skip that check, since `w600_and_h900_bestv2` is a fixed 600×900 crop and falling back to `original` would change their aspect ratio. Toggling any of these does not rewrite meta already in the cache; those payloads keep their existing URLs until `META_TTL` expires, and the superseded images are reclaimed as they age out.

**Validity.** How long a cached image stays fresh, decided most-specific-first:

| Variable | Default | Sets |
|----------|---------|------|
| `POSTER_CACHE_PROVIDER_POLICIES` | unset | A rule for one provider — `default`, `infer`, a `custom` duration, or `bypass`. Sets how long art is stored, and the `Cache-Control` on art passed through without storing |
| `POSTER_CACHE_PROVIDER_PRESETS` | `true` | Built-in policies, measured per provider, so rating posters stay current out of the box |
| `POSTER_CACHE_INFER_TTL` | `false` | Follows each remaining source's own headers instead of the flat number |
| `POSTER_CACHE_TTL_DAYS` | `30` | The flat fallback. Fractional values work; `0` never expires |

`POSTER_PROXY_MAX_AGE_DAYS` (default `1`) is the matching client-side lifetime, and the ceiling on it for art passed through without storing. `POSTER_CACHE_INACTIVE_DAYS` (default `30`) drops images nobody has requested, and `POSTER_CACHE_DIR` moves the cache elsewhere. Both `POSTER_PROXY_*` settings apply with the built-in cache off, and a per-provider rule overrides them for that provider.

> **Using a rating poster service?** Nothing to do — `api.ratingposterdb.com`, `api.top-posters.com`, `btttr.cc`, `extendedratings.com` and `postersplus.elfhosted.com` each ship a built-in policy following their own headers, which run short while an overlay moves and long once a rating settles.
>
> **Using a custom art URL pattern?** Check the host you pointed it at. Anything the addon does not know has no built-in policy, and such URLs usually name a slot rather than a file — the bytes change while the URL does not, so a stale rating sits there for the full 30 days. Give its domain a rule under **Advanced…** on the dashboard's Image Cache card.

> **Multi-replica / Kubernetes:** each replica keeps its own local cache — independent and unshared, which costs N× storage and N× cold fetches but needs no coordination. Use Option B if you want a single shared cache.

#### Migrating from the old nginx poster cache

Earlier versions ran a bundled nginx proxy on port `8888`. It has been replaced by the built-in cache, so you can drop the `8888` expose/labels and `init: true`, plus any reverse-proxy route pointing at port 8888 (that hostname stops resolving to anything).

**Keep the `/var/cache/nginx` volume for now** — it holds the cache being imported. See the import step below for when it is safe to remove.

> ### ⚠ Breaking change — `POSTER_PROXY_PREFIX_URL`
>
> It used to mean *"the public address of port 8888"*. It now means *"the public URL images are served through"*, which for the built-in cache includes the `/poster-cache` path.
>
> **If you set it explicitly, you must act.** Otherwise images break: requests land on the addon root instead of the cache.
>
> | Before | After |
> |--------|-------|
> | `POSTER_PROXY_PREFIX_URL=https://posters.example.com` | **Unset it** — the built-in cache derives `{HOST_NAME}/poster-cache` automatically |
> | | *or* `POSTER_PROXY_PREFIX_URL=https://your-addon-host/poster-cache` |
>
> Running the standalone nginx proxy (Option B) instead? **Nothing changes** — keep pointing it at your proxy exactly as before.
>
> Image URLs already handed to Stremio clients also change shape, so clients re-fetch each image once. Your cached files are not lost: the disk cache is preserved by the automatic import below.

**Your existing cache is imported automatically.** Leave the `/var/cache/nginx` volume mounted for one start:

```yaml
volumes:
  - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx   # keep for one start, then remove
```

On startup the addon detects the old cache and imports it in the background, so serving is never delayed. You will see:

```
[PosterCacheImport] Found a cache from the previous built-in nginx proxy at
/var/cache/nginx/posters — importing it once so the upgrade does not start cold.
```

Files it cannot parse are skipped, never imported as corrupt entries.

**Let it finish before restarting.** The completion marker is only written at the end, so restarting mid-import starts it over. When it finishes the log tells you directly:

```
[PosterCacheImport] Imported 81133 images from the old nginx cache (2 skipped)
in 257958ms. You can now remove the /var/cache/nginx/posters volume mount.
```

That is a real run: ~9 GB / 81k images took about 4 minutes. You can also check for the marker, which records the counts:

```bash
docker exec <container> cat /app/addon/data/poster-cache/.nginx-import-completed
```

To skip the import entirely, set `POSTER_CACHE_IMPORT_NGINX_DIR=off`. To import from a non-standard path, set it to that path.


#### Option B — Standalone nginx service

For multi-replica deployments that need a single shared cache. Add a `poster-cache` service alongside your aiometadata container and leave `ENABLE_BUILTIN_POSTER_CACHE` off:

```yaml
  poster-cache:
    image: nginx:alpine
    container_name: poster-cache
    restart: unless-stopped
    volumes:
      - ./poster-cache-nginx.conf:/etc/nginx/nginx.conf:ro
      - ./poster-cache-stats.sh:/stats.sh:ro
      - ./poster-cache-purge-handler.sh:/purge-handler.sh:ro
      - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx
    entrypoint: ["/bin/sh", "-c", "chown -R nginx:nginx /var/cache/nginx && nc -lk -p 9888 -e /purge-handler.sh & /stats.sh & exec nginx -g 'daemon off;'"]
    expose:
      - "8888"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.poster-cache.rule=Host(`poster-cache.example.com`)"
      - "traefik.http.routers.poster-cache.entrypoints=websecure"
      - "traefik.http.routers.poster-cache.tls.certresolver=letsencrypt"
      - "traefik.http.services.poster-cache.loadbalancer.server.port=8888"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:8888/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

Save the following as `poster-cache-nginx.conf` next to your `docker-compose.yml`:

```nginx
user nginx;
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    # Cache storage on disk — adjust max_size to suit available space
    proxy_cache_path /var/cache/nginx/posters
                     levels=1:2
                     keys_zone=poster_cache:10m
                     max_size=10g
                     inactive=30d
                     use_temp_path=off;

    # Restore double-slash after scheme when a reverse proxy (e.g. Traefik)
    # collapses "https://" to "https:/".
    # Input:  /https:/api.example.com/path  ->  https://api.example.com/path
    # Input:  /https://api.example.com/path ->  https://api.example.com/path
    map $request_uri $upstream_url {
        ~^/(https?):/([^/].*)$  $1://$2;
        ~^/(https?://.*)$       $1;
        default                 "";
    }

    # Extract scheme + host from the upstream URL for resolving relative redirects
    map $upstream_url $upstream_origin {
        ~^(https?://[^/]+)  $1;
        default             "";
    }

    log_format cache '$remote_addr - [$time_local] "$request" $status '
                     '$body_bytes_sent $upstream_cache_status';
    access_log /var/log/nginx/access.log cache;

    server {
        listen 8888;

        location = /health {
            access_log off;
            return 200 'ok';
        }

        location = /stats {
            access_log off;
            default_type application/json;
            alias /tmp/cache-stats.json;
        }

        location = /purge {
            access_log off;
            default_type application/json;
            proxy_pass http://127.0.0.1:9888;
        }

        location / {
            resolver 127.0.0.11 valid=30s ipv6=off;

            if ($upstream_url = "") {
                return 400;
            }

            proxy_pass $upstream_url;
            proxy_ssl_server_name on;

            # Rewrite relative upstream redirects into absolute URLs.
            # Some upstreams (e.g. openposterdb) return relative 302 Location headers
            # like "/c/abc/path" which the client would resolve against the proxy host.
            # This rewrites them to point to the actual upstream origin.
            #   e.g. Location: /c/abc/path → Location: https://openposterdb.com/c/abc/path
            proxy_redirect / $upstream_origin/;

            proxy_cache poster_cache;
            proxy_cache_key $upstream_url;
            proxy_cache_valid 200 30d;
            proxy_ignore_headers Cache-Control Expires Vary;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
            proxy_cache_lock on;

            add_header X-Cache-Status $upstream_cache_status;

            proxy_set_header Host $proxy_host;
            proxy_set_header X-Forwarded-Host $proxy_host;
            proxy_set_header Accept-Encoding "";
        }
    }
}
```

Save the following as `poster-cache-stats.sh` next to your `docker-compose.yml`:

```sh
#!/bin/sh
# Periodically writes cache stats to a JSON file served by nginx
CACHE_DIR="/var/cache/nginx/posters"
STATS_FILE="/tmp/cache-stats.json"
MAX_SIZE="${POSTER_CACHE_MAX_SIZE:-10g}"
INACTIVE="${POSTER_CACHE_INACTIVE:-30d}"

while true; do
  if [ -d "$CACHE_DIR" ]; then
    size_bytes=$(du -sb "$CACHE_DIR" 2>/dev/null | cut -f1)
    file_count=$(find "$CACHE_DIR" -type f 2>/dev/null | wc -l)
    size_human=$(awk "BEGIN {
      b = ${size_bytes:-0};
      if (b >= 1000000000) printf \"%.1fG\", b/1000000000;
      else if (b >= 1000000) printf \"%.1fM\", b/1000000;
      else if (b >= 1000) printf \"%.1fK\", b/1000;
      else printf \"%dB\", b;
    }")
  else
    size_bytes=0
    size_human="0B"
    file_count=0
  fi

  # Check for purge flag
  if [ -f /tmp/purge-cache ]; then
    rm -f /tmp/purge-cache
    rm -rf "$CACHE_DIR"
    mkdir -p "$CACHE_DIR"
    chown nginx:nginx "$CACHE_DIR"
    size_bytes=0
    size_human="0B"
    file_count=0
  fi

  cat > "$STATS_FILE" <<EOF
{"cached_images":${file_count},"disk_usage":"${size_human}","disk_usage_bytes":${size_bytes},"max_size":"${MAX_SIZE}","inactive":"${INACTIVE}"}
EOF
  sleep 30
done
```

Save the following as `poster-cache-purge-handler.sh` next to your `docker-compose.yml`:

```sh
#!/bin/sh
# HTTP handler for /purge — called by nc -lk -e
read -r method path _
# Consume remaining headers
while read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r\n')
  [ -z "$line" ] && break
done

touch /tmp/purge-cache
BODY='{"success":true,"message":"cache purge scheduled"}'
printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" ${#BODY} "$BODY"
```

Make both scripts executable:

```bash
chmod +x poster-cache-stats.sh poster-cache-purge-handler.sh
```

Then set these environment variables on the aiometadata service:

| Variable | Description | Example |
|----------|-------------|---------|
| `DOCKER_DATA_DIR` | Base directory for persistent Docker data | `/opt/docker/data` |
| `POSTER_PROXY_PREFIX_URL` | Public HTTPS URL for the proxy (used in responses so Stremio fetches through it) | `https://poster-cache.example.com` |
| `POSTER_WARMUP_URL` | Internal Docker URL for server-side warming (optional, falls back to `POSTER_PROXY_PREFIX_URL`) | `http://poster-cache:8888` |
| `POSTER_WARMUP_DELAY_MS` | Delay between poster warm batches during warming (default `50`) | `50` |
| `POSTER_WARMUP_CONCURRENCY` | Number of concurrent poster warm requests per batch (default `1`) | `5` |

If you're not using Traefik, remove the labels, expose port 8888 directly, and set `POSTER_PROXY_PREFIX_URL` to wherever your proxy is publicly accessible.

### 4. Self-Hosted Jikan API (Optional — Anime Source)

Anime metadata is sourced from [MyAnimeList](https://myanimelist.net/) via the [Jikan](https://jikan.moe/) API. By default the addon uses the public instance (`https://api.jikan.moe/v4`), but **the public Jikan API is shutting down on October 1, 2026** (brownout from September 1). To keep anime metadata working, run your own Jikan instance and point the addon at it with a single environment variable:

```env
JIKAN_API_BASE=http://jikan_rest:8080/v4
```

Set this on the `aiometadata` service (in its `.env`). When both containers share a Docker network, the addon reaches Jikan by container name — no public exposure needed.

#### Compose stack

Jikan runs as four services: `jikan_rest` serves the API, MongoDB holds the data, Redis caches responses, and Typesense answers `?q=`. [Search](#search) covers how the last two divide the work.

Save as `apps/jikan-rest/compose.yaml` (or merge into your stack):

```yaml
secrets:
  jikan_db_username:       { file: ./secrets/db_username.txt }
  jikan_db_password:       { file: ./secrets/db_password.txt }
  jikan_db_admin_username: { file: ./secrets/db_admin_username.txt }
  jikan_db_admin_password: { file: ./secrets/db_admin_password.txt }
  jikan_redis_password:    { file: ./secrets/redis_password.txt }
  jikan_typesense_api_key: { file: ./secrets/typesense_api_key.txt }

services:
  jikan_rest:
    image: docker.io/jikanme/jikan-rest:latest
    container_name: jikan_rest
    hostname: jikan-rest-api
    user: "10001:10001"
    restart: unless-stopped
    env_file: [ .env.compose ]
    secrets: [ jikan_db_username, jikan_db_password, jikan_redis_password, jikan_typesense_api_key ]
    volumes:
      - ./RepositoryQuery.php:/app/app/Support/RepositoryQuery.php:ro
    expose: [ 8080 ]
    healthcheck:
      test: ["CMD-SHELL", "wget --spider -q 'http://127.0.0.1:2114/health?plugin=http'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      jikan_mongo:     { condition: service_healthy }
      jikan_redis:     { condition: service_healthy }
      jikan_typesense: { condition: service_started }

  jikan_mongo:
    image: docker.io/mongo:focal
    container_name: jikan_mongo
    hostname: jikan_mongo
    restart: unless-stopped
    command: "--wiredTigerCacheSizeGB 0.5"
    secrets: [ jikan_db_username, jikan_db_password, jikan_db_admin_username, jikan_db_admin_password ]
    environment:
      MONGO_INITDB_ROOT_USERNAME_FILE: /run/secrets/jikan_db_admin_username
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/jikan_db_admin_password
      MONGO_INITDB_DATABASE: jikan_admin
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/mongo:/data/db
      - ./mongo-init.js:/docker-entrypoint-initdb.d/mongo-init.js:ro
    healthcheck:
      test: ["CMD-SHELL", "mongosh mongodb://localhost:27017 --quiet --eval 'db.runCommand(\"ping\").ok'"]
      interval: 30s
      timeout: 10s
      retries: 5

  jikan_redis:
    image: docker.io/redis:6-alpine
    container_name: jikan_redis
    hostname: jikan_redis
    restart: unless-stopped
    secrets: [ jikan_redis_password ]
    command: ["/bin/sh", "-c", "redis-server --requirepass \"$$(cat /run/secrets/jikan_redis_password)\" --appendonly yes"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/redis:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$(cat /run/secrets/jikan_redis_password)\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5

  jikan_typesense:
    image: docker.io/typesense/typesense:0.24.1
    container_name: jikan_typesense
    hostname: jikan_typesense
    restart: unless-stopped
    entrypoint: /bin/sh
    secrets: [ jikan_typesense_api_key ]
    command: ["-c", "TYPESENSE_API_KEY=\"$$(cat /run/secrets/jikan_typesense_api_key)\" /opt/typesense-server --data-dir /data"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/typesense:/data
```

Save the container config as `apps/jikan-rest/.env.compose`:

```env
APP_DEBUG=false
LOG_LEVEL=info
APP_ENV=production
# Indexers self-call the API; must point at RoadRunner's port (8080), NOT the default port 80
APP_URL=http://127.0.0.1:8080
CACHING=true
CACHE_DRIVER=redis
REDIS_HOST=jikan_redis
REDIS_PASSWORD__FILE=/run/secrets/jikan_redis_password
DB_CONNECTION=mongodb
DB_HOST=jikan_mongo
DB_DATABASE=jikan
DB_USERNAME__FILE=/run/secrets/jikan_db_username
DB_ADMIN__FILE=/run/secrets/jikan_db_username
DB_PASSWORD__FILE=/run/secrets/jikan_db_password
SCOUT_DRIVER=typesense
SCOUT_QUEUE=false
TYPESENSE_HOST=jikan_typesense
TYPESENSE_PORT=8108
TYPESENSE_API_KEY__FILE=/run/secrets/jikan_typesense_api_key
CORS_MIDDLEWARE=true
MICROCACHING=true
MICROCACHING_EXPIRE=60
# Only needed if you raise MAL_PAGE_SIZE on the addon. Both default to 25.
MAX_RESULTS_PER_PAGE=50
```

Save the MongoDB init script as `apps/jikan-rest/mongo-init.js`. It creates the app user and the `anime` indexes the squash migration is supposed to create but does not reliably apply. Building them here means they exist before the indexer inserts its first row, so `mal_id` stays unique and queries never fall back to collection scans:

```js
const userToCreate = fs.readFileSync('/run/secrets/jikan_db_username', 'utf8').trim();
const userPassword = fs.readFileSync('/run/secrets/jikan_db_password', 'utf8').trim();
db = db.getSiblingDB("admin");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });
db = db.getSiblingDB("jikan");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });

// Mirrors database/migrations/2022_12_04_210448_squash.php.
const fields = [
  "aired", "airing", "episodes", "members", "favorites", "popularity", "rank",
  "rating", "score", "scored_by", "status", "type", "source",
  "title", "title_english", "title_japanese", "title_synonyms",
  "demographics.mal_id", "explicit_genres.mal_id", "genres.mal_id",
  "licensors.mal_id", "producers.mal_id", "studios.mal_id", "themes.mal_id",
  "aired.from", "aired.to",
];
fields.forEach(f => db.anime.createIndex({ [f]: 1 }, { name: f }));
db.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
db.anime.createIndex(
  { title: "text", title_japanese: "text" },
  { name: "search", weights: { title: 50, title_japanese: 5 } }
);
print("anime indexes created: " + db.anime.getIndexes().length);
```

This only runs when the data directory is empty, so it covers new stacks. Existing ones need the [manual pass](#mongodb-indexes) below.

#### Query builder patch (required)

`queryable()` memoises its builder on a singleton repository, and RoadRunner workers outlive requests, so a worker ANDs together the `where` clauses of everything it has served. The symptom is identical URLs returning different counts, and a `sfw=true` that returns nothing. Save as `apps/jikan-rest/RepositoryQuery.php`:

```php
<?php

namespace App\Support;

use App\Contracts\RepositoryQuery as RepositoryQueryContract;
use Illuminate\Contracts\Database\Query\Builder;
use Illuminate\Support\Collection;
use Laravel\Scout\Builder as ScoutBuilder;

class RepositoryQuery extends RepositoryQueryBase implements RepositoryQueryContract
{
    public function filter(Collection $params): Builder|ScoutBuilder
    {
        // queryable() memoises the builder. Repositories are singletons that outlive
        // a request under RoadRunner, so the memoised instance accumulates every
        // previous request's where clauses (genre A AND genre B AND ... => 0 results).
        // Always start from a fresh builder.
        return $this->queryable(true)->filter($params);
    }

    public function search(string $keywords, ?\Closure $callback = null): ScoutBuilder
    {
        return $this->searchable($keywords, $callback, true);
    }

    public function where(string $key, mixed $value): Builder
    {
        return $this->queryable(true)->where($key, $value);
    }
}
```

Create this file before the first `docker compose up -d`, otherwise Docker creates a directory at that mount path.

Generate the secret files (note the `chmod 644` — Mongo and the app run as non-root and must be able to read the bind-mounted secrets):

```bash
cd apps/jikan-rest && mkdir -p secrets
echo -n "jikan"        > secrets/db_username.txt
echo -n "jikanadmin"   > secrets/db_admin_username.txt
openssl rand -hex 24 | tr -d '\n' > secrets/db_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/db_admin_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/redis_password.txt
openssl rand -hex 24 | tr -d '\n' > secrets/typesense_api_key.txt
chmod 644 secrets/*.txt
```

Then start it: `docker compose up -d`

#### Search

Jikan splits a search in two. Typesense matches `?q=`, and MongoDB applies everything else: `SearchEngineSearchService` hands the filters to Scout's `query()` hook, which runs them against the Eloquent builder that hydrates the results. So `genres`, `genres_exclude`, `producers`, `sfw`, `min_score`, `max_score`, `start_date` and `end_date` behave exactly as they would with no search engine at all, while `?q=` gets typo tolerance and matching on part of a word. The compose stack above is already wired this way, and no part of it needs patching.

The other option is `SCOUT_DRIVER=null`, which sends the whole query to `MongoSearchService` instead. It is not worth taking: `$text` indexes whole tokens and tolerates no typos, so `999` never reaches *Lv999 no Murabito*, and a misspelled title returns nothing.

##### Coming from an earlier version of this guide

Revisions of this section before August 2026 recommended exactly that, through a `SCOUT_DRIVER: '"null"'` entry under `environment:` and a patched `MongoSearchService.php` mount. Both are now unnecessary — delete them from `compose.yaml`, keeping the `RepositoryQuery.php` mount, and recreate the container:

```bash
docker compose up -d jikan_rest
```

`SCOUT_DRIVER=typesense` in `.env.compose` then takes effect. The `MongoSearchService.php` file itself can be deleted once nothing mounts it.

##### Populating the index

Scout keeps Typesense current through model observers, and the `null` driver disables them. Any stack that ran with search off therefore has an index that is empty or frozen at the day it was switched off, and needs a one-off import per model:

```bash
for m in Anime Manga Character Person Club Magazine Producers; do
  docker exec jikan_rest php artisan scout:import "App\\$m"
done
```

Thirty thousand anime take about a minute. After that the observers keep the index in step with the indexer commands, so this is not a recurring job.

Importing a model whose Mongo collection is still empty creates a collection with no fields, and searching it then returns HTTP 500 rather than an empty list, because the sort and query-by fields the model names do not exist. Run the import after the corresponding indexer, or create the collection with the fields up front. Typesense's `.*` auto field fills in the rest once real documents arrive:

```bash
docker exec jikan_rest php -r '
$key = trim(file_get_contents("/run/secrets/jikan_typesense_api_key"));
$auto = ["name" => ".*", "type" => "auto", "optional" => true];
// A query of three characters or fewer is sorted by the title attribute, which a
// string field only allows when it is declared sortable.
$string = fn($n, $sort = false) => ["name" => $n, "type" => "string", "optional" => true, "sort" => $sort];
$strings = fn($n) => ["name" => $n, "type" => "string[]", "optional" => true];
$int = fn($n) => ["name" => $n, "type" => "int64", "optional" => true];
$schemas = [
  "manga_index" => [$auto, $string("title", true), $string("title_transformed"),
    $string("title_english"), $string("title_english_transformed"),
    $string("title_japanese"), $string("title_japanese_transformed"),
    $strings("title_synonyms"), $int("popularity"), $int("rank")],
  "characters_index" => [$auto, $string("name", true), $string("name_kanji"), $int("member_favorites")],
  "people_index" => [$auto, $string("name", true), $string("given_name"), $string("family_name"),
    $strings("alternate_names"), $int("member_favorites")],
];
foreach ($schemas as $name => $fields) {
  $c = curl_init("http://jikan_typesense:8108/collections");
  curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["X-TYPESENSE-API-KEY: $key", "Content-Type: application/json"],
    CURLOPT_POSTFIELDS => json_encode(["name" => $name, "fields" => $fields])]);
  curl_exec($c);
  echo $name, " ", curl_getinfo($c, CURLINFO_HTTP_CODE), PHP_EOL;
}'
```

Restart `jikan_rest` afterwards. Its collection descriptor caches a schema per RoadRunner worker, so workers started before an index existed keep serving the old answer.

##### Result ordering

`TYPESENSE_TEXT_MATCH_BUCKETS` (default 1) groups results into relevance bands before the secondary sort applies. Raising it leans the order towards popularity, lowering it towards the exact wording of the query.

#### MongoDB indexes

New stacks get these from `mongo-init.js` above and can skip this section. Stacks built before that ran are likely sitting on a single `_id_` index, which means collection scans and genre requests that time out once the catalog is seeded. `mongo-init.js` will not fix them, since it only fires on an empty data directory. Check the count:

```bash
docker exec jikan_mongo mongosh "mongodb://<admin_user>:<admin_pass>@localhost/admin" \
  --quiet --eval 'print(db.getSiblingDB("jikan").anime.getIndexes().length)'
```

You want 29. If it says 1, save this as `apps/jikan-rest/jikan-indexes.js`:

```js
// Mirrors database/migrations/2022_12_04_210448_squash.php. Safe to re-run.
const d = db.getSiblingDB("jikan");
const fields = [
  "aired", "airing", "episodes", "members", "favorites", "popularity", "rank",
  "rating", "score", "scored_by", "status", "type", "source",
  "title", "title_english", "title_japanese", "title_synonyms",
  "demographics.mal_id", "explicit_genres.mal_id", "genres.mal_id",
  "licensors.mal_id", "producers.mal_id", "studios.mal_id", "themes.mal_id",
  "aired.from", "aired.to",
];
fields.forEach(f => d.anime.createIndex({ [f]: 1 }, { name: f }));
try {
  d.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
} catch (e) {
  print("mal_id index failed, see the duplicate cleanup below: " + e.codeName);
}
d.anime.createIndex(
  { title: "text", title_japanese: "text" },
  { name: "search", weights: { title: 50, title_japanese: 5 } }
);
print("anime indexes: " + d.anime.getIndexes().length);
```

and pipe it in:

```bash
cd apps/jikan-rest
docker exec -i jikan_mongo mongosh \
  "mongodb://$(cat secrets/db_admin_username.txt):$(cat secrets/db_admin_password.txt)@localhost/admin" \
  --quiet < jikan-indexes.js
```

Run it before the full catalog indexer if you can, it is cheaper on an empty collection.

If it prints 28 and the `mal_id` line reported `DuplicateKey`, the indexer stored the same anime twice, which it can do freely while no unique index exists. Save this as `apps/jikan-rest/jikan-dedupe.js` to delete the extra copies and retry the index:

```js
const d = db.getSiblingDB("jikan");
d.anime.aggregate([
  { $group: { _id: "$mal_id", ids: { $push: "$_id" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
], { allowDiskUse: true }).forEach(g => {
  g.ids.slice(1).forEach(id => d.anime.deleteOne({ _id: id }));
  print("mal_id " + g._id + ": removed " + (g.n - 1));
});
d.anime.createIndex({ mal_id: 1 }, { name: "mal_id", unique: true });
print("anime indexes: " + d.anime.getIndexes().length);
```

Pipe it in the same way:

```bash
cd apps/jikan-rest
docker exec -i jikan_mongo mongosh \
  "mongodb://$(cat secrets/db_admin_username.txt):$(cat secrets/db_admin_password.txt)@localhost/admin" \
  --quiet < jikan-dedupe.js
```

It keeps the first copy of each and drops the rest. The unique index then stops the indexer creating more.

#### Seeding the index

Direct lookups (e.g. `/v4/anime/1`) work immediately by scraping MAL on demand. But **search, `seasons`, `top`, and genre catalogs are served from Jikan's own database, which starts empty** and must be populated. Run the indexers (they scrape MAL and are rate-limited):

```bash
# Fast metadata
docker exec jikan_rest php artisan indexer:genres
docker exec jikan_rest php artisan indexer:producers
docker exec jikan_rest php artisan indexer:anime-current-season
docker exec jikan_rest php artisan indexer:anime-schedule

# Full catalog (~30k anime — runs for hours; --delay is seconds between requests, default 3)
docker exec -d jikan_rest sh -c 'php artisan indexer:anime --delay=1 >> /tmp/indexer-anime.log 2>&1'
```

Lower `--delay` speeds it up but increases the risk of MyAnimeList rate-limiting your IP. The container self-runs a scheduler that keeps data fresh after the initial seed. Check progress with `docker exec jikan_rest tail -f /tmp/indexer-anime.log`.

#### Optional: worker-leak mitigation

The bundled RoadRunner app server can accumulate CPU/memory over time. To recycle workers gracefully (no restart needed), mount a custom `.rr.yaml` over `/app/.rr.yaml` that adds lifecycle limits — give the queue worker `queue:work --max-time=3600 --max-jobs=1000 --memory=256`, set the HTTP pool `supervisor.ttl: 3600s`, and cap `num_workers`. Add `- ./rr.yaml:/app/.rr.yaml:ro` to the `jikan_rest` volumes.

---

## ⚙️ Configuration

- **Catalogs**: Add, remove, and reorder catalogs (TMDB, TVDB, MAL, AniList, MDBList, streaming, etc.).
- **Providers**: Set preferred metadata and artwork provider for each type.
- **Search**: Enable/disable search engines per type; enable AI search with Gemini API key.
- **Integrations**: Connect MDBList and more for personal lists.
- **Security**: Set user and (optional) addon password for config protection.

All configuration is managed via the `/configure` UI and saved per-user (UUID) in the database.

---

## 🔌 API & Endpoints

- `/stremio/:userUUID/:compressedConfig/manifest.json` — Stremio manifest (per-user config)
- `/api/config/save` — Save user config (POST)
- `/api/config/load/:userUUID` — Load user config (POST)
- `/api/config/update/:userUUID` — Update user config (PUT)
- `/api/config/is-trusted/:uuid` — Check if UUID is trusted (GET)
- `/api/cache/*` — Cache health and admin endpoints
- `/poster/:type/:id` — Poster proxy with fallback and RPDB support
- `/resize-image` — Image resize proxy
- `/api/image/blur` — Image blur proxy

---

## 🧩 Supported Providers

- **Movies/Series**: TMDB, TVDB, IMDb, TVmaze
- **Anime**: MyAnimeList (MAL), AniList, Kitsu, AniDB, TVDB, IMDb
- **Artwork**: TMDB, TVDB, Fanart.tv, AniList, RPDB
- **Personal Lists**: MDBList, MAL, AniList
- **Streaming**: Netflix, Disney+, Amazon, and more (via TMDB watch providers)

---

## 🧑‍💻 Development

```bash
# Backend
npm run dev:server

# Frontend
npm run dev
```

- Edit `/addon` for backend, `/configure` for frontend.
- Uses Redis for caching, SQLite/PostgreSQL for config storage.

---

## 🤝 Contributing

We welcome community contributions! However, to keep review times manageable, we have specific guidelines. **Please read the [CONTRIBUTING.md](docs/contributing.md) guide before opening issues or pull requests.**

---

## 📄 License

GPL-3.0 — see [LICENSE](LICENSE).

---

## 🙏 Credits

- [Stremio](https://www.stremio.com/)
- [TMDB](https://www.themoviedb.org/)
- [TVDB](https://thetvdb.com/)
- [MyAnimeList](https://myanimelist.net/)
- [AniList](https://anilist.co/)
- [Fanart.tv](https://fanart.tv/)
- [MDBList](https://mdblist.com/)
- [RPDB](https://rpdb.net/)

**Special thanks to [MrCanelas](https://github.com/mrcanelas), the original developer of the TMDB Addon for Stremio, whose work inspired and laid the groundwork for this project.**

---

## ⚠️ Disclaimer

This addon aggregates metadata from third-party sources. Data accuracy and availability are not guaranteed.
