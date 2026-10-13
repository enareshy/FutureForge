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
