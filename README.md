# Cool Tools

One site, several small tools. Today there is one: **Transcript Studio**, which
turns a video or audio file into a subtitle file.

Everything runs as a **single Cloudflare Worker**: it serves the hub page, every
tool's page, and every tool's API from one URL. You do not need Cloudflare Pages
or a second deployment when you add a tool.

```
browser ──upload──▶ Worker ──store──▶ R2
                       │
                       └── repository_dispatch ──▶ GitHub Actions
                                                       │ downloads + transcribes
                                                       ▼
                    browser ◀── poll ── Worker ◀── POST result ──┘
```

## Layout

```
site/                         the front end (plain HTML/CSS/JS, no build step)
  index.html                  hub — lists the tools
  styles.css                  shared styles
  transcriber/                one tool
    index.html
    app.js
    config.js                 apiBase ("" = same origin as the Worker)
worker/
  src/index.js                router: /api/<tool>/… and serves site/
  src/transcriber.js          the transcriber's API
  src/http.js                 shared JSON/CORS helpers
  wrangler.toml               Worker config + bindings
  package.json                npm run dev / deploy
transcribe/
  transcribe.py               Whisper pipeline
  requirements.txt
.github/workflows/
  transcribe.yml              the job that runs transcribe.py
```

URL map once deployed: `/` hub, `/transcriber/` the tool, `/api/transcriber/…`
its API, `/api/health` a status check.

---

# Setup, step by step

You need: a GitHub account, a Cloudflare account (free plan is fine), and
Node.js 20 or newer installed on your computer.

## Part 1 — Put the project on GitHub

1. Create a new repository. **Public is strongly recommended**: a private repo
   on the free plan has 2,000 Actions minutes a month, and one 10-minute video
   can burn several hundred of them. Public repos get unlimited minutes.

2. Upload this folder's contents to the repo root. The repo should end up with
   `site/`, `worker/`, `transcribe/`, `.github/`, `README.md` at the top level —
   **not** a folder named after this project containing those.

   - **Web upload:** in the empty repo, click *uploading an existing file*, then
     drag in the files and folders. On Windows, turn on *View → Show → Hidden
     items* first, otherwise `.github` and `.gitignore` are invisible and the
     workflow won't exist.
   - **Or with git**, from this folder:

     ```bash
     git init
     git add .
     git commit -m "Cool Tools: transcript tool"
     git branch -M main
     git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
     git push -u origin main
     ```

3. Open the repo's **Actions** tab and make sure workflows are enabled (GitHub
   shows an "I understand my workflows, go ahead and enable them" button for
   uploads done through the web UI). You should see **Transcribe** in the list.

## Part 2 — Create the GitHub token

This lets the Worker start a workflow run.

1. GitHub → your avatar → **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**.
2. *Repository access*: **Only select repositories** → pick your repo.
3. *Permissions → Repository permissions*: set **Contents** to **Read and
   write**. That's the one that matters — `repository_dispatch` is rejected
   without write access to Contents. (Classic tokens instead of fine-grained:
   the `repo` scope works.)
4. Generate and copy the token (`github_pat_…`). You'll paste it in Part 3, step 5.

## Part 3 — Deploy the Worker to Cloudflare

All commands run in the `worker/` folder.

```bash
cd worker
npm install              # installs wrangler locally
npx wrangler login       # opens the browser, pick your account
```

1. **Create the file bucket** (R2):

   ```bash
   npx wrangler r2 bucket create tool-uploads
   ```

   R2's free tier covers 10 GB of storage, which is plenty for this.

2. **Create the job store** (KV):

   ```bash
   npx wrangler kv namespace create JOBS
   ```

   It prints an `id = "…"`. Open `worker/wrangler.toml` and replace
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with that value.

3. **Point it at your repo.** In the same file, set:

   ```toml
   GITHUB_REPO = "YOUR-NAME/YOUR-REPO"
   ```

