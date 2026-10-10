# ReferralDesk (fictional demonstration CRM). Dependencies are installed at
# build time; the running containers have no route off the internal network.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY referraldesk ./referraldesk
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:22-slim
ARG BUILD_SHA=unversioned
ENV NODE_ENV=production BUILD_SHA=${BUILD_SHA}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
