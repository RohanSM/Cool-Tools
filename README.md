# Cool Tools

One site, several small tools. Today there is one: **Transcript Studio**, which
turns a video or audio file into a subtitle file.

Everything runs as **one Cloudflare Pages project** at
`https://coolaitools.pages.dev`: Pages serves the hub, each tool's page, and
runs the API in `functions/`. One project, one address, no server to babysit.

```
browser ──upload in 20 MB pieces──▶ Pages Function ──store──▶ KV (free tier)
                                         │
                                         └── repository_dispatch ──▶ GitHub Actions
                                                                        │ download + stitch
                                                                        │ transcribe
                                                                        ▼
                                    browser ◀── poll ── API ◀── POST result ──┘
```

**No R2, no card.** R2 asks for a payment method even inside its free allowance,
so the upload is kept in Workers KV instead, in pieces of up to 20 MB (KV caps a
single value at 25 MB). Pages, Functions, KV and GitHub Actions all have
genuinely card-free tiers.

## Layout

```
site/                         the front end (plain HTML/CSS/JS, no build step)
  index.html                  hub — lists the tools
  styles.css                  shared styles
  transcriber/                one tool
    index.html
    app.js
    config.js                 apiBase ("" = same origin as the site)
functions/
  api/[[path]].js             Pages entry: every /api/… request starts here
api/                          the server-side code
  router.js                   sends /api/<tool>/… to the right tool
  transcriber.js              the transcriber's API
  http.js                     shared JSON/CORS helpers
transcribe/
  transcribe.py               Whisper pipeline
  requirements.txt
.github/workflows/
  transcribe.yml              the job that runs transcribe.py
wrangler.toml                 Pages project config + KV binding + vars
package.json                  npm run dev / deploy
```

URL map once deployed: `/` hub, `/transcriber/` the tool, `/api/transcriber/…`
its API, `/api/health` a status check.

---

# Setup, step by step

You need: a GitHub account, a Cloudflare account (free plan is fine), and
Node.js 20 or newer installed on your computer.

## Part 1 — The GitHub repo

Already done: <https://github.com/RohanSM/Cool-Tools>. It must stay **public**
so Actions minutes are free.

The workflow at `.github/workflows/transcribe.yml` is what actually transcribes,
so check the repo's **Actions** tab lists **Transcribe**. If it doesn't, the
workflow file didn't upload (turn on *View → Show → Hidden items* on Windows and
upload `.github/` again).

## Part 2 — Create the GitHub token

This lets the site start a workflow run.

1. GitHub → your avatar → **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**.
2. *Repository access*: **Only select repositories** → `RohanSM/Cool-Tools`.
3. *Permissions → Repository permissions*: set **Contents** to **Read and
   write**. That's the one that matters — `repository_dispatch` is rejected
   without write access to Contents. (A classic token with the `repo` scope also
   works.)
4. Generate and copy the token (`github_pat_…`). You'll paste it in Part 3.

## Part 3 — Deploy to Cloudflare Pages

All commands run in the project folder (where `wrangler.toml` lives).

```bash
npm install              # installs wrangler locally
npx wrangler login       # opens the browser, pick your account
```

1. **Create the store** (KV) — free, no card:

   ```bash
   npx wrangler kv namespace create JOBS
   ```

   It prints an `id = "…"`. Open `wrangler.toml` and replace
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with that value.

2. **Create the Pages project:**

   ```bash
   npx wrangler pages project create coolaitools --production-branch main
   ```

   `coolaitools` becomes `coolaitools.pages.dev`. If the name is taken,
   Cloudflare says so — pick another and change `name =` in `wrangler.toml` to
   match, since the address follows the project name.

3. **Store the token as a secret** (paste it when prompted):

   ```bash
   npx wrangler pages secret put GITHUB_TOKEN --project-name coolaitools
   ```

4. **Check `wrangler.toml`** — it should read:

   ```toml
   name = "coolaitools"                 # the pages.dev address
   pages_build_output_dir = "site"      # everything in site/ is the website
   compatibility_date = "2025-10-01"

   [[kv_namespaces]]
   binding = "JOBS"
   id = "…"

   [vars]
   GITHUB_REPO = "RohanSM/Cool-Tools"
   MAX_UPLOAD_MB = "100"
   ```

5. **Deploy:**

   ```bash
   npm run deploy
   ```

   It prints the live address, normally `https://coolaitools.pages.dev`.

6. **Test it.** Visit `https://coolaitools.pages.dev/api/health`:

   ```json
   { "ok": true, "tools": ["transcriber"], "repo": "RohanSM/Cool-Tools" }
   ```

   Then open the root address, pick **Transcript Studio**, and upload a short
   clip.

Every later change: `npm run deploy` again. Pages replaces the whole site and
the API together, so they never drift apart.

If `/api/health` 500s or says the server isn't configured, the secret or the
`GITHUB_REPO` var didn't land. Check **Pages → coolaitools → Settings →
Variables and secrets**, and the KV binding under **Settings → Functions**.

## Running it locally

```bash
npm install
npm run dev            # wrangler pages dev
```

Open <http://localhost:8788>. Pages serves `site/`, runs `functions/`, and gives
the API a local KV store, so uploads really work without touching production.

To let local runs dispatch real jobs, create `.dev.vars` in the project folder
(never commit it — `.gitignore` already excludes it):

```ini
GITHUB_TOKEN=github_pat_…
GITHUB_REPO=RohanSM/Cool-Tools
```

**Do not open `site/index.html` by double-clicking it.** A `file://` page has no
server behind it, so the upload button fails by design; the site always has to be
served — `npm run dev`, or the deployed address.

