# constella-agent: one container per agent, runs the runner + Codex app-server.
# Build from the repo root: docker build -f images/agent/Dockerfile -t constella-agent .
FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.162.1
ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip python3-venv ripgrep jq \
      procps bubblewrap openssh-client less unzip xz-utils file \
 && rm -rf /var/lib/apt/lists/* \
 && npm config set registry "$NPM_REGISTRY" \
 && npm i -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && userdel -r node \
 && useradd -m -u 1000 -d /home/agent -s /bin/bash agent \
 && mkdir -p /workspace && chown agent:agent /workspace

COPY apps/runner/src /opt/constella/runner/src

ENV CODEX_HOME=/home/agent/.codex NODE_NO_WARNINGS=1
USER agent
WORKDIR /workspace
CMD ["node", "/opt/constella/runner/src/index.ts"]
