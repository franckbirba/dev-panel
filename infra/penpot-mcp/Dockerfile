FROM node:22-slim AS builder

RUN npm install -g pnpm@10

WORKDIR /app
RUN npm pack @penpot/mcp@2.14.1 && \
    tar xzf penpot-mcp-2.14.1.tgz && \
    cd package && \
    pnpm -r install && \
    WS_URI=wss://penpot-mcp.devpanl.dev pnpm run build

FROM node:22-slim

WORKDIR /app
COPY --from=builder /app/package /app

# Serve plugin static files at root with CORS — Penpot resolves manifest "code" relative to origin
RUN sed -i 's|this.setupHttpEndpoints();|this.setupHttpEndpoints();\
    const path = await import("path");\
    const pluginDir = path.resolve("/app/packages/plugin/dist");\
    const corsPlugin = (req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Methods", "GET, OPTIONS"); res.header("Access-Control-Allow-Headers", "*"); if (req.method === "OPTIONS") return res.sendStatus(204); next(); };\
    this.app.use(corsPlugin, express2.static(pluginDir));\
    this.logger.info("Serving plugin files from " + pluginDir + " at /");|' \
    /app/packages/server/dist/index.js

WORKDIR /app/packages/server
EXPOSE 4401 4402
CMD ["node", "dist/index.js"]
