# Yon Link relay (ADR-003). No dependencies beyond Bun itself.
FROM oven/bun:1.3-alpine
WORKDIR /app
# check.ts is the deploy smoke test (run from this image, never by the relay).
COPY relay.ts check.ts ./
USER bun
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "relay.ts"]
