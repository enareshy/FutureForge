# syntax=docker/dockerfile:1.7
#
# Enterprise AI Platform — AI API (FastAPI) production image.
#
# Multi-stage: a builder installs pinned wheels into a virtualenv, and the
# runtime stage copies only that virtualenv plus application source. The
# runtime container runs as a non-root user and ships a healthcheck against
# the liveness probe.
#
# Build (from the ai-api app directory):
#   docker build -t enterprise-ai-platform/ai-api:0.1.0 .
#
# Base tags are pinned to a specific patch release. For supply-chain
# hardening, pin to a digest (python:3.11.12-slim-bookworm@sha256:...).

ARG PYTHON_IMAGE=python:3.11.12-slim-bookworm
ARG PYTHON_VERSION=3.11

# --- Stage 1: build the virtualenv -------------------------------------
FROM ${PYTHON_IMAGE} AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# The venv created by `python -m venv` seeds an old setuptools (65.5.0), and the
# base image ships an old wheel; both carry HIGH CVEs (CVE-2022-40897,
# CVE-2024-6345, CVE-2025-47273, CVE-2026-24049). Upgrade the build tooling in
# the venv so the runtime image carries patched metadata.
RUN pip install --no-cache-dir --upgrade "pip>=24.0" "setuptools>=84.2.1" "wheel>=0.48.0"

# Install runtime dependencies first so this layer is cached across source
# changes. Requirements are fully pinned in requirements.txt.
COPY requirements.txt ./
RUN pip install --no-compile -r requirements.txt

# --- Stage 2: runtime --------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app/src

# Pull the latest security patches for the base OS packages. The pinned
# python:3.11-slim-bookworm tag still ships an older Debian snapshot whose
# openssl/gnutls/pcre2/perl/apt packages carry HIGH/CRITICAL CVEs; upgrading at
# build time refreshes them from the current bookworm security repo. Result
# caches are removed in the same layer so they do not bloat the image.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# The base image's system site-packages ships setuptools 65.5.1 and wheel 0.45.1,
# both with HIGH CVEs. They are not used at runtime (the virtualenv on PATH is),
# but they are still part of the image, so upgrade them for a clean scan.
RUN python -m pip install --no-cache-dir --upgrade "setuptools>=84.2.1" "wheel>=0.48.0"

# Dedicated unprivileged account (no shell, no home directory).
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY --chown=app:app src ./src

USER app

EXPOSE 8000

# Liveness: the app always answers /healthz when the process is up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"]

# Run the app module (reads AI_API_HOST / AI_API_PORT / AI_API_LOG_LEVEL).
CMD ["python", "-m", "ai_api.main"]
