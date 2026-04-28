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
    queueCard: $("live-queue-card"),
    queuePos: $("live-queue-pos"),
    queueDetail: $("live-queue-detail"),
    queueDots: $("live-queue-dots"),
    playerWrap: $("live-player-wrap"),
    player: $("live-player"),
    timelineTrack: $("live-timeline-track"),
    timelineBars: $("live-timeline-bars"),
    timelineEnd: $("live-timeline-end"),
    pairLabel: $("live-pair-label"),
    framePrev: $("live-frame-prev"),
    frameNext: $("live-frame-next"),
    framePosition: $("live-frame-position"),
    frameLabel: $("live-frame-label"),
    streamWrap: $("live-stream-wrap"),
    stream: $("live-stream"),
    newestBtn: $("live-newest"),
    newestCount: $("live-newest-count"),
  };

  let evtSource = null;
  let userScrolledAway = false;
  let pendingNewItems = 0;
  let renderedFrames = new Set();

  // Library cache so we can look up duration_min etc. when submitting.
  const libraryById = new Map();

  // Per-job timeline state — rebuilt on every new submission.
  let jobMeta = null;       // { jobId, source, durationS, videoId|url, ytId }
  let currentPair = 0;      // pair index 1..6 (passes 1+2=1, 3+4=2, ...)
  let pairFrameStates = new Map(); // ts → { activity: bool, intent: bool, label?: string }
  let barElByTs = new Map();       // ts → DOM bar element
  let videoEl = null;       // <video> element if mp4 playback is available
  let fallbackImg = null;   // <img> shown when no mp4 (e.g. EPIC-KITCHENS)
  let selectedTs = null;    // user-clicked frame timestamp (slideshow focus)

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
        libraryById.set(v.id, v);
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

    let body, sourceMeta;
    if (libVid) {
      const lib = libraryById.get(libVid);
      body = { source: "library", video_id: libVid };
      sourceMeta = {
        source: "library",
        videoId: libVid,
        durationS: lib ? Math.round((lib.duration_min || 0) * 60) : 0,
      };
    } else if (ytUrl) {
      if (!/^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(ytUrl)) {
        showError("That doesn't look like a YouTube URL.");
        return;
      }
      body = { source: "youtube", url: ytUrl };
      sourceMeta = { source: "youtube", url: ytUrl, ytId: extractYouTubeId(ytUrl), durationS: 0 };
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
      // Pull duration from the response if the api returns it (overrides our guess for YT).
      if (data.duration_s) sourceMeta.durationS = data.duration_s;
      jobMeta = { jobId: data.job_id, ...sourceMeta };
      startStreaming(data.job_id);
      renderPlayer();
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

  function extractYouTubeId(url) {
    const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // Convert a frame_ts ("YYYYMMDD_HHMMSS" or "HHMMSS") to seconds-into-video.
  function frameTsToSeconds(ts) {
    const t = String(ts).split("_").pop();
    if (t.length < 6) return 0;
    const h = parseInt(t.slice(-6, -4), 10) || 0;
    const m = parseInt(t.slice(-4, -2), 10) || 0;
    const s = parseInt(t.slice(-2), 10) || 0;
    return h * 3600 + m * 60 + s;
  }

  function fmtMMSS(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function renderPlayer() {
    if (!jobMeta) return;
    els.playerWrap.classList.remove("hidden");
    els.player.innerHTML = "";
    barElByTs.clear();
    pairFrameStates.clear();
    currentPair = 0;
    selectedTs = null;
    videoEl = null;
    fallbackImg = null;
    els.timelineBars.innerHTML = "";
    els.pairLabel.textContent = "";
    els.timelineEnd.textContent = jobMeta.durationS ? fmtMMSS(jobMeta.durationS) : "—";
    els.framePosition.textContent = "";
    els.frameLabel.textContent = "";

    // Try to use the actual mp4. The api serves both library and youtube videos
    // at /jobs/<id>/video.mp4 (with a library fallback). If that 404s we hide
    // <video> and reveal the per-frame fallback <img>.
    const v = document.createElement("video");
    v.controls = true;
    v.preload = "metadata";
    v.className = "w-full h-full object-contain bg-black";
    v.src = `${apiBase}/jobs/${jobMeta.jobId}/video.mp4`;
    v.addEventListener("error", () => {
      v.style.display = "none";
      if (fallbackImg) {
        fallbackImg.style.display = "block";
      }
    });
    els.player.appendChild(v);
    videoEl = v;

    // Fallback <img> for jobs without a usable mp4 (e.g. EK_*).
    const img = document.createElement("img");
    img.alt = "current frame";
    img.className = "absolute inset-0 w-full h-full object-contain bg-black";
    img.style.display = "none";
    els.player.appendChild(img);
    fallbackImg = img;
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

    // If the api/worker reports duration_s, use it (covers YouTube post-validation).
    if (jobMeta && status.duration_s && !jobMeta.durationS) {
      jobMeta.durationS = status.duration_s;
      els.timelineEnd.textContent = fmtMMSS(jobMeta.durationS);
    }

    setStatusBadge(state, statusDetail(status));
    setQueueDisplay(status);
    setProgress(status);
    setMeta(status);

    if (Array.isArray(status.recent_states)) {
      mergeRecentStates(jobId, status.recent_states);
      updateTimelineFromStates(status.recent_states);
    }

    if (state === "complete" || state === "failed" || state === "cancelled") {
      if (evtSource) evtSource.close();
      if (state === "failed") {
        setStatusBadge("failed", status.error || "Job failed");
      } else if (state === "cancelled") {
        setStatusBadge("cancelled", status.error || "Cancelled");
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
      cancelled: "bg-slate-200 text-slate-700",
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

  function setQueueDisplay(status) {
    if (status.state !== "queued") {
      els.queueCard.classList.add("hidden");
      return;
    }
    const pos = status.queue_position || 1;
    const ahead = status.jobs_ahead != null ? status.jobs_ahead : Math.max(pos - 1, 0);
    const waitS = status.est_wait_s != null ? status.est_wait_s : ahead * 360;
    els.queueCard.classList.remove("hidden");
    els.queuePos.textContent = `#${pos}`;

    let detail;
    if (ahead === 0) {
      detail = "You're up next — starting shortly.";
    } else {
      const m = Math.max(1, Math.round(waitS / 60));
      detail = `${ahead} ${ahead === 1 ? "job" : "jobs"} ahead of you · ~${m} min estimated wait`;
    }
    els.queueDetail.textContent = detail;

    // Visual: dot row showing positions ahead (●) plus your position (★).
    const total = ahead + 1;
    const cap = Math.min(total, 12);
    const dots = [];
    for (let i = 0; i < cap - 1; i++) {
      dots.push('<span class="w-2 h-2 rounded-full bg-amber-300 inline-block"></span>');
    }
    dots.push('<span class="w-2.5 h-2.5 rounded-full bg-amber-600 ring-2 ring-amber-200 inline-block"></span>');
    if (total > cap) dots.unshift(`<span class="text-[10px] text-amber-700">+${total - cap} more</span>`);
    els.queueDots.innerHTML = dots.join("");
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

  // Compute pair from pass: passes 1+2 → pair 1, 3+4 → pair 2, ..., 11+12 → pair 6.
  function pairOf(pass) { return Math.ceil(pass / 2); }
  // True for activity passes (odd), false for intent passes (even).
  function isActivityPass(pass) { return pass % 2 === 1; }

  // Walk all states and rebuild the bar overlay for the *current* pair only.
  // Earlier pairs are intentionally cleared so the timeline always reflects
  // "what we know about the in-flight pair right now".
  function updateTimelineFromStates(states) {
    if (!jobMeta || !jobMeta.durationS) return;
    if (!states.length) return;

    // Newest pair = max pair across all incoming states.
    let maxPair = 0;
    for (const s of states) maxPair = Math.max(maxPair, pairOf(s.pass || 0));
    if (maxPair < 1) return;

    if (maxPair !== currentPair) {
      // New pair started → clear the track and the per-frame map.
      currentPair = maxPair;
      pairFrameStates.clear();
      barElByTs.clear();
      els.timelineBars.innerHTML = "";
      // Don't clear selectedTs — let the user keep their slideshow focus.
    }
    els.pairLabel.textContent = `Current pair: passes ${currentPair * 2 - 1} & ${currentPair * 2}`;

    // Only consider states from the current pair.
    for (const s of states) {
      if (pairOf(s.pass || 0) !== currentPair) continue;
      const ts = s.frame_ts;
      if (!ts) continue;
      let st = pairFrameStates.get(ts);
      if (!st) {
        st = { activity: false, intent: false };
        pairFrameStates.set(ts, st);
      }
      if (isActivityPass(s.pass)) st.activity = true;
      else st.intent = true;
      // Newest pass label wins.
      st.label = s.state || st.label || "";
      ensureBarFor(ts);
      paintBar(ts, st);
    }

    // Refresh the slideshow position display (count may have grown).
    renderSelected();
  }

  function ensureBarFor(ts) {
    if (barElByTs.has(ts)) return;
    if (!jobMeta || !jobMeta.durationS) return;
    const sec = frameTsToSeconds(ts);
    const pct = Math.max(0, Math.min(100, (sec / jobMeta.durationS) * 100));
    const bar = document.createElement("div");
    bar.className = "absolute top-0 bottom-0 transition-all rounded-sm cursor-pointer hover:opacity-80";
    bar.style.left = `calc(${pct}% - 1.5px)`;
    bar.style.width = "3px";
    bar.style.backgroundColor = "transparent";
    bar.title = `${ts} (${fmtMMSS(sec)})`;
    bar.dataset.ts = ts;
    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      selectFrame(ts);
    });
    els.timelineBars.appendChild(bar);
    barElByTs.set(ts, bar);
  }

  function paintBar(ts, st) {
    const bar = barElByTs.get(ts);
    if (!bar) return;
    const isSelected = ts === selectedTs;
    if (st.intent) bar.style.backgroundColor = "#10b981";       // emerald-500 — green
    else if (st.activity) bar.style.backgroundColor = "#f59e0b"; // amber-500 — yellow
    else bar.style.backgroundColor = "#cbd5e1";                  // slate-300 — pending placeholder

    if (isSelected) {
      // Raise the selected bar above the track and make it taller + thicker.
      bar.style.top = "-6px";
      bar.style.bottom = "-6px";
      bar.style.width = "5px";
      bar.style.left = `calc(${barLeftPercent(ts)}% - 2.5px)`;
      bar.style.boxShadow = "0 0 0 2px white, 0 0 0 3px #4f46e5"; // indigo ring
      bar.style.zIndex = "10";
    } else {
      bar.style.top = "0";
      bar.style.bottom = "0";
      bar.style.width = "3px";
      bar.style.left = `calc(${barLeftPercent(ts)}% - 1.5px)`;
      bar.style.boxShadow = "";
      bar.style.zIndex = "";
    }
  }

  function barLeftPercent(ts) {
    if (!jobMeta || !jobMeta.durationS) return 0;
    const sec = frameTsToSeconds(ts);
    return Math.max(0, Math.min(100, (sec / jobMeta.durationS) * 100));
  }

  // ─── slideshow / selected-frame logic ─────────────────────────────
  function sortedFrameTs() {
    return Array.from(pairFrameStates.keys()).sort(
      (a, b) => frameTsToSeconds(a) - frameTsToSeconds(b)
    );
  }

  function selectFrame(ts) {
    if (!ts) return;
    const prev = selectedTs;
    selectedTs = ts;

    // Repaint just the affected bars to update raised styling.
    if (prev) {
      const st = pairFrameStates.get(prev);
      if (st) paintBar(prev, st);
    }
    const st = pairFrameStates.get(ts);
    if (st) paintBar(ts, st);

    // Seek the video (or update the fallback image) to the selected frame.
    const sec = frameTsToSeconds(ts);
    if (videoEl && videoEl.style.display !== "none" && !isNaN(videoEl.duration)) {
      try { videoEl.currentTime = sec; } catch (_) {}
    } else if (fallbackImg) {
      fallbackImg.style.display = "block";
      fallbackImg.src = `${apiBase}/jobs/${jobMeta.jobId}/frames/${ts}.jpg`;
    }
    renderSelected();
  }

  function renderSelected() {
    const order = sortedFrameTs();
    if (!order.length) {
      els.framePrev.disabled = true;
      els.frameNext.disabled = true;
      els.framePosition.textContent = "";
      els.frameLabel.textContent = "";
      return;
    }
    // Default selection = latest processed frame in this pair.
    if (!selectedTs || !pairFrameStates.has(selectedTs)) {
      selectedTs = order[order.length - 1];
      const st = pairFrameStates.get(selectedTs);
      if (st) paintBar(selectedTs, st);
    }
    const idx = order.indexOf(selectedTs);
    els.framePrev.disabled = idx <= 0;
    els.frameNext.disabled = idx >= order.length - 1;
    els.framePosition.textContent =
      `frame ${idx + 1} / ${order.length} · ${fmtMMSS(frameTsToSeconds(selectedTs))}`;
    const st = pairFrameStates.get(selectedTs);
    els.frameLabel.textContent = (st && st.label) || "";

    // Keep the fallback image in sync if it's the active player.
    if (fallbackImg && fallbackImg.style.display === "block") {
      const url = `${apiBase}/jobs/${jobMeta.jobId}/frames/${selectedTs}.jpg`;
      if (fallbackImg.src !== url) fallbackImg.src = url;
    }
  }

  function stepFrame(delta) {
    const order = sortedFrameTs();
    if (!order.length) return;
    const idx = Math.max(0, order.indexOf(selectedTs));
    const next = order[Math.min(order.length - 1, Math.max(0, idx + delta))];
    selectFrame(next);
  }

  els.framePrev.addEventListener("click", () => stepFrame(-1));
  els.frameNext.addEventListener("click", () => stepFrame(+1));
  els.timelineTrack.addEventListener("click", (e) => {
    // Click anywhere on the track → snap to the nearest frame.
    if (!jobMeta || !jobMeta.durationS) return;
    const order = sortedFrameTs();
    if (!order.length) return;
    const rect = els.timelineTrack.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSec = fraction * jobMeta.durationS;
    let best = order[0], bestDelta = Infinity;
    for (const ts of order) {
      const d = Math.abs(frameTsToSeconds(ts) - targetSec);
      if (d < bestDelta) { bestDelta = d; best = ts; }
    }
    selectFrame(best);
  });

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
