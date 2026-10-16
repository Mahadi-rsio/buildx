# buildx sandbox image (arcetecture.md §2.3) — Debian with the Node/Python
# toolchain the agent needs: node + npm + pnpm + bun, python3 + pip, git,
# ripgrep, fd, jq, build-essential, OpenSSH, and the sandbox-daemon.
#
# The workdir is /workspace (volume-mounted on Fly). The daemon serves the
# orchestrator's token-authenticated HTTP API on :8080.
FROM debian:bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_VERSION=22 \
    WORKSPACE_ROOT=/workspace \
    SANDBOX_PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    git \
    gnupg \
    jq \
    ripgrep \
    fd-find \
    python3 \
    python3-pip \
    python3-venv \
    openssh-client \
    unzip \
    zip \
    procps \
    zstd \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS via NodeSource (also installs npm).
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@latest --loglevel=error

# Pre-warm the pnpm content-addressable store with the common web toolchain so
# `pnpm install` inside a workspace is mostly cache-hits (phase.md §5).
RUN mkdir -p /pnpm-warm && cd /pnpm-warm \
    && printf '{"name":"buildx-warm","private":true}\n' > package.json \
    && pnpm install --store-dir /pnpm-store next react react-dom tailwindcss --loglevel=error \
    && rm -rf /pnpm-warm /root/.cache
ENV NPM_CONFIG_STORE_DIR=/pnpm-store

# Bun — quick JS runtime some projects use for package scripts.
RUN curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /root/.bun

# fd is installed as fdfind on Debian; alias the common name.
RUN ln -s "$(command -v fdfind)" /usr/local/bin/fd

# Quietish git identity so commits inside the sandbox don't fail.
RUN git config --system user.email "sandbox@buildx.local" \
    && git config --system user.name "buildx sandbox" \
    && git config --system init.defaultBranch main

WORKDIR /workspace

COPY services/sandbox-daemon/server.mjs /app/server.mjs

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

CMD ["node", "/app/server.mjs"]