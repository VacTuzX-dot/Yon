# Yon Link relay (ADR-003). No dependencies beyond Bun itself.
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY relay.ts ./
USER bun
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "relay.ts"]
