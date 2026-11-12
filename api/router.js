/**
 * API router for the whole site: each tool's API lives under `/api/<tool>/`.
 * Reached through `functions/api/[[path]].js`; pages themselves are static
 * files in `site/`, served by Cloudflare Pages directly.
 *
 * Adding a tool:
 *   1. put its page in `site/<tool>/`
 *   2. put its backend in `api/<tool>.js`, exporting a default `fetch(request, env, ctx)`
 *   3. import it here and route `/api/<tool>/...` to it
 *   4. add a card on the hub (`site/index.html`)
 */

import transcriber from "./transcriber.js";
import { json, preflight } from "./http.js";

const TOOLS = ["transcriber"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight();

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        tools: TOOLS,
        repo: env.GITHUB_REPO || null,
        storage: !!env.JOBS,
        github: !!env.GITHUB_TOKEN,
      });
    }

    if (url.pathname.startsWith("/api/transcriber/")) {
      return transcriber.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    // Only /api/* reaches this function, so anything else is a bug.
    return new Response("Not found", { status: 404 });
  },
};
