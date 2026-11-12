(() => {
  "use strict";

  const CFG = window.TRANSCRIBE_CONFIG || {};
  const API = (CFG.apiBase || "").replace(/\/+$/, "");
  const MAX_MB = CFG.maxUploadMb || 100;
  const POLL_MS = 3500;

  const $ = (id) => document.getElementById(id);

  const el = {
    dropzone: $("dropzone"),
    fileInput: $("fileInput"),
    fileChip: $("fileChip"),
    fileName: $("fileName"),
    fileSize: $("fileSize"),
    clearFile: $("clearFile"),
    uploadPanel: $("uploadPanel"),
    languageOptions: $("languageOptions"),
    timingOptions: $("timingOptions"),
    wordsStep: $("wordsStep"),
    wordsOptions: $("wordsOptions"),
    wordsHint: $("wordsHint"),
    submitBtn: $("submitBtn"),
    progressPanel: $("progressPanel"),
    progressTitle: $("progressTitle"),
    progressSub: $("progressSub"),
    barFill: $("barFill"),
    spinner: $("spinner"),
    stages: $("stages"),
    elapsed: $("elapsed"),
    cancelBtn: $("cancelBtn"),
    resultPanel: $("resultPanel"),
    resultMeta: $("resultMeta"),
    playerHolder: $("playerHolder"),
    transcriptView: $("transcriptView"),
    newFileBtn: $("newFileBtn"),
    copyBtn: $("copyBtn"),
    dlSrt: $("dlSrt"),
    dlWords: $("dlWords"),
    dlTxt: $("dlTxt"),
    errorPanel: $("errorPanel"),
    errorText: $("errorText"),
    retryBtn: $("retryBtn"),
  };

  const state = {
    file: null,
    language: "hinglish",
    timing: "line",
    view: "line",
    wordsPerLine: 5,
    jobId: null,
    result: null,
    objectUrl: null,
    pollTimer: null,
    tickTimer: null,
    startedAt: 0,
    cancelRequested: false,
    media: null,
    activeSegment: -1,
  };

  /* ---------------- helpers ---------------- */

  const fmtSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const fmtClock = (secs) => {
    const s = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  };

  const baseName = () => {
    const n = state.file ? state.file.name : "transcript";
    return n.replace(/\.[^.]+$/, "").replace(/[^\w\-\s]/g, "").trim() || "transcript";
  };

  let toastTimer;
  function toast(msg) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), 2200);
  }

  function showPanel(which) {
    el.uploadPanel.hidden = which !== "upload";
    el.progressPanel.hidden = which !== "progress";
    el.resultPanel.hidden = which !== "result";
    el.errorPanel.hidden = which !== "error";
  }

  /* ---------------- file picking ---------------- */

  function isMedia(file) {
    const okType = /^(video|audio)\//.test(file.type);
    const okExt = /\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name);
    return okType || okExt;
  }

  function setFile(file) {
    if (!file) return;
    if (!isMedia(file)) {
      toast("That file isn't a video or audio file.");
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      toast(`That file is ${fmtSize(file.size)} — the limit is ${MAX_MB} MB.`);
      return;
    }
    state.file = file;
    el.fileName.textContent = file.name;
    el.fileSize.textContent = fmtSize(file.size);
    el.fileChip.hidden = false;
    el.dropzone.hidden = true;
    el.submitBtn.disabled = false;
  }

  function clearFile() {
    state.file = null;
    el.fileInput.value = "";
    el.fileChip.hidden = true;
    el.dropzone.hidden = false;
    el.submitBtn.disabled = true;
  }

  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener("change", (e) => setFile(e.target.files[0]));
  el.clearFile.addEventListener("click", clearFile);

  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("is-drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("is-drag");
    })
  );
  el.dropzone.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!el.uploadPanel.hidden && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  /* ---------------- option controls ---------------- */

  function wireSegmented(container, key, onChange, asNumber = false) {
    container.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg");
      if (!btn) return;
      [...container.querySelectorAll(".seg")].forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
      });
      state[key] = asNumber ? Number(btn.dataset.value) : btn.dataset.value;
      if (onChange) onChange(state[key]);
    });
  }

  function updateWordsHint() {
    const count = state.wordsPerLine;
    if (state.timing === "word") {
      el.wordsHint.textContent =
        `Not needed here — every word is timed on its own. Your line-by-line file still uses ${count} word${count === 1 ? "" : "s"} per line.`;
      return;
    }
    el.wordsHint.textContent = count === 1
      ? "One word per line — the tightest timing. Lines still break early on a comma or full stop."
      : `A new line starts every ${count} words, and lines still end on a comma or full stop whenever one is nearby.`;
  }

  function setWordsEnabled(enabled) {
    el.wordsStep.classList.toggle("is-disabled", !enabled);
    el.wordsOptions.setAttribute("aria-disabled", String(!enabled));
    [...el.wordsOptions.querySelectorAll(".seg")].forEach((b) => { b.disabled = !enabled; });
    updateWordsHint();
  }

  wireSegmented(el.languageOptions, "language");
  wireSegmented(el.wordsOptions, "wordsPerLine", updateWordsHint, true);
  wireSegmented(el.timingOptions, "timing", (value) => {
    state.view = value;
    setWordsEnabled(value !== "word");
    if (state.result) {
      syncTabs();
      renderTranscript();
    }
  });
  setWordsEnabled(state.timing !== "word");

  /* ---------------- upload ---------------- */

  function upload() {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({
        language: state.language,
        filename: state.file.name,
        size: String(state.file.size),
        words: String(state.wordsPerLine),
      });

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}/api/transcriber/jobs?${query}`);
      xhr.setRequestHeader("content-type", state.file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = e.loaded / e.total;
        el.barFill.style.width = `${Math.max(3, pct * 100)}%`;
        el.progressTitle.textContent = `Uploading your file… ${Math.round(pct * 100)}%`;
      };
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (_) {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.id) resolve(body);
        else reject(new Error((body && body.error) || describeStatus(xhr.status)));
      };
      xhr.onerror = () => reject(new Error(unreachableMessage()));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      xhr.send(state.file);
    });
  }

  function unreachableMessage() {
    if (location.protocol === "file:") {
      return "This page was opened as a file, so there's no server behind the button. Open the app's own address instead — the Worker URL after deploying, or http://localhost:8787 while running it locally.";
    }
    if (!API && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.port !== "8787") {
      return "This page is being served by something other than the app, so the button has nothing to call. Run `wrangler dev` in the worker folder and open http://localhost:8787.";
    }
    if (!API && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      return "The Worker has stopped answering. Check the `wrangler dev` terminal for the error, then reload this page.";
    }
    return "We couldn't reach the server. Check your connection and try again in a moment.";
  }

  function describeStatus(code) {
    if (code === 413) return "That file is too large for the server.";
    if (code === 429) return "Too many requests right now. Wait a minute and try again.";
    if (code === 0) return "We couldn't reach the server.";
    return `The server returned an error (${code}).`;
  }

  /* ---------------- progress ---------------- */

  const STAGES = ["upload", "queue", "work", "done"];

  function markStage(stage) {
    const idx = STAGES.indexOf(stage);
    [...el.stages.querySelectorAll("li")].forEach((li, i) => {
      li.classList.toggle("is-done", i < idx || stage === "done");
      li.classList.toggle("is-current", i === idx && stage !== "done");
    });
  }

  function startClock() {
    state.startedAt = Date.now();
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
      const secs = (Date.now() - state.startedAt) / 1000;
      el.elapsed.textContent = secs < 5 ? "Just started" : `${fmtClock(secs)} so far`;
    }, 1000);
  }

  function stopClock() {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }

  /* ---------------- job flow ---------------- */

  async function startJob() {
    if (!state.file) return;
    state.cancelRequested = false;
    state.result = null;
    showPanel("progress");
    el.submitBtn.disabled = true;
    el.progressTitle.textContent = "Uploading your file…";
    el.progressSub.textContent = "Keep this tab open and we'll tell you the moment it's ready.";
    el.barFill.classList.remove("is-indeterminate");
    el.barFill.style.width = "3%";
    markStage("upload");
    startClock();

    try {
      const job = await upload();
      state.jobId = job.id;
      markStage("queue");
      el.progressTitle.textContent = "Waiting in line…";
      el.progressSub.textContent = "We're starting up the transcription engine. This usually takes under a minute.";
      el.barFill.classList.add("is-indeterminate");
      poll();
    } catch (err) {
      stopClock();
      if (state.cancelRequested) {
        resetToUpload();
        return;
      }
      fail(err.message);
    }
  }

  function poll() {
    clearTimeout(state.pollTimer);
    const tick = async () => {
      if (state.cancelRequested) return;
      try {
        const res = await fetch(`${API}/api/transcriber/jobs/${state.jobId}`);
        if (!res.ok) throw new Error(describeStatus(res.status));
        const job = await res.json();

        if (job.status === "processing") {
          markStage("work");
          el.progressTitle.textContent = "Listening and writing…";
          el.progressSub.textContent = "Longer files take a little longer. You can leave this tab open.";
        }
        if (job.status === "done" && job.result) {
          finish(job);
          return;
        }
        if (job.status === "failed") {
          throw new Error(job.error || "The transcription failed. Try a shorter or clearer file.");
        }
        state.pollTimer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (state.cancelRequested) return;
        stopClock();
        fail(err.message);
      }
    };
    tick();
  }

  function finish(job) {
    stopClock();
    state.result = job.result;
    state.segments = buildSegments(job.result);
    state.view = state.timing;
    markStage("done");
    el.barFill.classList.remove("is-indeterminate");
    el.barFill.style.width = "100%";
    el.progressTitle.textContent = "Ready!";
    setTimeout(() => {
      showPanel("result");
      buildPlayer();
      syncTabs();
      renderTranscript();
      renderMeta(job);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 420);
  }

  function fail(message) {
    stopClock();
    clearTimeout(state.pollTimer);
    el.errorText.textContent = message;
    showPanel("error");
    el.submitBtn.disabled = false;
  }

  function resetToUpload() {
    stopClock();
    clearTimeout(state.pollTimer);
    state.cancelRequested = true;
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    state.jobId = null;
    state.result = null;
    state.segments = null;
    state.media = null;
    el.playerHolder.innerHTML = "";
    showPanel("upload");
    el.submitBtn.disabled = !state.file;
  }

  el.submitBtn.addEventListener("click", startJob);
  el.cancelBtn.addEventListener("click", () => {
    state.cancelRequested = true;
    resetToUpload();
    toast("Stopped. You can pick that file again any time.");
  });
  el.retryBtn.addEventListener("click", () => {
    if (state.jobId) {
      showPanel("progress");
      startClock();
      poll();
    } else {
      resetToUpload();
    }
  });
  el.newFileBtn.addEventListener("click", () => {
    resetToUpload();
    clearFile();
  });

  /* ---------------- player ---------------- */

  function buildPlayer() {
    if (!state.file) return;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(state.file);

    const isVideo = /^video\//.test(state.file.type) || /\.(mp4|mov|mkv|webm|avi)$/i.test(state.file.name);
    const m = document.createElement(isVideo ? "video" : "audio");
    m.src = state.objectUrl;
    m.controls = true;
    m.preload = "metadata";
    if (isVideo) m.playsInline = true;
    state.media = m;
    el.playerHolder.innerHTML = "";
    el.playerHolder.appendChild(m);

    m.addEventListener("timeupdate", highlightAtTime);
    m.addEventListener("seeked", highlightAtTime);
  }

  function segments() {
    return state.segments || [];
  }

  function highlightAtTime() {
    const m = state.media;
    if (!m || !state.segments) return;
    const t = m.currentTime;
    let idx = -1;
    for (let i = 0; i < state.segments.length; i++) {
      const s = state.segments[i];
      if (t >= s.start && t < s.end) {
        idx = i;
        break;
      }
    }
    if (idx === state.activeSegment) return;
    state.activeSegment = idx;

    el.transcriptView.querySelectorAll(".is-playing").forEach((n) => n.classList.remove("is-playing"));
    if (idx < 0) return;
    if (state.view === "line") {
      const node = el.transcriptView.querySelector(`.line[data-i="${idx}"]`);
      if (node) {
        node.classList.add("is-playing");
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } else {
      const words = state.segments[idx].words || [];
      words.forEach((_, wi) => {
        const node = el.transcriptView.querySelector(`.w[data-i="${idx}-${wi}"]`);
        if (node) node.classList.add("is-playing");
      });
    }
  }

  function seekTo(seconds) {
    if (!state.media) return;
    state.media.currentTime = seconds;
    const p = state.media.play();
    if (p && p.catch) p.catch(() => {});
  }

  /* ---------------- rendering ---------------- */

  function renderMeta(job) {
    const r = job.result;
    const lines = segments().length;
    const dur = r.duration ? `${fmtClock(r.duration)} of audio` : "";
    const lang = (job.language || state.language) === "hinglish" ? "Hinglish" : "English";
    const parts = [lang, `${lines} ${lines === 1 ? "line" : "lines"}`, dur].filter(Boolean);
    el.resultMeta.textContent = parts.join(" · ");
  }

  function syncTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      const on = tab.dataset.view === state.view;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    });
  }

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      syncTabs();
      renderTranscript();
    })
  );

  function renderTranscript() {
    const segs = segments();
    if (!segs.length) {
      el.transcriptView.innerHTML = '<p style="padding:16px;color:#75717f">No speech was found in that file.</p>';
      return;
    }
    if (state.view === "word") {
      el.transcriptView.innerHTML = segs
        .map(
          (s, i) => `<span class="word-line" data-i="${i}">${(s.words || [])
            .map(
              (w, wi) =>
                `<span class="w" data-t="${fmtClock(w.start)}" data-i="${i}-${wi}" data-s="${w.start}">${escapeHtml(
                  w.text
                )}</span>`
            )
            .join(" ")}</span>`
        )
        .join("");
    } else {
      el.transcriptView.innerHTML = segs
        .map(
          (s, i) => `<div class="line" data-i="${i}" data-s="${s.start}">
            <span class="t">${fmtClock(s.start)}</span>
            <span class="txt">${escapeHtml(s.text)}</span>
          </div>`
        )
        .join("");
    }
    state.activeSegment = -1;
  }

  el.transcriptView.addEventListener("click", (e) => {
    const target = e.target.closest("[data-s]");
    if (!target) return;
    seekTo(parseFloat(target.dataset.s));
  });

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- segment building from SRT ---------------- */

  function parseSrt(text) {
    const out = [];
    const blocks = String(text || "")
      .replace(/\r/g, "")
      .split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length < 2) continue;
      const timeLine = lines.find((l) => l.includes("-->"));
      if (!timeLine) continue;
      const [a, b] = timeLine.split("-->").map((s) => s.trim());
      const start = srtTime(a);
      const end = srtTime(b);
      const body = lines
        .slice(lines.indexOf(timeLine) + 1)
        .join(" ")
        .trim();
      if (!body) continue;
      out.push({ start, end, text: body });
    }
    return out;
  }

  function srtTime(str) {
    const m = str.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }

  function buildSegments(result) {
    const lines = parseSrt(result.srt || "");
    const words = (result.words || []).map((w) => ({
      text: w.w || w.text || "",
      start: Number(w.s ?? w.start) || 0,
      end: Number(w.e ?? w.end) || 0,
    }));

    // Attach words to the line they fall inside, so the word view keeps line breaks.
    if (words.length) {
      lines.forEach((line) => {
        line.words = words.filter((w) => w.start >= line.start - 0.15 && w.start < line.end + 0.15);
      });
      // Any word not covered by a line (rounding gaps) goes to the nearest one.
      const loose = words.filter((w) => !lines.some((l) => l.words.includes(w)));
      loose.forEach((w) => {
        let best = 0;
        let dist = Infinity;
        lines.forEach((l, i) => {
          const d = Math.min(Math.abs(w.start - l.start), Math.abs(w.start - l.end));
          if (d < dist) {
            dist = d;
            best = i;
          }
        });
        if (lines[best]) lines[best].words.push(w);
      });
      lines.forEach((l) => {
        l.words.sort((x, y) => x.start - y.start);
        if (!l.words.length) l.words = [{ text: l.text, start: l.start, end: l.end }];
      });
    } else {
      lines.forEach((l) => {
        l.words = l.text.split(/\s+/).map((t) => ({ text: t, start: l.start, end: l.end }));
      });
    }
    return lines;
  }

  /* ---------------- downloads ---------------- */

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Downloaded " + filename);
  }

  el.dlSrt.addEventListener("click", () => {
    if (!state.result) return;
    download(state.result.srt, `${baseName()}.srt`, "application/x-subrip;charset=utf-8");
  });
  el.dlWords.addEventListener("click", () => {
    if (!state.result) return;
    download(state.result.wordsSrt || state.result.srt, `${baseName()}-words.srt`, "application/x-subrip;charset=utf-8");
  });
  el.dlTxt.addEventListener("click", () => {
    if (!state.result) return;
    const text = state.result.text || segments().map((s) => s.text).join("\n");
    download(text, `${baseName()}.txt`, "text/plain;charset=utf-8");
  });

  el.copyBtn.addEventListener("click", async () => {
    const text = state.result ? state.result.text || segments().map((s) => s.text).join("\n") : "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Transcript copied");
    } catch (_) {
      toast("Couldn't copy — select the text instead.");
    }
  });

  /* ---------------- boot ---------------- */

  showPanel("upload");
})();
