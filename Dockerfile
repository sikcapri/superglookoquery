# Not used to run the extension for real users — SuperGlookoQuery is a Claude
# Desktop extension (.mcpb), installed and launched by Claude Desktop itself,
# never via Docker (see README.md's "Installing it" / "Building the .mcpb
# yourself" sections). This Dockerfile exists purely so third-party MCP
# directory scanners (e.g. Glama) can build and start the server in an
# isolated container to verify it responds to MCP protocol introspection.
#
# With no GLOOKO_EMAIL/GLOOKO_PASSWORD set, the server runs in offline
# sample-data mode (see src/paths.js) — no credentials or network access
# needed to start and answer MCP requests over stdio.

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/server.js"]
