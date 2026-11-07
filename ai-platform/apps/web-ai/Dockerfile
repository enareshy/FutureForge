# syntax=docker/dockerfile:1.7
#
# Enterprise AI Platform — console (React + Vite) production image.
#
# Multi-stage: Node builds the static bundle, then an unprivileged nginx
# serves it and reverse-proxies API traffic to the AI API (and, when
# colocated, the enterprise backend). The runtime image runs as a non-root
# user (uid 101) on port 8080.
#
# Build (from the web-ai app directory):
#   docker build -t enterprise-ai-platform/web-ai:0.1.0 .

ARG NODE_IMAGE=node:22.22.0-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

# --- Stage 1: build the static bundle ----------------------------------
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# --- Stage 2: serve with unprivileged nginx ----------------------------
FROM ${NGINX_IMAGE} AS runtime

# The AI API upstream is injected at container start via envsubst so the
# same image works across environments. Only this variable is substituted
# (NGINX_ENVSUBST_FILTER), so nginx variables like $host pass through.
ENV AI_API_UPSTREAM=http://ai-api:8000 \
    NGINX_ENVSUBST_FILTER=^AI_API_UPSTREAM$

COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]
