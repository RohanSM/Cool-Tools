/**
 * Transcript Studio API — mounted at /api/transcriber/ by worker/src/index.js.
 *
 * Talks to GitHub Actions, which does the actual transcription:
 *
 *   browser ──upload──▶ Worker ──store──▶ R2
 *                          │
 *                          └── repository_dispatch ──▶ GitHub Actions
 *                                                          │
 *                                    downloads file from R2│
 *                                    runs transcribe.py    │
 *                                                          ▼
 *                                 POST /api/transcriber/jobs/:id/complete
 *   browser ◀──poll── Worker ◀──────────────────────────────┘
 *
 * Secrets/vars needed:  GITHUB_TOKEN, GITHUB_REPO  (see README)
 */

import { CORS, json } from "./http.js";

const API = "/api/transcriber";

const JOB_TTL = 60 * 60 * 24; // 24h
const RATE_LIMIT = 20; // jobs per hour per IP
const MAX_RESULT_BYTES = 20 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === `${API}/jobs` && request.method === "POST") {
        return await createJob(request, url, env);
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
/* create a job                                                        */
/* ------------------------------------------------------------------ */

async function createJob(request, url, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: "Server is not configured yet (missing GitHub token or repo)." }, 500);
  }

  const language = url.searchParams.get("language") === "english" ? "english" : "hinglish";
  const filename = safeFilename(url.searchParams.get("filename") || "upload.mp3");
  const wordsPerLine = clampWords(url.searchParams.get("words"));
  const maxMb = Number(env.MAX_UPLOAD_MB || 100);
  const size =
    Number(request.headers.get("content-length")) || Number(url.searchParams.get("size")) || 0;

  if (!size) return json({ error: "The upload was empty." }, 400);
  if (size > maxMb * 1024 * 1024) {
    return json({ error: `That file is larger than ${maxMb} MB.` }, 413);
  }
  if (!request.body) return json({ error: "No file received." }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(ip, env)) {
    return json({ error: "Too many uploads from this connection. Please wait a bit." }, 429);
  }

  const id = newJobId();
  const sourceKey = `uploads/${id}/${filename}`;
  const sourceToken = randomToken(24);
  const callbackToken = randomToken(32);
  const contentType = request.headers.get("content-type") || "application/octet-stream";

  await env.BUCKET.put(sourceKey, request.body, {
    httpMetadata: { contentType, contentDisposition: `attachment; filename="${filename}"` },
  });

  const job = {
    id,
    status: "queued",
    language,
    filename,
    wordsPerLine,
    size,
    createdAt: Date.now(),
    sourceKey,
    sourceToken,
    callbackToken,
  };

  const origin = url.origin;
  const payload = {
    jobId: id,
    language,
    wordsPerLine,
    sourceUrl: `${origin}${API}/jobs/${id}/source?token=${sourceToken}`,
    callbackUrl: `${origin}${API}/jobs/${id}/complete`,
    callbackToken,
  };

  const dispatched = await dispatch(env, payload);
  if (!dispatched.ok) {
    job.status = "failed";
    job.error = "We couldn't start the transcription engine. Please try again in a minute.";
    await saveJob(env, job);
    return json({ error: job.error }, 502);
  }

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
  const raw = await env.JOBS.get(`job:${id}`);
  if (!raw) return json({ error: "This job has expired or does not exist." }, 404);
  const job = JSON.parse(raw);
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

async function getSource(id, url, env) {
  const raw = await env.JOBS.get(`job:${id}`);
  if (!raw) return new Response("Not found", { status: 404 });
  const job = JSON.parse(raw);
  const token = url.searchParams.get("token") || "";
  if (!job.sourceToken || token !== job.sourceToken) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }
  const object = await env.BUCKET.get(job.sourceKey);
  if (!object) return new Response("Not found", { status: 404, headers: CORS });
  return new Response(object.body, {
    headers: {
      ...CORS,
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "content-length": String(object.size),
    },
  });
}

/* ------------------------------------------------------------------ */
/* workflow callback                                                   */
/* ------------------------------------------------------------------ */

async function completeJob(id, request, env) {
  const raw = await env.JOBS.get(`job:${id}`);
  if (!raw) return json({ error: "Unknown job" }, 404);
  const job = JSON.parse(raw);

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

    // The source file is no longer needed once we have the transcript.
    if (job.sourceKey) await env.BUCKET.delete(job.sourceKey).catch(() => {});
    return json({ ok: true });
  }

  job.status = "failed";
  job.error = body.error || "Transcription failed.";
  job.finishedAt = Date.now();
  await saveJob(env, job);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function saveJob(env, job) {
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
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
