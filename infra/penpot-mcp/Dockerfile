FROM node:22-slim AS builder

RUN npm install -g pnpm@10

WORKDIR /app
RUN npm pack @penpot/mcp@2.14.1 && \
    tar xzf penpot-mcp-2.14.1.tgz && \
    cd package && \
    pnpm -r install && \
    PENPOT_MCP_WEBSOCKET_URL=wss://penpot-mcp.devpanl.dev pnpm run build

FROM node:22-slim

WORKDIR /app
COPY --from=builder /app/package /app

WORKDIR /app/packages/server
EXPOSE 4401 4402
CMD ["node", "dist/index.js"]
