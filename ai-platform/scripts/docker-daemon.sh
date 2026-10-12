#!/usr/bin/env bash
# Ensure the Docker daemon is running. This microVM has no systemd, so dockerd
# is started directly and detached when it is not already available.
set -euo pipefail

if docker info >/dev/null 2>&1; then
  echo "docker daemon: already running"
  exit 0
fi

LOG="${DOCKERD_LOG:-/tmp/enterprise-ai-dockerd.log}"
echo "docker daemon: starting (log: ${LOG})"
nohup dockerd --host=unix:///var/run/docker.sock >"$LOG" 2>&1 &

for _ in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    echo "docker daemon: ready"
    exit 0
  fi
  sleep 1
done

echo "docker daemon: failed to start; see ${LOG}" >&2
exit 1
