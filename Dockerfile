FROM rust:1-bookworm AS builder

# cmake/clang are required to build aws-lc-rs, the rustls crypto backend moq-cli/moq-relay use
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake clang libclang-dev perl pkg-config && \
    rm -rf /var/lib/apt/lists/*

RUN cargo install moq-cli moq-relay

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/cargo/bin/moq /usr/local/bin/moq
COPY --from=builder /usr/local/cargo/bin/moq-relay /usr/local/bin/moq-relay
COPY run-stream.sh /usr/local/bin/run-stream.sh
COPY lib/ /usr/local/bin/lib/
COPY ssai/ /usr/local/bin/ssai/
COPY csai/ /usr/local/bin/csai/
RUN chmod +x /usr/local/bin/run-stream.sh

ENTRYPOINT ["run-stream.sh"]
