/**
 * One Worker for the whole site: the tool hub at `/`, each tool's pages under
 * `/<tool>/`, and each tool's API under `/api/<tool>/`.
 *
 * Adding a tool:
 *   1. put its page in `site/<tool>/`
 *   2. put its backend in `worker/src/<tool>.js`, exporting a default `fetch(request, env, ctx)`
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
      return json({ ok: true, tools: TOOLS, repo: env.GITHUB_REPO || null });
    }

    if (url.pathname.startsWith("/api/transcriber/")) {
      return transcriber.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    // Everything else is the static site: hub at /, tools at /<tool>/.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
