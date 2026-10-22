FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy root package files for workspace hoisting
COPY package.json pnpm-lock.yaml ./

# Install dependencies (root + web filter)
RUN npm install -g pnpm@12 && pnpm install --frozen-lockfile

# Copy app source
COPY apps/web ./apps/web

# Build the Next.js app (monorepo-aware)
RUN pnpm --filter @buildx/web build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache libstdc++

# Create non-root user (same as builder)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built output from builder (standalone output mode)
COPY --from=builder /app/apps/web/.next/standalone ./apps/web/.next
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json

# Set correct ownership
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the default Next.js port
EXPOSE 3000

# Start the app
CMD ["next", "start"]