FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb x11vnc openbox novnc websockify \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --ignore-scripts

COPY src ./src
COPY scripts ./scripts
RUN chmod +x ./scripts/*.sh && mkdir -p /data

EXPOSE 8788

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "src/server.mjs"]
