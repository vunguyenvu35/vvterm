# syntax=docker/dockerfile:1.7
#
# VVTerm is a desktop (Wails) application, so these images are for CI and development, not for
# running the GUI:
#   go-test / web-test  run the test suites in a clean, reproducible environment
#   demoserver          the demo SSH server used by the E2E walkthrough and manual testing
#   git-remote          a throw-away Git remote to try the sync feature (dev only, no auth)
# The macOS app itself is built and shipped with scripts/deploy.sh.

ARG GO_VERSION=1.26
ARG NODE_VERSION=22

# ---------- frontend ----------
FROM node:${NODE_VERSION}-bookworm-slim AS web-deps
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM web-deps AS web-test
COPY frontend/ ./
RUN npx tsc --noEmit && npx vitest run

FROM web-deps AS web-build
COPY frontend/ ./
RUN npm run build

# ---------- Go ----------
FROM golang:${GO_VERSION}-bookworm AS go-base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# The main package needs the GTK/WebKit toolchain on Linux, so tests and vet cover everything else.
FROM go-base AS go-test
ENV CGO_ENABLED=1
RUN go vet ./internal/... ./app/... ./cmd/... \
 && go test -race -count=1 -cover ./internal/... ./app/...

FROM go-base AS demoserver-build
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w" -o /out/demoserver ./cmd/demoserver \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot AS demoserver
COPY --from=demoserver-build /out/demoserver /demoserver
# the empty, nonroot-owned /data lets a named volume persist the host key across restarts
COPY --from=demoserver-build --chown=65532:65532 /out/data /data
USER 65532:65532
EXPOSE 2222
ENTRYPOINT ["/demoserver"]
CMD ["-addr", "0.0.0.0:2222", "-hostkey", "/data/hostkey"]

FROM alpine:3.20 AS git-remote
RUN apk add --no-cache git git-daemon
COPY deploy/docker/git-remote.sh /usr/local/bin/git-remote.sh
RUN adduser -D -u 1000 git && mkdir -p /srv/git && chown git:git /srv/git
USER git
EXPOSE 9418
VOLUME /srv/git
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD git ls-remote git://127.0.0.1/vvterm-sync.git >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/git-remote.sh"]
