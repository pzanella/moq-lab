FROM debian:bookworm-slim AS builder

ARG TARGETARCH
ARG MOQ_CLI_VERSION=0.9.5
ARG MOQ_RELAY_VERSION=0.14.5

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Prebuilt Linux binaries from moq-dev/moq's GitHub releases -- pinned versions,
# no Rust toolchain or from-source compile needed (that used to take 5-8 minutes
# per build). Bump MOQ_CLI_VERSION/MOQ_RELAY_VERSION deliberately, together with
# @moq/net/@moq/msf in package.json -- see CONTRIBUTING.md.
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) ARCH=x86_64 ;; \
        arm64) ARCH=aarch64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/moq-dev/moq/releases/download/moq-cli-v${MOQ_CLI_VERSION}/moq-cli-${MOQ_CLI_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz" \
        | tar xz -C /usr/local/bin --strip-components=2 "moq-cli-${MOQ_CLI_VERSION}-${ARCH}-unknown-linux-gnu/bin/moq"; \
    curl -fsSL "https://github.com/moq-dev/moq/releases/download/moq-relay-v${MOQ_RELAY_VERSION}/moq-relay-${MOQ_RELAY_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz" \
        | tar xz -C /usr/local/bin --strip-components=2 "moq-relay-${MOQ_RELAY_VERSION}-${ARCH}-unknown-linux-gnu/bin/moq-relay"

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
RUN chmod +x /usr/local/bin/run-stream.sh

ENTRYPOINT ["run-stream.sh"]
