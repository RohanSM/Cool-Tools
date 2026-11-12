/**
 * Transcript Studio API — mounted at /api/transcriber/ by api/router.js.
 *
 * Talks to GitHub Actions, which does the actual transcription:
 *
 *   browser ──POST /jobs────────────▶ Worker        (creates the job, no file yet)
 *   browser ──PUT  /jobs/:id/part/n─▶ Worker ──▶ KV (20 MB pieces, 24h TTL)
 *   browser ──POST /jobs/:id/start──▶ Worker ── repository_dispatch ──▶ GitHub Actions
 *                                                                          │
 *                                          downloads the pieces from KV ◀───┘
 *                                          runs transcribe.py
 *                                                      │
 *                       POST /api/transcriber/jobs/:id/complete
 *   browser ◀──poll──────────────── Worker ◀────────────┘
 *
 * Storage is KV only, because R2 needs a payment method on file even inside
 * its free allowance, while Workers KV is free without a card. KV values are
 * limited to 25 MiB, hence the pieces.
 *
 * Secrets/vars needed:  GITHUB_TOKEN, GITHUB_REPO  (see README)
 */

import { CORS, json } from "./http.js";

const API = "/api/transcriber";

const JOB_TTL = 60 * 60 * 24; // 24h
const RATE_LIMIT = 20; // jobs per hour per IP
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const PART_SIZE = 20 * 1024 * 1024; // under KV's 25 MiB value limit

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === `${API}/jobs` && request.method === "POST") {
        return await createJob(request, url, env);
      }

      const partMatch = path.match(new RegExp(`^${API}/jobs/([a-z0-9-]+)/part/(\\d{1,3})$`));
      if (partMatch && request.method === "PUT") {
        return await uploadPart(partMatch[1], Number(partMatch[2]), request, env);
      }

      const startMatch = path.match(new RegExp(`^${API}/jobs/([a-z0-9-]+)/start$`));
      if (startMatch && request.method === "POST") {
        return await startJob(startMatch[1], url, request, env);
      }

      const jobMatch = path.match(new RegExp(`^${API}/jobs/([a-z0-9-]+)$`));
      if (jobMatch && request.method === "GET") {
        return await getJob(jobMatch[1], env);
      }

      const sourceMatch = path.match(new RegExp(`^${API}/jobs/([a-z0-9-]+)/source$`));
      if (sourceMatch && request.method === "GET") {
        return await getSource(sourceMatch[1], url, env);
      }

      const completeMatch = path.match(new RegExp(`^${API}/jobs/([a-z0-9-]+)/complete$`));
      if (completeMatch && request.method === "POST") {
        return await completeJob(completeMatch[1], request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Something went wrong on our side.", detail: String(err && err.message) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* create a job — no file yet, the pieces follow                       */
/* ------------------------------------------------------------------ */

async function createJob(request, url, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: "Server is not configured yet (missing GitHub token or repo)." }, 500);
  }

  const language = url.searchParams.get("language") === "english" ? "english" : "hinglish";
  const filename = safeFilename(url.searchParams.get("filename") || "upload.mp3");
  const wordsPerLine = clampWords(url.searchParams.get("words"));
  const maxMb = Number(env.MAX_UPLOAD_MB || 100);
  const size = Number(url.searchParams.get("size")) || 0;

  if (!size) return json({ error: "The upload was empty." }, 400);
  if (size > maxMb * 1024 * 1024) {
    return json({ error: `That file is larger than ${maxMb} MB.` }, 413);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(ip, env)) {
    return json({ error: "Too many uploads from this connection. Please wait a bit." }, 429);
  }

  const id = newJobId();
  const parts = Math.ceil(size / PART_SIZE);

  const job = {
    id,
    status: "uploading",
    language,
    filename,
    wordsPerLine,
    size,
    parts,
    partSize: PART_SIZE,
    contentType: request.headers.get("content-type") || "application/octet-stream",
    createdAt: Date.now(),
    sourceToken: randomToken(24),
    uploadToken: randomToken(24),
    callbackToken: randomToken(32),
  };

  await saveJob(env, job);
  return json({ id, partSize: PART_SIZE, parts, uploadToken: job.uploadToken });
}

/* ------------------------------------------------------------------ */
/* upload the pieces                                                   */
/* ------------------------------------------------------------------ */

async function uploadPart(id, index, request, env) {
  const job = await loadJob(env, id);
  if (!job) return json({ error: "Unknown job" }, 404);
  if (job.status !== "uploading") return json({ error: "This upload is already finished." }, 409);
  if (!job.uploadToken || request.headers.get("x-upload-token") !== job.uploadToken) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!Number.isInteger(index) || index < 0 || index >= job.parts) {
    return json({ error: "Part out of range" }, 400);
  }
  if (!request.body) return json({ error: "Empty part" }, 400);

  const declared = Number(request.headers.get("content-length"));
  if (declared && declared > PART_SIZE) {
    return json({ error: "Part too large" }, 413);
  }

  await env.JOBS.put(partKey(id, index), request.body, {
    expirationTtl: JOB_TTL,
    metadata: { contentType: job.contentType },
  });

  return json({ ok: true, part: index });
}

