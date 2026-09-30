# https://yon.meo.in.th static site. No dependencies beyond Bun itself.
# public/ is the site/ that `bun run build:link` builds (uploaded by
# .github/workflows/website.yml next to this file).
FROM oven/bun:1.4-alpine
WORKDIR /app
COPY serve.ts ./
COPY public/ ./public/
USER bun
ENV PORT=8788
EXPOSE 8788
CMD ["bun", "run", "serve.ts"]
