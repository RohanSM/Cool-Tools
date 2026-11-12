/**
 * Cloudflare Pages entry point.
 *
 * Every request under `/api/…` lands here and is handed to the router in
 * `api/router.js`. Everything else is a static file from `site/`, which Pages
 * serves on its own — no function needed.
 */

import router from "../../api/router.js";

export const onRequest = (context) => router.fetch(context.request, context.env, context);
