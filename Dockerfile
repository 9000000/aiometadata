# syntax=docker/dockerfile:1
# Stage 1: Build frontend and transpile backend TypeScript on native host platform (Fast, no QEMU emulation slowdown)
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/node:24-alpine AS builder
WORKDIR /app
COPY package*.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
COPY . .
RUN npm run build
RUN npm run build:backend
# Strip dev files (.map, .d.ts, .ts) not needed in production runtime
RUN find dist/server -type f \( -name "*.map" -o -name "*.d.ts" \) -delete && \
    find addon -type f -name "*.ts" -delete

# Stage 2: Runtime image for target platform
FROM mirror.gcr.io/library/node:24-alpine AS runner
WORKDIR /app
RUN apk add --no-cache ca-certificates wget
COPY package*.json package-lock.json* ./
# Install production dependencies only (frontend-only UI libs were moved to devDependencies)
# and prune doc, test, and type definition files from production node_modules
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev --no-audit --no-fund && \
    find node_modules -type f \( -name "*.md" -o -name "*.map" -o -name "*.d.ts" -o -name "*.ts" -o -name "LICENSE*" -o -name "CHANGELOG*" \) -delete && \
    find node_modules -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "example" -o -name "examples" -o -name "docs" \) -exec rm -rf {} + 2>/dev/null || true
COPY --from=builder /app/addon ./addon
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

ENV UV_THREADPOOL_SIZE=16
ENV DOTENV_CONFIG_QUIET=true

ARG PORT=3232
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3232}/health/live || exit 1'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

