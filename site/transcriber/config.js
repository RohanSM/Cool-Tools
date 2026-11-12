// Where the backend lives. Leave empty when the site and the Worker are on the
// same domain (the default when you deploy with `wrangler deploy`).
// If you host the page somewhere else (GitHub Pages, Netlify...), put the full
// Worker URL here, e.g. "https://transcriber.example.workers.dev".
window.TRANSCRIBE_CONFIG = {
  apiBase: "",
  maxUploadMb: 100,
};
