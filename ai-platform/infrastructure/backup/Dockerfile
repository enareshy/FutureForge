# syntax=docker/dockerfile:1.7
#
# Dedicated backup/restore image for SEC-20.
#
# Build from the repository root so the script is in the build context:
#   docker build -f infrastructure/backup/Dockerfile -t enterprise-ai-platform/ai-backup:0.1.0 .
#
# PostgreSQL 16 client tools are used because the target server may run a newer
# major version than the application's Python base image. boto3 is the only
# Python dependency; the backup tool itself uses the standard library.
FROM postgres:16.9-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/backup-venv/bin:${PATH}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      gnupg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/backup-venv \
 && /opt/backup-venv/bin/pip install --no-cache-dir boto3==1.43.111

# The PostgreSQL base image already ships a `backup` group/user at uid/gid 34
# (/var/backups). Reuse neither: the Deployments and CronJobs pin uid/gid
# 10001, so create a dedicated unprivileged account at that fixed id under a
# name the base image does not occupy.
RUN groupadd --system --gid 10001 ai-backup \
 && useradd --system --uid 10001 --gid ai-backup --no-create-home --shell /usr/sbin/nologin ai-backup \
 && mkdir -p /backup \
 && chown ai-backup:ai-backup /backup

WORKDIR /app
COPY --chown=ai-backup:ai-backup scripts/backup_restore.py /app/backup_restore.py

USER ai-backup

ENTRYPOINT ["/opt/backup-venv/bin/python", "/app/backup_restore.py"]
CMD ["backup"]
