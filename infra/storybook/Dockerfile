FROM node:20-slim

WORKDIR /app

# Install storybook deps once, cached in the image layer.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Minimal storybook config — stories come from a mounted volume at /stories.
COPY .storybook ./.storybook
COPY index.html ./
COPY app.css ./app.css

# Create the mount point so storybook's glob resolves to an existing dir
# even before the sync user has written anything.
RUN mkdir -p /stories && chown -R node:node /stories /app

USER node

EXPOSE 6006

# Dev mode so new stories in /stories are picked up on reload — no rebuild.
CMD ["npm", "run", "storybook"]