4. **Check the config** looks right:

   ```toml
   name = "cool-tools"          # becomes cool-tools.<you>.workers.dev
   main = "src/index.js"

   [assets]
   directory = "../site"        # the whole site is uploaded with the Worker

   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "tool-uploads"

   [[kv_namespaces]]
   binding = "JOBS"
   id = "…"

   [vars]
   GITHUB_REPO = "YOUR-NAME/YOUR-REPO"
   MAX_UPLOAD_MB = "100"
   ```

5. **Store the token as a secret** (paste it when prompted):

   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```

6. **Deploy:**

   ```bash
   npm run deploy
   ```

   Wrangler prints a URL like `https://cool-tools.YOUR-NAME.workers.dev`.
   The URL may differ from the `name` in the config if that name is taken —
   use whatever it prints.

7. **Test it.** Visit `https://YOUR-URL/api/health`. You should see:

   ```json
   { "ok": true, "tools": ["transcriber"], "repo": "YOUR-NAME/YOUR-REPO" }
   ```

   Then open the root URL, pick **Transcript Studio**, and upload a short clip.

Every later change: `npm run deploy` again. The site and the API deploy
together, so the hub, the tools, and their endpoints never drift apart.

## Running it locally

```bash
cd worker
npm install
npx wrangler dev
```

Open <http://localhost:8787>. To let it actually dispatch jobs, create
`worker/.dev.vars` (never commit it — `.gitignore` already excludes it):

```ini
GITHUB_TOKEN=github_pat_…
GITHUB_REPO=YOUR-NAME/YOUR-REPO
```

`wrangler dev` needs the KV id from Part 3 filled in. Local R2 and KV data is
fake and lives in `.wrangler/`, which is ignored.

**Do not open `site/index.html` by double-clicking it.** A `file://` page has no
server behind it, so the upload button fails by design; the site always has to be
loaded through the Worker URL or `localhost:8787`.

## Adding another tool later

1. Put its page in `site/<tool>/index.html` (link `../styles.css`).
2. Put its backend in `worker/src/<tool>.js`, exporting
   `export default { async fetch(request, env, ctx) { … } }`.
3. In `worker/src/index.js`, import it, route
   `/api/<tool>/…` to it, and add the name to `TOOLS`.
4. Add a card for it on the hub, `site/index.html`.
5. If it needs GitHub Actions, add `repository_dispatch` type to a workflow —
   `transcribe.yml` is the pattern.
6. `npm run deploy` once. Same URL, same bindings, same KV/R2.

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

- **100 MB per upload** (Cloudflare's request body cap on the free plan). Longer
  files are fine if they're compressed — audio-only MP3/M4A goes a long way.
- **Job timeout is 180 minutes**; the queue is GitHub Actions, so the first run
  of the day takes ~60–90 s longer while the model downloads.
- **A runner has no GPU.** On 4 CPU cores, Apex runs at roughly 2–4× realtime.
- Uploads and results are deleted after 24 hours (`JOB_TTL`).
- Rate limit: 20 uploads/hour per IP (`RATE_LIMIT` in `worker/src/transcriber.js`).
- If you ever host the pages somewhere other than this Worker, set `apiBase` in
  `site/transcriber/config.js` to the Worker URL.

## When something breaks

| What you see | Cause |
| --- | --- |
| "This page was opened as a file…" | You double-clicked `index.html`. Open the Worker URL instead. |
| "Nothing is answering at this address" | `wrangler dev` isn't running, or you opened the page on a different port than 8787 |
| "Server is not configured yet" | `GITHUB_TOKEN` or `GITHUB_REPO` is missing from the Worker |
| Upload works, job never starts | The token lacks **Contents: read & write**, or the repo name is wrong. Check the Worker's logs: `npm run tail` |
| Job sits in "Waiting in line" | Look at the repo's Actions tab — the run either failed or the workflow isn't on the default branch |

## Renaming

The site name "Cool Tools" appears in `site/index.html` and in the transcriber's
top bar (`site/transcriber/index.html`). The tool itself is "Transcript Studio"
in `site/transcriber/index.html`. The Worker name — and therefore the URL — is
`name` in `worker/wrangler.toml`.
