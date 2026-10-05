# Wellows Initial Website Audit - portable image with Chromium included.
# The Playwright image tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.56.0-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.56.0-noble
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    CHROMIUM_NO_SANDBOX=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
# Never run the auditor as root. The worker only needs outbound internet; give it no route to internal networks.
USER pwuser
# No VOLUME instruction: some hosts (Railway) reject it. Mount persistent storage at /data on the platform.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
