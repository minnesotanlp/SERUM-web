// SERUM-live frontend — vanilla JS, no build step.
// Talks to the SERUM-job-api via the public ngrok tunnel.

(function () {
  "use strict";

  // Configurable. To switch tunnels, just edit this constant or add ?api=<url>
  // to the page URL for one-off testing.
  const DEFAULT_API_BASE = "https://serum-live.ngrok.app";
  const apiBase = (() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get("api") || DEFAULT_API_BASE).replace(/\/$/, "");
  })();
  const SCHEMA_VERSION = 1;

  const $ = (id) => document.getElementById(id);

  const els = {
    library: $("live-library"),
    ytUrl: $("live-yt-url"),
    submit: $("live-submit"),
    error: $("live-error"),
    statusIdle: $("live-status-idle"),
    statusActive: $("live-status-active"),
    stateBadge: $("live-state-badge"),
    stateDetail: $("live-state-detail"),
    progress: $("live-progress-bar"),
    meta: $("live-meta"),
    streamWrap: $("live-stream-wrap"),
    stream: $("live-stream"),
    newestBtn: $("live-newest"),
    newestCount: $("live-newest-count"),
  };

  let evtSource = null;
  let userScrolledAway = false;
  let pendingNewItems = 0;
  let renderedFrames = new Set();

  // Scroll detection — visitor-controlled scroll per design lock E1
  els.stream.addEventListener("scroll", () => {
    const atTop = els.stream.scrollTop < 8;
    if (atTop) {
      userScrolledAway = false;
      pendingNewItems = 0;
      els.newestBtn.classList.add("hidden");
    } else {
      userScrolledAway = true;
    }
  });

  els.newestBtn.addEventListener("click", () => {
    els.stream.scrollTo({ top: 0, behavior: "smooth" });
    userScrolledAway = false;
    pendingNewItems = 0;
    els.newestBtn.classList.add("hidden");
  });

  // Populate library dropdown on page load
  (async function loadLibrary() {
    try {
      const resp = await fetch(`${apiBase}/library`, { method: "GET" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.schema_version && data.schema_version !== SCHEMA_VERSION) {
        showSchemaMismatch();
        return;
      }
      for (const v of data.videos || []) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `${v.title} (${v.category}, ~${v.duration_min} min)`;
        els.library.appendChild(opt);
      }
    } catch (e) {
      console.warn("library load failed:", e);
      // Don't block page; user can still paste a YouTube URL
    }
  })();

  function showSchemaMismatch() {
    els.error.textContent =
      "Live demo is being updated — refresh in a moment.";
    els.error.classList.remove("hidden");
    els.submit.disabled = true;
  }

  els.submit.addEventListener("click", async () => {
    els.error.classList.add("hidden");
    const libVid = els.library.value.trim();
    const ytUrl = els.ytUrl.value.trim();

    let body;
    if (libVid) {
      body = { source: "library", video_id: libVid };
    } else if (ytUrl) {
      if (!/^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(ytUrl)) {
        showError("That doesn't look like a YouTube URL.");
        return;
      }
      body = { source: "youtube", url: ytUrl };
    } else {
      showError("Pick a library video or paste a YouTube URL.");
      return;
    }

    els.submit.disabled = true;
    els.submit.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Submitting…';

    try {
      const resp = await fetch(`${apiBase}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        const msg = errBody.detail || `HTTP ${resp.status}`;
        if (resp.status === 429) {
          showError(`Rate limited: ${msg}`);
        } else if (resp.status === 503) {
          showError(`Server busy: ${msg}`);
        } else {
          showError(msg);
        }
        return;
      }
      const data = await resp.json();
      startStreaming(data.job_id);
    } catch (e) {
      showError(`Submission failed: ${e.message}`);
    } finally {
      els.submit.disabled = false;
      els.submit.innerHTML = '<i class="fa-solid fa-bolt"></i> Run SERUM';
    }
  });

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  }

  function startStreaming(jobId) {
    // Reset UI
    if (evtSource) evtSource.close();
    els.statusIdle.classList.add("hidden");
    els.statusActive.classList.remove("hidden");
    els.streamWrap.classList.remove("hidden");
    els.stream.innerHTML = "";
    renderedFrames = new Set();
    userScrolledAway = false;
    pendingNewItems = 0;
    els.newestBtn.classList.add("hidden");

    setStatusBadge("queued", "Submitting your job…");

    const url = `${apiBase}/jobs/${jobId}/stream`;
    evtSource = new EventSource(url);

    evtSource.addEventListener("status", (e) => {
      try {
        const status = JSON.parse(e.data);
        renderStatus(jobId, status);
      } catch (err) {
        console.warn("parse error:", err);
      }
    });

    evtSource.addEventListener("error", (e) => {
      // EventSource auto-reconnects on network drops; only handle terminal cases here
      if (evtSource.readyState === EventSource.CLOSED) {
        setStatusBadge("disconnected", "Stream closed.");
      }
    });
  }

  function renderStatus(jobId, status) {
    const state = status.state || "unknown";

    if (status.schema_version && status.schema_version !== SCHEMA_VERSION) {
      showSchemaMismatch();
      if (evtSource) evtSource.close();
      return;
    }

    setStatusBadge(state, statusDetail(status));
    setProgress(status);
    setMeta(status);

    if (Array.isArray(status.recent_states)) {
      mergeRecentStates(jobId, status.recent_states);
    }

    if (state === "complete" || state === "failed") {
      if (evtSource) evtSource.close();
      if (state === "failed") {
        setStatusBadge("failed", status.error || "Job failed");
      }
    }
  }

  function setStatusBadge(state, detail) {
    const colors = {
      queued: "bg-amber-100 text-amber-800",
      starting: "bg-amber-100 text-amber-800",
      extracting: "bg-amber-100 text-amber-800",
      extracted: "bg-amber-100 text-amber-800",
      running: "bg-indigo-100 text-indigo-800",
      complete: "bg-emerald-100 text-emerald-800",
      failed: "bg-rose-100 text-rose-800",
      disconnected: "bg-slate-200 text-slate-700",
    };
    els.stateBadge.className = `pill ${colors[state] || colors.disconnected}`;
    els.stateBadge.textContent = state;
    els.stateDetail.textContent = detail || "";
  }

  function statusDetail(status) {
    if (status.state === "queued") {
      return status.queue_position ? `position #${status.queue_position}` : "";
    }
    if (status.state === "running" && status.current_pass != null) {
      return `pass ${status.current_pass}/${status.total_passes || 12}`;
    }
    if (status.state === "complete") {
      return `done · ${status.passes_complete || 0} passes`;
    }
    return "";
  }

  function setProgress(status) {
    let pct = 0;
    if (status.state === "complete") pct = 100;
    else if (status.state === "running") {
      const p = (status.passes_complete || status.current_pass || 0);
      const total = status.total_passes || 12;
      pct = Math.min(100, Math.round((p / total) * 100));
    } else if (status.state === "extracted") pct = 5;
    else if (status.state === "extracting") pct = 2;
    els.progress.style.width = `${pct}%`;
  }

  function setMeta(status) {
    const parts = [];
    if (status.title) parts.push(`<strong>${escapeHtml(status.title)}</strong>`);
    if (status.n_frames) parts.push(`${status.n_frames} frames (~${(status.duration_s / 60).toFixed(1)} min)`);
    if (status.source) parts.push(`source: ${status.source}`);
    els.meta.innerHTML = parts.join(" · ");
  }

  function mergeRecentStates(jobId, states) {
    let added = 0;
    // Newest first; render in reverse so newest ends up at the top
    const fragment = document.createDocumentFragment();
    for (let i = states.length - 1; i >= 0; i--) {
      const s = states[i];
      const key = `${s.frame_ts}::${s.pass}::${s.pass_type}`;
      if (renderedFrames.has(key)) continue;
      renderedFrames.add(key);
      fragment.prepend(renderStateRow(jobId, s));
      added++;
    }
    if (!added) return;
    els.stream.prepend(fragment);
    if (userScrolledAway) {
      pendingNewItems += added;
      els.newestCount.textContent = pendingNewItems;
      els.newestBtn.classList.remove("hidden");
    }
  }

  function renderStateRow(jobId, s) {
    const row = document.createElement("div");
    row.className = "flex items-start gap-3 p-3";
    const thumbUrl = `${apiBase}/jobs/${jobId}/frames/${s.frame_ts}.jpg`;
    const passLabel = `P${s.pass}${s.pass_type ? ' · ' + s.pass_type : ''}`;
    const conf = s.confidence != null ? `${s.confidence}/10` : "";
    row.innerHTML = `
      <img src="${thumbUrl}" alt="frame" class="w-20 h-12 object-cover rounded border border-slate-200 flex-shrink-0"
           onerror="this.style.display='none'">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-mono text-slate-500">${s.frame_ts}</span>
          <span class="text-xs text-indigo-600 font-medium">${passLabel}</span>
          ${conf ? `<span class="text-xs text-slate-500">${conf}</span>` : ""}
        </div>
        <div class="text-sm text-slate-800 break-words">${escapeHtml(s.state || "—")}</div>
      </div>`;
    return row;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(String(s)));
    return div.innerHTML;
  }
})();
