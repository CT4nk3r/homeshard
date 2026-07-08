FROM rust:1.88-bookworm AS builder
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates/agent/Cargo.toml crates/agent/Cargo.toml
RUN mkdir -p crates/agent/src && printf "fn main() {}\n" > crates/agent/src/main.rs
RUN cargo build --release --package homeshard-agent
COPY crates/agent/src crates/agent/src
RUN touch crates/agent/src/main.rs \
  && cargo build --release --package homeshard-agent

FROM debian:bookworm-slim AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io gzip tar unzip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /source/target/release/homeshard-agent /usr/local/bin/homeshard-agent
ENTRYPOINT ["homeshard-agent"]
