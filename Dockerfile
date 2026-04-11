FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin/ ./bin/
COPY src/ ./src/
COPY templates/ ./templates/

EXPOSE 3030

CMD ["node", "bin/dev-panel.js", "serve", "--port", "3030", "--host", "0.0.0.0"]
