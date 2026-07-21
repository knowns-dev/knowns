# syntax=docker/dockerfile:1.7

ARG GO_VERSION=1.24.2
ARG BUN_IMAGE=oven/bun:1-debian
ARG NODE_IMAGE=node:20-bookworm-slim
ARG DOTNET_IMAGE=mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim
ARG TERRAFORM_IMAGE=hashicorp/terraform:1.14.6
ARG ORT_VERSION=1.25.0
ARG GOPLS_VERSION=v0.20.0

FROM ${BUN_IMAGE} AS bun-source
FROM ${DOTNET_IMAGE} AS dotnet-source
FROM ${TERRAFORM_IMAGE} AS terraform-source

FROM golang:${GO_VERSION}-bookworm AS builder
ARG VERSION=dev-docker
ARG TARGETARCH
ARG ORT_VERSION
ARG GOPLS_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    make \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
  for attempt in 1 2 3 4 5; do \
    go mod download && exit 0; \
    sleep $((attempt * 5)); \
  done; \
  go mod download

RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  mkdir -p /out \
  && for attempt in 1 2 3 4 5; do \
    GOBIN=/out go install golang.org/x/tools/gopls@${GOPLS_VERSION} && exit 0; \
    sleep $((attempt * 5)); \
  done; \
  GOBIN=/out go install golang.org/x/tools/gopls@${GOPLS_VERSION}

COPY . ./

RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  --mount=type=cache,target=/root/.bun/install/cache \
  make all VERSION=${VERSION} \
  && cp bin/knowns /out/knowns \
  && go test -c -o /out/lspfixtures.test ./tests/lspfixtures

RUN set -eux; \
  build_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "${build_arch}" in \
    amd64|x86_64) ort_arch="x64" ;; \
    arm64|aarch64) ort_arch="aarch64" ;; \
    *) echo "unsupported ONNX Runtime Linux arch: ${build_arch}" >&2; exit 1 ;; \
  esac; \
  archive="onnxruntime-linux-${ort_arch}-${ORT_VERSION}.tgz"; \
  base_url="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}"; \
  curl -fsSL --retry 5 --retry-delay 5 -o "/tmp/${archive}" "${base_url}/${archive}"; \
  tar -xzf "/tmp/${archive}" -C /tmp; \
  cp "/tmp/onnxruntime-linux-${ort_arch}-${ORT_VERSION}/lib/libonnxruntime.so.${ORT_VERSION}" /out/libonnxruntime.so; \
  rm -rf "/tmp/${archive}" "/tmp/onnxruntime-linux-${ort_arch}-${ORT_VERSION}"

FROM ${NODE_IMAGE} AS runtime-base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    jq \
    libgomp1 \
    libicu72 \
    libstdc++6 \
    procps \
    python3 \
    tini \
    zsh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=dotnet-source /usr/share/dotnet /usr/share/dotnet
RUN ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1

RUN for attempt in 1 2 3 4 5; do \
    npm install -g typescript typescript-language-server \
      && npm cache clean --force \
      && exit 0; \
    sleep $((attempt * 5)); \
  done; \
  npm install -g typescript typescript-language-server \
  && npm cache clean --force

RUN useradd --create-home --shell /usr/bin/zsh knowns \
  && mkdir -p /opt/knowns/bin /workspace \
  && chown -R knowns:knowns /opt/knowns /workspace

RUN for attempt in 1 2 3 4 5; do \
    dotnet tool install --tool-path /opt/knowns/bin csharp-ls-vs --version 1.2.5 \
      && ln -sf /opt/knowns/bin/csharp-ls-vs /opt/knowns/bin/csharp-ls \
      && exit 0; \
    sleep $((attempt * 5)); \
  done; \
  dotnet tool install --tool-path /opt/knowns/bin csharp-ls-vs --version 1.2.5 \
  && ln -sf /opt/knowns/bin/csharp-ls-vs /opt/knowns/bin/csharp-ls

COPY --from=builder /out/knowns /opt/knowns/bin/knowns
COPY --from=builder /out/gopls /opt/knowns/bin/gopls
COPY --from=builder /out/libonnxruntime.so /opt/knowns/bin/libonnxruntime.so
COPY tests/runtime-docker/smoke.zsh /opt/knowns/smoke.zsh
COPY tests/runtime-docker/project_stress.zsh /opt/knowns/project_stress.zsh
COPY tests/runtime-docker/mcp_stress.py /opt/knowns/mcp_stress.py

RUN chmod +x /opt/knowns/bin/knowns /opt/knowns/bin/gopls /opt/knowns/smoke.zsh /opt/knowns/project_stress.zsh /opt/knowns/mcp_stress.py \
  && printf 'export PATH=/opt/knowns/bin:$PATH\n' > /home/knowns/.zprofile \
  && chown knowns:knowns /home/knowns/.zprofile

ENV HOME=/home/knowns
ENV SHELL=/usr/bin/zsh
ENV PATH=/opt/knowns/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV NO_COLOR=1
ENV NO_UPDATE_CHECK=1

USER knowns
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/zsh", "-l", "/opt/knowns/smoke.zsh"]

FROM runtime-base AS lsp-fixtures

COPY --from=terraform-source /bin/terraform /usr/local/bin/terraform
COPY --from=builder --chown=knowns:knowns /out/lspfixtures.test /opt/knowns/bin/lspfixtures.test
COPY --chown=knowns:knowns tests/runtime-docker/lsp_fixtures.zsh /opt/knowns/lsp_fixtures.zsh

RUN chmod +x /opt/knowns/bin/lspfixtures.test /opt/knowns/lsp_fixtures.zsh \
  && for language in markdown bash json terraform yaml; do \
    /opt/knowns/bin/knowns lsp install "${language}"; \
  done \
  && /opt/knowns/bin/knowns lsp list --json >/tmp/knowns-lsp-status.json \
  && jq -e '\
    [.[] | select(.id == "markdown" or .id == "bash" or .id == "json" or .id == "terraform" or .id == "yaml")] as $rows \
    | ($rows | length) == 5 \
      and all($rows[]; \
        .install_state == "installed" \
        and .requested_version == "recommended" \
        and (.resolved_version | type == "string" and length > 0) \
        and (.source_location | type == "string" and length > 0) \
        and (.integrity | type == "string" and length > 0) \
        and (.selected_path | type == "string" and length > 0) \
        and .verified == true)\
  ' /tmp/knowns-lsp-status.json >/dev/null \
  && rm -f /tmp/knowns-lsp-status.json

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/zsh", "-l", "/opt/knowns/lsp_fixtures.zsh"]

FROM runtime-base AS runtime
