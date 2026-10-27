# FRIDAY One realtime gateway — Cloud Run image (decision D3).
#
# Deploy with exactly ONE instance: routing and replay state live in process
# memory (see docs/DEPLOYMENT.md for the full `gcloud run deploy` command).
# Firestore and Firebase Auth are reached with the Cloud Run runtime service
# account; no key file is copied into the image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
