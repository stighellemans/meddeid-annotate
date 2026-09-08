FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_WORKSPACE_ANNOTATE_URL
ARG VITE_WORKSPACE_COMPANION_URL
ARG VITE_WORKSPACE_CURATE_URL
ARG VITE_WORKSPACE_SUBANNOTATE_URL
RUN VITE_WORKSPACE_ANNOTATE_URL="$VITE_WORKSPACE_ANNOTATE_URL" VITE_WORKSPACE_COMPANION_URL="$VITE_WORKSPACE_COMPANION_URL" VITE_WORKSPACE_CURATE_URL="$VITE_WORKSPACE_CURATE_URL" VITE_WORKSPACE_SUBANNOTATE_URL="$VITE_WORKSPACE_SUBANNOTATE_URL" npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
COPY server ./server
COPY contracts ./contracts
COPY config ./config
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "server/index.js"]
