# syntax=docker/dockerfile:1.7
# Builds the self-contained linux-x64 SEA binary for postman-bootstrap.
# The @postman private-scope npm token is needed ONLY here, at build time, to
# resolve dependencies. It is passed as a buildx secret and never persisted in
# an image layer. The finished binary bundles every dependency plus the Node
# runtime, so the consumer needs no npm, no Node, and no token.

FROM --platform=linux/amd64 node:24-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS build

WORKDIR /app

# Build as the unprivileged 'node' user the image ships (uid 1000), never root,
# so a compromised install step cannot act with root privileges in the build.
RUN chown node:node /app
USER node

# Manifest first for a cached dependency layer.
COPY --chown=node:node package.json package-lock.json ./

# Install with the private-scope token mounted as a secret file. It is read into
# an env var only for this RUN; .npmrc holds just a ${NPM_TOKEN} placeholder that
# npm expands at read time, and it is removed in the same layer. So neither the
# raw token nor a populated .npmrc is baked into any image layer.
RUN --mount=type=secret,id=npmtoken,uid=1000 \
    export NPM_TOKEN="$(cat /run/secrets/npmtoken)" && \
    printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

# Source plus the SEA build recipe.
COPY --chown=node:node . .

RUN bash scripts/build-sea.sh

# Export only the finished binary (version in the filename; wildcard so the
# stage does not hardcode it).
FROM scratch AS artifact
COPY --from=build /app/build/sea/postman-bootstrap-*-linux-x64 /
