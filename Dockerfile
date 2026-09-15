# Blockshop: the editor, the pack publisher and the BlockshopCatalog plugin jar in one image, meant to run as a
# service in the family server's compose stack (deploy/docker-compose.yml).
#
#   docker build -t ghcr.io/fdeantoni/blockshop .
#
# The build stages run on the builder's own platform: their output is JavaScript, static files and a jar.
# Only the last stage runs per target platform, because a production dependency ships native binaries.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/generator/package.json packages/generator/
COPY packages/server/package.json packages/server/
COPY packages/editor/package.json packages/editor/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The BlockshopCatalog Paper plugin (plugin/): the furniture menu, a Floodgate form on Bedrock.
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-25 AS plugin
WORKDIR /plugin
COPY plugin/pom.xml ./
RUN mvn -q -B dependency:resolve || true
COPY plugin/ ./
RUN mvn -q -B -DskipTests package

FROM node:22-alpine
# docker-cli only matters when JAVA_RESTART_COMMAND uses the host's Docker socket (see deploy/docker-compose.yml).
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/generator/package.json packages/generator/
COPY packages/server/package.json packages/server/
COPY packages/editor/package.json packages/editor/
RUN corepack enable \
 && pnpm install --prod --frozen-lockfile --filter @blockshop/server... \
 && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build /app/packages/schema/dist packages/schema/dist
COPY --from=build /app/packages/generator/dist packages/generator/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/editor/dist packages/editor/dist
COPY --from=plugin /plugin/target/BlockshopCatalog.jar plugin/BlockshopCatalog.jar
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# Paths inside the container, matching the mounts in deploy/docker-compose.yml; a compose file only sets what differs.
ENV NODE_ENV=production PORT=8081 HOST=0.0.0.0 DATA_DIR=/blockshop/data \
    CATALOG_JAR=/app/plugin/BlockshopCatalog.jar \
    JAVA_DEPLOY=on \
    CRAFTENGINE_DIR=/mc/plugins/CraftEngine \
    GEYSER_DIR=/mc/plugins/Geyser-Spigot \
    PLUGINS_DIR=/mc/plugins \
    MC_LOG_FILE=/mc/logs/latest.log \
    RCON_HOST=mc RCON_PORT=25575
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
EXPOSE 8081
VOLUME ["/blockshop/data"]
CMD ["node", "packages/server/dist/main.js"]
