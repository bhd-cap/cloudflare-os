# BlackHawk OS in one container: the whole stack (router, workshop backend, every gatekeeper) on
# workerd, as `pnpm run-local` runs it. For demos and evaluation on a laptop or a single VM. A real
# deployment runs on Cloudflare instead; see docs/deploy.md.
#
#   docker compose up --build        then open http://localhost:8787
#
# See docs/container.md for configuration.

FROM node:24.19.0-bookworm-slim

# The slim image has no CA store, and workerd verifies outbound TLS (model providers, OAuth,
# connected services) against the system one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm at the version package.json pins.
RUN corepack enable

WORKDIR /app
COPY . .

# Everything run-local would otherwise do on first start, baked into the image so the container
# starts quickly and needs no registry access at runtime.
RUN pnpm install --frozen-lockfile \
 && pnpm exec vp run --cache @gadgets/typed-storage#build \
 && pnpm exec vp run --cache @gadgets/workshop-frontend#build:assets

# Users, workspaces, Gadgets and blueprints: everything wrangler dev persists. Mount a volume here
# to keep them across container restarts.
VOLUME /app/.wrangler/state

EXPOSE 8787

# run-local's server step, without its `pnpm install` and builds (done above), so a start needs no
# registry access. --ip 0.0.0.0: wrangler dev listens on localhost by default, which a published
# port cannot reach.
CMD ["node", "scripts/run-dev-server.ts", "--serve-frontend-assets", "--ip", "0.0.0.0"]
