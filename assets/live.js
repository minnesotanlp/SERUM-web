// SERUM-live frontend - vanilla JS, no build step.
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
    receipt: $("live-receipt"),
    receiptJobId: $("live-receipt-jobid"),
    receiptDetail: $("live-receipt-detail"),
    stageHelp: $("live-stage-help"),
    stageSteps: $("live-stage-steps"),
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
    pairSelector: $("live-pair-selector"),
    followToggle: $("live-follow-toggle"),
    followToggleLabel: $("live-follow-toggle-label"),
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

  // Per-job timeline state - rebuilt on every new submission.
  let jobMeta = null;       // { jobId, source, durationS, videoId|url, ytId }
  // We keep state for ALL pairs (1..6); the user can switch which one they're
  // viewing. `viewedPair` is the active view; `latestPair` tracks where the
  // pipeline currently is, used by the "follow latest" toggle.
  let allPairFrameStates = new Map(); // pair → Map<ts, {activity, intent, label?}>
  let viewedPair = 0;
  let latestPair = 0;
  let pairFrameStates = new Map(); // alias = allPairFrameStates.get(viewedPair)
  let followLatest = true;         // auto-jump to newest pair as it arrives
  let barElByTs = new Map();       // ts → DOM bar element (for the viewed pair)
  let videoEl = null;       // <video> element if mp4 playback is available
  let fallbackImg = null;   // <img> shown when no mp4 (e.g. EPIC-KITCHENS)
  let selectedTs = null;    // user-clicked frame timestamp (slideshow focus)

  // Scroll detection - visitor-controlled scroll per design lock E1
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
      "Live demo is being updated. Refresh in a moment.";
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
      showReceipt(data);
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
    allPairFrameStates.clear();
    pairFrameStates = new Map();
    viewedPair = 0;
    latestPair = 0;
    followLatest = true;
    selectedTs = null;
    setFollowToggleLabel();
    renderPairSelector();
    videoEl = null;
    fallbackImg = null;
    els.timelineBars.innerHTML = "";
    els.pairLabel.textContent = "";
    els.timelineEnd.textContent = jobMeta.durationS ? fmtMMSS(jobMeta.durationS) : "...";
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
    // Pre-populate the stage checklist + help text so the user sees something
    // useful in the brief window before the first SSE message lands.
    setStageHelp({ state: "queued" });
    setStageSteps({ state: "queued" });

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
    setStageHelp(status);
    setStageSteps(status);
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

  // Shown immediately on POST /jobs success - independent of SSE reconnects.
  function showReceipt(postResp) {
    if (!postResp || !postResp.job_id) return;
    els.receipt.classList.remove("hidden");
    els.receiptJobId.textContent = postResp.job_id;
    const bits = [];
    if (postResp.title) bits.push(postResp.title);
    if (postResp.duration_s) bits.push(`${(postResp.duration_s / 60).toFixed(1)} min source`);
    if (Array.isArray(postResp.cancelled_prior) && postResp.cancelled_prior.length) {
      bits.push(`replaced prior run · ${postResp.cancelled_prior.join(", ")}`);
    }
    const ahead = postResp.jobs_ahead != null ? postResp.jobs_ahead : null;
    if (ahead === 0) bits.push("starting now");
    else if (ahead === 1) bits.push("1 job ahead of you");
    else if (ahead != null) bits.push(`${ahead} jobs ahead of you`);
    bits.push("opening live stream…");
    els.receiptDetail.textContent = bits.join(" · ");
  }

  // Per-state human-readable explanation. Tells the user what's actually
  // happening so they understand why nothing has appeared on screen yet.
  const STAGE_HELP = {
    queued: "You're in the FIFO queue. The pipeline runs one job at a time so we can give the GPU full bandwidth for your video. As soon as the slot opens, your job starts.",
    starting: "Worker accepted your job. Setting up the per-job manifest tree, verifying the inference server is healthy, and preparing to extract frames.",
    extracting: "Decoding the video and pulling one frame every 5 seconds. About 30 seconds per minute of source for YouTube; instant for library demos (frames are pre-staged).",
    extracted: "Frames are ready. Spawning the GUM inference container and warming up the vLLM model. First pass kicks off in about 20 seconds.",
    running: "Running the 12-pass alternating activity ↔ intent labelling loop. Each pass labels every frame; activity passes refine what's happening, intent passes infer why.",
    complete: "All 12 passes committed. The state stream below shows what the model saw at each frame; the timeline above lets you scrub through.",
    failed: "Pipeline error. See the details above. You can resubmit the same video; resubmissions automatically cancel your previous run.",
    cancelled: "Run was superseded, either by you submitting a newer job or by a worker restart.",
  };

  function setStageHelp(status) {
    const text = STAGE_HELP[status.state] || "";
    els.stageHelp.textContent = text;
  }

  // Render a small checklist showing which stages are done / active / pending.
  // The list is fixed; the marker and color tell you where you are.
  const STAGE_ORDER = [
    { key: "queued",     label: "Queued" },
    { key: "starting",   label: "Worker pickup" },
    { key: "extracting", label: "Frame extraction" },
    { key: "extracted",  label: "Inference warm-up" },
    { key: "running",    label: "12-pass labelling" },
    { key: "complete",   label: "Done" },
  ];
  // Map current state → index into STAGE_ORDER.
  function stageIndex(state) {
    const i = STAGE_ORDER.findIndex((s) => s.key === state);
    if (i >= 0) return i;
    if (state === "failed" || state === "cancelled") return -1;
    return 0;
  }

  function setStageSteps(status) {
    const idx = stageIndex(status.state);
    const isTerminal = status.state === "failed" || status.state === "cancelled";
    const html = STAGE_ORDER.map((stg, i) => {
      let icon, color;
      if (isTerminal && i > 0) {
        icon = "·"; color = "text-slate-300";
      } else if (i < idx || status.state === "complete") {
        icon = "✓"; color = "text-emerald-600";
      } else if (i === idx) {
        icon = "⟳"; color = "text-indigo-600 font-medium";
      } else {
        icon = "·"; color = "text-slate-300";
      }
      return `<li class="${color}"><span class="inline-block w-4 text-center">${icon}</span> ${stg.label}</li>`;
    }).join("");
    els.stageSteps.innerHTML = html;
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
      detail = "You're up next, starting shortly.";
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

  // Receive state events from SSE: store them by pair, and (if the user is
  // following along) auto-advance the viewed pair to whatever's freshest.
  // The user can manually pick a pair via the selector or click a bar; that
  // turns "follow latest" off.
  function updateTimelineFromStates(states) {
    if (!jobMeta || !jobMeta.durationS) return;
    if (!states.length) return;

    let sawAnyPair = 0;
    for (const s of states) {
      const p = pairOf(s.pass || 0);
      if (p < 1) continue;
      sawAnyPair = Math.max(sawAnyPair, p);
      const ts = s.frame_ts;
      if (!ts) continue;
      let pairMap = allPairFrameStates.get(p);
      if (!pairMap) { pairMap = new Map(); allPairFrameStates.set(p, pairMap); }
      let st = pairMap.get(ts);
      if (!st) {
        st = { activity: false, intent: false };
        pairMap.set(ts, st);
      }
      if (isActivityPass(s.pass)) st.activity = true;
      else st.intent = true;
      st.label = s.state || st.label || "";
    }
    if (sawAnyPair < 1) return;
    latestPair = Math.max(latestPair, sawAnyPair);

    if (followLatest && viewedPair !== latestPair) {
      switchToPair(latestPair, /*autoAdvanceSelection*/ true);
    } else if (viewedPair === 0) {
      switchToPair(latestPair, /*autoAdvanceSelection*/ true);
    } else {
      // Same viewed pair, but new frames may have arrived - repaint.
      renderBarsForViewedPair(/*advanceSelection*/ followLatest);
    }
    renderPairSelector();
    renderSelected();
  }

  // Switch the timeline+slideshow view to a specific pair. Used both by
  // follow-along auto-advance and by user clicks on the pair selector.
  function switchToPair(pair, autoAdvanceSelection) {
    viewedPair = pair;
    pairFrameStates = allPairFrameStates.get(pair) || new Map();
    barElByTs.clear();
    els.timelineBars.innerHTML = "";
    els.pairLabel.textContent =
      `Pair ${pair}: passes ${pair * 2 - 1} & ${pair * 2}`;
    // Reset selection to "newest in this pair" so the user lands on something
    // sensible. selectFrame() / framePrev/Next will let them browse from there.
    if (autoAdvanceSelection) selectedTs = null;
    renderBarsForViewedPair(/*advanceSelection*/ autoAdvanceSelection);
  }

  function renderBarsForViewedPair(advanceSelection) {
    // Advance the cursor BEFORE painting so the raised-bar styling reflects the
    // newest frame in the same tick, not last tick's frame. (paintBar reads
    // selectedTs at call time, so updating it after the loop leaves the prior
    // selection visually raised until the next SSE tick.)
    if (advanceSelection) {
      const target = followTargetForPair(viewedPair);
      if (target) selectedTs = target;
    }
    for (const [ts, st] of pairFrameStates) {
      ensureBarFor(ts);
      paintBar(ts, st);
    }
  }

  // ─── pair selector + follow toggle ────────────────────────────────
  function renderPairSelector() {
    if (!els.pairSelector) return;
    const cells = [];
    for (let p = 1; p <= 6; p++) {
      const has = allPairFrameStates.has(p);
      const active = p === viewedPair;
      const cls = active
        ? "px-2 py-0.5 rounded text-xs font-medium bg-indigo-600 text-white"
        : has
          ? "px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer"
          : "px-2 py-0.5 rounded text-xs bg-slate-50 text-slate-300 cursor-not-allowed";
      cells.push(`<button type="button" data-pair="${p}" class="${cls}"${has ? "" : " disabled"}>P${p * 2 - 1}+${p * 2}</button>`);
    }
    els.pairSelector.innerHTML = cells.join("");
    for (const btn of els.pairSelector.querySelectorAll("button[data-pair]")) {
      btn.addEventListener("click", () => {
        const p = Number(btn.dataset.pair);
        if (!allPairFrameStates.has(p)) return;
        // Manual pick → stop following.
        if (followLatest) setFollow(false);
        switchToPair(p, /*autoAdvanceSelection*/ true);
        renderPairSelector();
        renderSelected();
      });
    }
  }

  function setFollow(on) {
    followLatest = !!on;
    setFollowToggleLabel();
    if (followLatest) {
      // Snap to latest pair + frontier frame of the active pass.
      if (latestPair && viewedPair !== latestPair) {
        switchToPair(latestPair, /*autoAdvanceSelection*/ true);
      } else {
        const target = followTargetForPair(viewedPair);
        if (target) selectFrameQuiet(target);
      }
      renderPairSelector();
      renderSelected();
    }
  }

  function setFollowToggleLabel() {
    if (!els.followToggle) return;
    if (followLatest) {
      els.followToggle.classList.remove("bg-slate-50", "text-slate-600", "border-slate-200");
      els.followToggle.classList.add("bg-indigo-50", "text-indigo-700", "border-indigo-200");
      els.followToggleLabel.textContent = "Following latest";
    } else {
      els.followToggle.classList.remove("bg-indigo-50", "text-indigo-700", "border-indigo-200");
      els.followToggle.classList.add("bg-slate-50", "text-slate-600", "border-slate-200");
      els.followToggleLabel.textContent = "Paused, click to follow";
    }
  }

  if (els.followToggle) {
    els.followToggle.addEventListener("click", () => setFollow(!followLatest));
  }

  // Internal version of selectFrame that doesn't toggle follow off (used when
  // follow itself is moving the cursor).
  function selectFrameQuiet(ts) {
    if (!ts) return;
    const prev = selectedTs;
    selectedTs = ts;
    if (prev) {
      const st = pairFrameStates.get(prev);
      if (st) paintBar(prev, st);
    }
    const st = pairFrameStates.get(ts);
    if (st) paintBar(ts, st);
    seekVideoTo(ts);
    renderSelected();
  }

  function seekVideoTo(ts) {
    const sec = frameTsToSeconds(ts);
    if (videoEl && videoEl.style.display !== "none" && !isNaN(videoEl.duration)) {
      try { videoEl.currentTime = sec; } catch (_) {}
    } else if (fallbackImg) {
      fallbackImg.style.display = "block";
      fallbackImg.src = `${apiBase}/jobs/${jobMeta.jobId}/frames/${ts}.jpg`;
    }
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
    if (st.intent) bar.style.backgroundColor = "#10b981";       // emerald-500 - green
    else if (st.activity) bar.style.backgroundColor = "#f59e0b"; // amber-500 - yellow
    else bar.style.backgroundColor = "#cbd5e1";                  // slate-300 - pending placeholder

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

  // Pick the frame the "follow latest" cursor should pin to: the leading edge
  // of whichever pass is currently committing in this pair. Within a pair,
  // pass 2 (intent) always runs strictly after pass 1 (activity) - so once
  // we've seen ANY intent state, the cursor should track intent-committed
  // frames (which start over from the beginning of the video). Otherwise we
  // track activity-committed frames.
  function followTargetForPair(pair) {
    const pairMap = allPairFrameStates.get(pair);
    if (!pairMap || !pairMap.size) return null;
    let intentMaxSec = -1, intentMaxTs = null;
    let activityMaxSec = -1, activityMaxTs = null;
    for (const [ts, st] of pairMap) {
      const sec = frameTsToSeconds(ts);
      if (st.intent && sec > intentMaxSec) { intentMaxSec = sec; intentMaxTs = ts; }
      if (st.activity && sec > activityMaxSec) { activityMaxSec = sec; activityMaxTs = ts; }
    }
    return intentMaxTs || activityMaxTs;
  }

  // User-initiated frame pick - turns off "follow latest" so their selection
  // doesn't get yanked away by the next SSE tick.
  function selectFrame(ts) {
    if (!ts) return;
    if (followLatest) setFollow(false);
    selectFrameQuiet(ts);
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
    // Default selection = frontier of whichever pass is currently committing
    // in this pair (intent if any has fired, otherwise activity).
    if (!selectedTs || !pairFrameStates.has(selectedTs)) {
      selectedTs = followTargetForPair(viewedPair) || order[order.length - 1];
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
        <div class="text-sm text-slate-800 break-words">${escapeHtml(s.state || "...")}</div>
      </div>`;
    return row;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(String(s)));
    return div.innerHTML;
  }
})();
