#!/bin/sh
# ISMS Builder – Docker Entrypoint
# Stellt sicher, dass alle benötigten Datenverzeichnisse vorhanden sind,
# bevor der Server gestartet wird (wichtig bei Bind-Mount auf leerem Host-Verzeichnis)
set -e

# Respects DATA_DIR like the application code does (server/*.js almost all
# read process.env.DATA_DIR || <repo>/data) — defaults to /app/data, matching
# both the Docker Compose bind mount (./data:/app/data) and the Helm chart's
# PVC mount point, so this only matters if DATA_DIR is deliberately overridden.
DATA_ROOT="${DATA_DIR:-/app/data}"

mkdir -p \
  "$DATA_ROOT/gdpr/files" \
  "$DATA_ROOT/guidance/files" \
  "$DATA_ROOT/template-files" \
  "$DATA_ROOT/legal/files" \
  "$DATA_ROOT/bcm-files" \
  "$DATA_ROOT/governance-files"

if [ "$(id -u)" = "0" ]; then
  # Docker Compose / bare-metal path (unchanged): container starts as root
  # (see Dockerfile), so it can chown a bind-mounted data/ directory that may
  # have a different owner on the host, then drop privileges via su-exec
  # before starting the Node process.
  chown -R isms:isms "$DATA_ROOT"
  exec su-exec isms node server/index.js
else
  # Kubernetes path: the pod's securityContext already starts the container
  # as the non-root "isms" user (runAsUser/runAsGroup, fixed UID/GID 10001 —
  # see Dockerfile) and sets fsGroup on the mounted PVC, so the volume is
  # already writable by this user/group. There is nothing to chown, and no
  # privilege to drop — su-exec would fail here (already non-root).
  exec node server/index.js
fi
