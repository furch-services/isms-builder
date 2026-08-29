# ─────────────────────────────────────────────────────────────────
# ISMS Builder – Dockerfile
# Multi-stage: build (npm ci) → runtime (node:lts-alpine)
#
# Daten (JSON + Uploads) werden NICHT ins Image gebacken.
# Sie müssen als Bind-Mount bereitgestellt werden:
#   docker compose up   →  ./data:/app/data  (siehe docker-compose.yml)
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: install dependencies ────────────────────────────────
FROM node:lts-alpine AS deps
WORKDIR /app

# Build-Toolchain für native Module (better-sqlite3): wird nur gebraucht,
# falls prebuild-install kein passendes vorkompiliertes Binary findet/laden
# kann und auf node-gyp-Kompilierung zurückfällt. Fliegt mit der Stage aus
# dem finalen Image (Multi-Stage-Build kopiert nur node_modules weiter).
RUN apk add --no-cache python3 make g++

# Copy only manifests first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────
FROM node:lts-alpine AS runtime
WORKDIR /app

# Non-root user for security + su-exec for privilege drop in entrypoint.
# Fixed UID/GID (10001) instead of an Alpine-assigned system UID: Kubernetes
# securityContext.runAsUser/fsGroup needs a stable, known value to reference —
# see charts/isms-builder/values.yaml podSecurityContext. 10001 (not 1000):
# node:lts-alpine already ships a "node" user/group at 1000.
RUN addgroup -g 10001 -S isms && adduser -u 10001 -S isms -G isms \
    && apk add --no-cache su-exec

# Copy installed modules from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (kein data/ – wird als Bind-Mount gemountet)
COPY server ./server
COPY ui     ./ui
# docs/ + die vier Root-Markdown-Dateien: werden von den Guidance-Seeds
# (ARCH_SEED in guidanceStore.js) zur Laufzeit eingelesen. .dockerignore
# filtert die grossen/internen Teile (docs/private, docs/community, ...)
# bereits raus — Gesamtgewicht der kopierten docs/ < 1 MB.
COPY docs ./docs
COPY README.md CONTRIBUTING.md CHANGELOG.md THIRD-PARTY-LICENSES.md ./
COPY package.json ./
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh \
    && chown -R isms:isms /app

# Container startet als root: Entrypoint legt Verzeichnisse an, chownt das
# (ggf. bind-gemountete) data/-Verzeichnis und wechselt dann per su-exec zu
# isms. USER isms hier zu setzen würde das verhindern (kein chown-Recht auf
# host-gemountete Verzeichnisse mit abweichendem Owner) — s. GitHub Issue #46.

# Environment defaults (override via .env.docker oder docker run -e)
ENV NODE_ENV=production \
    PORT=3000 \
    JWT_EXPIRES_IN=8h \
    DEV_HEADER_AUTH=false \
    STORAGE_BACKEND=json

EXPOSE 3000

# Healthcheck (HTTP; bei SSL auf https anpassen oder wget-Flag setzen)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/ui/login.html || exit 1

# Entrypoint erstellt fehlende Unterverzeichnisse und startet den Server
ENTRYPOINT ["./docker-entrypoint.sh"]
