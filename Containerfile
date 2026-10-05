FROM debian:bookworm-slim AS builder

ARG TARGETARCH
ARG MOQ_CLI_VERSION=0.10.0
ARG MOQ_RELAY_VERSION=0.14.5

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Prebuilt Linux binaries from moq-dev/moq's GitHub releases -- pinned versions,
# no Rust toolchain or from-source compile needed (that used to take 5-8 minutes
# per build). Bump MOQ_CLI_VERSION/MOQ_RELAY_VERSION deliberately, together with
# @moq/net/@moq/msf in package.json -- see CONTRIBUTING.md.
#
# The two URLs differ on purpose: newer release files have a "v" before the
# version (moq-cli-v0.10.0-...), older ones like moq-relay 0.14.5 don't.
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) ARCH=x86_64 ;; \
        arm64) ARCH=aarch64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/moq-dev/moq/releases/download/moq-cli-v${MOQ_CLI_VERSION}/moq-cli-v${MOQ_CLI_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz" \
        | tar xz -C /usr/local/bin --strip-components=2 "moq-cli-v${MOQ_CLI_VERSION}-${ARCH}-unknown-linux-gnu/bin/moq"; \
    curl -fsSL "https://github.com/moq-dev/moq/releases/download/moq-relay-v${MOQ_RELAY_VERSION}/moq-relay-${MOQ_RELAY_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz" \
        | tar xz -C /usr/local/bin --strip-components=2 "moq-relay-${MOQ_RELAY_VERSION}-${ARCH}-unknown-linux-gnu/bin/moq-relay"

# Builds the dashboard web UI (dashboard/) to static files. Only dist/ reaches the
# runtime image -- Vite, React, and node_modules stay in this stage. Its layers are
# cached, so this only re-runs when something under dashboard/ changes.
FROM node:24-slim AS dashboard

WORKDIR /dashboard
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY dashboard/ ./
RUN pnpm build

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/moq /usr/local/bin/moq
COPY --from=builder /usr/local/bin/moq-relay /usr/local/bin/moq-relay
COPY run-stream.sh /usr/local/bin/run-stream.sh
COPY lib/ /usr/local/bin/lib/
COPY ssai/ /usr/local/bin/ssai/
COPY csai/ /usr/local/bin/csai/
COPY dashboard/server/ /usr/local/bin/dashboard/server/
COPY --from=dashboard /dashboard/dist/ /usr/local/bin/dashboard/dist/
RUN chmod +x /usr/local/bin/run-stream.sh

ENTRYPOINT ["run-stream.sh"]
