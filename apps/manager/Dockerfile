FROM node:24.22.2-alpine3.24 AS build
WORKDIR /app
COPY package.json yarn.lock ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/manager/package.json apps/manager/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
RUN yarn install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN yarn workspace @craftdock/protocol build \
  && yarn workspace @craftdock/shared build \
  && yarn workspace @craftdock/manager build

FROM node:24.22.2-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/manager/package.json apps/manager/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
RUN yarn install --production --frozen-lockfile --ignore-scripts
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/manager/dist apps/manager/dist
COPY --from=build /app/apps/manager/migrations apps/manager/migrations
COPY --from=build /app/apps/web/public apps/web/public
EXPOSE 4000
USER node
CMD ["node", "apps/manager/dist/index.js"]
