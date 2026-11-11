# The MCP server over HTTP in a container. Build from the repo root:
#   docker build -f scripts/Dockerfile -t kariaa-agents .
FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY scripts/tsconfig.build.json ./scripts/tsconfig.build.json
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/cli/index.js", "serve", "--host", "0.0.0.0"]
