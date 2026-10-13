# constella-agent: one container per agent, runs the runner + Codex app-server.
FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.162.1
ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip ripgrep jq procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm config set registry "$NPM_REGISTRY" \
 && npm i -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

ENV CODEX_HOME=/home/agent/.codex
RUN useradd -m -d /home/agent -s /bin/bash agent && mkdir -p /workspace && chown agent:agent /workspace
USER agent
RUN mkdir -p "$CODEX_HOME"
WORKDIR /workspace
