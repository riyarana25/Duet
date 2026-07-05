/**
 * Dev entrypoint: serve the built browser editor (public/) AND the WebSocket sync server on
 * one HTTP server / one port. Open http://localhost:9000 in two tabs to collaborate.
 *
 * Build the browser bundle first: `npm run build:web` (writes public/bundle.js).
 *
 * Reads config (PORT, ANTHROPIC_API_KEY) from the environment; a local .env is loaded
 * automatically via dotenv. See .env.example.
 */
import "dotenv/config";
import { createServer } from "http";
import { promises as fs } from "fs";
import * as path from "path";
import { startServer } from "./wsServer";
import { AnthropicAIService } from "../ai/anthropicService";

const port = Number(process.env.PORT ?? 9000);
const publicDir = path.join(__dirname, "..", "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const http = createServer(async (req, res) => {
  // Tiny static file server for public/. Ignores anything with '..' (no traversal).
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (rel.includes("..")) {
    res.writeHead(400).end("bad request");
    return;
  }
  try {
    const file = path.join(publicDir, rel);
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type":
        CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const ai = process.env.ANTHROPIC_API_KEY ? new AnthropicAIService() : undefined;

http.listen(port, () => {
  void startServer(port, { server: http, ai }).then(() => {
    // eslint-disable-next-line no-console
    console.log(
      `editor on http://localhost:${port}` +
        (ai
          ? " (AI assist enabled)"
          : " (AI assist disabled — set ANTHROPIC_API_KEY)"),
    );
  });
});
