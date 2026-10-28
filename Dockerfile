# The tag mirrors .bun-version: the image runs the Bun that CI installs.
FROM oven/bun:1.4.4-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
# tsconfig.json stays: Bun reads the decorator settings from it at run time.
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
