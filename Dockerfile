FROM node:24-bookworm-slim AS web
WORKDIR /build/frontend
COPY frontend/package*.json ./
COPY frontend/vendor ./vendor
RUN npm ci
COPY frontend ./
RUN npm run build
FROM rust:1.94-bookworm AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
COPY --from=web /build/frontend/dist ./frontend/dist
RUN cargo build --locked --release
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home hub && mkdir /data && chown hub:hub /data
COPY --from=server /build/target/release/gotty-hub /usr/local/bin/gotty-hub
COPY --from=web /build/frontend/dist /app/frontend/dist
WORKDIR /app
USER hub
ENV HUB_LISTEN=0.0.0.0:8088 HUB_HOME=/data
EXPOSE 8088
VOLUME ["/data"]
CMD ["gotty-hub", "serve"]
