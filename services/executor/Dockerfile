# Agentboard Skills executor: Node + Playwright's headless Chromium shell (no full browser, no X).
FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY src ./src
USER node
EXPOSE 10000
CMD ["node", "src/server.mjs"]