## Adding another tool later

1. Put its page in `site/<tool>/index.html` (link `../styles.css`).
2. Put its backend in `api/<tool>.js`, exporting
   `export default { async fetch(request, env, ctx) { … } }`.
3. In `api/router.js`, import it, route `/api/<tool>/…` to it, and add the name
   to `TOOLS`.
4. Add a card for it on the hub, `site/index.html`.
5. If it needs GitHub Actions, add a workflow with a `repository_dispatch` type
   — `transcribe.yml` is the pattern.
6. `npm run deploy` once. Same address, same bindings, same KV.

---

# The transcription pipeline

`transcribe/transcribe.py` is a Colab pipeline made headless:

1. **ffmpeg** → 16 kHz mono with `highpass=f=80,loudnorm`.
2. **Silero VAD** finds speech and groups it into pieces of up to 18 s, cut at
   pauses. Long stretches of continuous talking are force-split at the quietest
   nearby moment.
3. **Whisper** transcribes each piece, batch by batch.
4. Words are grouped into lines of the size chosen on the site (default 5). If a
   comma or full stop sits before the last word of a line, that last word moves
   down so the line ends on the punctuation. Without word timings, cuts are
   estimated by line length and snapped to the quietest point within ±0.5 s.
5. Three identical pieces in a row are dropped — that's Whisper looping.

The same call also requests **word timestamps**, which is what the word-by-word
view and `words.srt` use. If a model or transformers version can't return them,
timing falls back to the length-plus-pause estimator, so output always exists.

Run it without the site:

```bash
pip install -r transcribe/requirements.txt   # plus ffmpeg on PATH
python transcribe/transcribe.py --input sample.mp4 --language hinglish --outdir out
```

Outputs land in `out/` as `transcript.srt`, `words.srt`, `transcript.txt`,
`words.json`.

Tuning knobs are constants near the top of the file:

| Constant | Default | Effect |
| --- | --- | --- |
| `BEAMS` (env) | `1` | Accuracy vs. speed. Colab used 5 on a GPU; each extra beam is roughly one extra pass, so 5 on a CPU runner is ~5× slower |
| `BATCH` (env) | `8` | Pieces per forward pass |
| `CHUNK_MAX` | `18.0` | Longest audio piece (hard cap 25 s, Whisper's window) |
| `CHUNK_MIN` | `8.0` | A pause only ends a piece once it's this long |
| `WORDS_PER_LINE` (env) | `5` | Fallback when the page doesn't send a choice; users pick 1–5 on the site (up to 10 is accepted) |
| `SNAP` | `0.5` | How far a cut can move to land on a pause |

Model choices are at the top of the file:

- **Hinglish** → `Oriserve/Whisper-Hindi2Hinglish-Apex` (large-v3-turbo, 0.8B —
  good speed/quality). Set `HINGLISH_MODEL=Oriserve/Whisper-Hindi2Hinglish-Prime`
  for the 2B model and better accuracy, at roughly 2–3× the runtime.
- **English** → `openai/whisper-small`. Bump to `openai/whisper-medium` or
  `large-v3` for accuracy if you don't mind slower jobs.

Both are asked for `language="en"`, because the Oriserve models were trained to
emit romanised Hinglish under the English token.

## Limits and notes

- **100 MB per upload**, sent as pieces of 20 MB or less. Longer files are fine
  if they're compressed — audio-only MP3/M4A goes a long way.
- **Free KV limits:** 1 GB stored, 1,000 writes and 100,000 reads a day. A 100 MB
  upload costs about 7 writes, so roughly 140 uploads a day fit; storage caps out
  around 10 files in flight, and everything expires after 24 hours anyway.
- **Job timeout is 180 minutes**; the queue is GitHub Actions, so the first run
  of the day takes ~60–90 s longer while the model downloads.
- **A runner has no GPU.** On 4 CPU cores, Apex runs at roughly 2–4× realtime.
- Uploads and results are deleted after 24 hours (`JOB_TTL`), and the pieces are
  deleted the moment a transcript comes back.
- Rate limit: 20 uploads/hour per IP (`RATE_LIMIT` in `api/transcriber.js`).
- If you ever host the pages somewhere other than this project, set `apiBase` in
  `site/transcriber/config.js` to the API address.

## When something breaks

| What you see | Cause |
| --- | --- |
| "This page was opened as a file…" | You double-clicked `index.html`. Use `npm run dev` or the live address. |
| "Nothing is answering at this address" | `npm run dev` isn't running, or the page is on a port other than 8788 |
| "Server is not configured yet" | `GITHUB_TOKEN` or `GITHUB_REPO` is missing from the Pages project |
| Upload works, job never starts | The token lacks **Contents: read & write**, or `GITHUB_REPO` is wrong. Check the logs: `npm run tail` |
| Job sits in "Waiting in line" | Look at the repo's Actions tab — the run either failed or the workflow isn't on the default branch |
| Job fails at "Fetch the uploaded file" | The KV pieces never became readable. Re-run the job from the Actions tab; KV can take up to a minute to show a fresh upload |
| 404 on any page | `pages_build_output_dir` in `wrangler.toml` must be `site`, and the folder must contain `index.html` |

## Renaming

The site name "Cool Tools" appears in `site/index.html` and in the transcriber's
top bar (`site/transcriber/index.html`). The tool itself is "Transcript Studio"
in `site/transcriber/index.html`. The project name — and therefore the
`pages.dev` address — is `name` in `wrangler.toml`; changing it needs a new
`wrangler pages project create`.