async function startJob(id, url, request, env) {
  const job = await loadJob(env, id);
  if (!job) return json({ error: "Unknown job" }, 404);
  if (job.status === "queued" || job.status === "processing" || job.status === "done") {
    return json({ id: job.id, status: job.status });
  }
  if (job.status !== "uploading") return json({ error: `This job is ${job.status}.` }, 409);
  if (!job.uploadToken || request.headers.get("x-upload-token") !== job.uploadToken) {
    return json({ error: "Forbidden" }, 403);
  }

  const origin = url.origin;
  const payload = {
    jobId: id,
    language: job.language,
    wordsPerLine: job.wordsPerLine,
    filename: job.filename,
    parts: job.parts,
    sourceUrl: `${origin}${API}/jobs/${id}/source?token=${job.sourceToken}`,
    callbackUrl: `${origin}${API}/jobs/${id}/complete`,
    callbackToken: job.callbackToken,
  };

  const dispatched = await dispatch(env, payload);
  if (!dispatched.ok) {
    job.status = "failed";
    job.error = "We couldn't start the transcription engine. Please try again in a minute.";
    await saveJob(env, job);
    return json({ error: job.error }, 502);
  }

  job.status = "queued";
  job.queuedAt = Date.now();
  await saveJob(env, job);
  return json({ id: job.id, status: job.status });
}

async function dispatch(env, payload) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "transcript-studio-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "transcribe", client_payload: payload }),
  });
  return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
}

async function isRateLimited(ip, env) {
  const bucket = Math.floor(Date.now() / 3600000);
  const key = `rl:${ip}:${bucket}`;
  const current = Number((await env.JOBS.get(key)) || 0);
  if (current >= RATE_LIMIT) return true;
  await env.JOBS.put(key, String(current + 1), { expirationTtl: 3600 });
  return false;
}

/* ------------------------------------------------------------------ */
/* read a job                                                          */
/* ------------------------------------------------------------------ */

async function getJob(id, env) {
  const job = await loadJob(env, id);
  if (!job) return json({ error: "This job has expired or does not exist." }, 404);
  return json({
    id: job.id,
    status: job.status,
    language: job.language,
    filename: job.filename,
    wordsPerLine: job.wordsPerLine || 5,
    createdAt: job.createdAt,
    error: job.error || null,
    result: job.status === "done" ? job.result : null,
  });
}

/**
 * Without `part`, returns a manifest of how the pieces are laid out.
 * With `part=N`, returns that piece. The workflow stitches them together,
 * which keeps this Worker from ever holding the whole file in memory.
 */
async function getSource(id, url, env) {
  const job = await loadJob(env, id);
  if (!job) return new Response("Not found", { status: 404, headers: CORS });

  const token = url.searchParams.get("token") || "";
  if (!job.sourceToken || token !== job.sourceToken) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  const part = url.searchParams.get("part");
  if (part === null) {
    return new Response(
      JSON.stringify({
        parts: job.parts,
        size: job.size,
        filename: job.filename,
        contentType: job.contentType,
      }),
      { headers: { ...CORS, "content-type": "application/json; charset=utf-8" } }
    );
  }

  const index = Number(part);
  if (!Number.isInteger(index) || index < 0 || index >= job.parts) {
    return new Response("Part out of range", { status: 400, headers: CORS });
  }

  const { value, metadata } = await env.JOBS.getWithMetadata(partKey(id, index), { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404, headers: CORS });

  return new Response(value, {
    headers: {
      ...CORS,
      "content-type": (metadata && metadata.contentType) || job.contentType || "application/octet-stream",
      "content-length": String(value.byteLength),
    },
  });
}

/* ------------------------------------------------------------------ */
/* workflow callback                                                   */
/* ------------------------------------------------------------------ */

async function completeJob(id, request, env) {
  const job = await loadJob(env, id);
  if (!job) return json({ error: "Unknown job" }, 404);

  const token = request.headers.get("x-callback-token") || "";
  if (!job.callbackToken || token !== job.callbackToken) {
    return json({ error: "Forbidden" }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.status !== "string") {
    return json({ error: "Invalid payload" }, 400);
  }

  if (body.status === "processing") {
    job.status = "processing";
    job.startedAt = Date.now();
    await saveJob(env, job);
    return json({ ok: true });
  }

  if (body.status === "done") {
    const result = body.result || {};
    if (!result.srt) return json({ error: "Missing subtitles in payload" }, 400);
    const size = JSON.stringify(result).length;
    if (size > MAX_RESULT_BYTES) return json({ error: "Result too large" }, 413);

    job.status = "done";
    job.finishedAt = Date.now();
    job.result = {
      srt: result.srt,
      wordsSrt: result.wordsSrt || "",
      text: result.text || "",
      words: Array.isArray(result.words) ? result.words : [],
      duration: Number(result.duration) || 0,
      model: result.model || "",
    };
    await saveJob(env, job);
    await dropParts(env, job);
    return json({ ok: true });
  }

  job.status = "failed";
  job.error = body.error || "Transcription failed.";
  job.finishedAt = Date.now();
  await saveJob(env, job);
  await dropParts(env, job);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function loadJob(env, id) {
  const raw = await env.JOBS.get(`job:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveJob(env, job) {
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
}

function partKey(id, index) {
  return `src:${id}:${index}`;
}

/** Delete the uploaded pieces once they're no longer needed. */
async function dropParts(env, job) {
  const count = job.parts || 0;
  for (let i = 0; i < count; i++) {
    await env.JOBS.delete(partKey(job.id, i)).catch(() => {});
  }
}

function newJobId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clampWords(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 10);
}

function safeFilename(name) {
  const cleaned = String(name)
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "-")
    .slice(-80);
  return cleaned || "upload.mp3";
}
