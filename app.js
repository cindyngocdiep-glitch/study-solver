/* AI Study Solver — front-end logic. No libraries needed. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MODELS = { opus: "Opus", sonnet: "Sonnet" };
  const POLL_MS = 4000;

  /* ---------------- storage (wrapped: can fail in private mode) ---------------- */
  const store = {
    get(k, d = "") { try { const v = localStorage.getItem("ss_" + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ss_" + k, v); } catch {} },
  };

  /* ---------------- settings, incl. one-time link import ---------------- */
  const params = new URLSearchParams(location.search);
  if (params.has("api")) store.set("api", params.get("api"));
  if (params.has("code")) store.set("code", params.get("code"));
  if (params.has("mode")) store.set("mode", params.get("mode"));
  if (params.has("api") || params.has("code")) {
    // Remove the access code from the address bar after saving it.
    params.delete("api"); params.delete("code");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }

  const cfg = {
    get api() { return store.get("api").trim().replace(/\/+$/, ""); },
    get code() { return store.get("code"); },
    get mode() { return store.get("mode", "auto"); },
    get model() { return store.get("model", "opus") in MODELS ? store.get("model", "opus") : "opus"; },
  };

  /* ---------------- state ---------------- */
  const state = {
    view: "capture",
    image: null,          // { data: base64, mediaType, url }
    result: null,
    page: 0,
    pages: [],
    busy: false,
    abort: null,
    lastSeen: Number(store.get("lastSeen", "0")),
    pollTimer: null,
    pending: null,        // newer solution waiting (glasses)
  };

  const isGlasses = () => {
    if (cfg.mode === "glasses") return true;
    if (cfg.mode === "normal") return false;
    return window.innerWidth <= 640 && window.innerHeight <= 640;
  };
  const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

  /* ---------------- views ---------------- */
  const views = { capture: $("viewCapture"), waiting: $("viewWaiting"), loading: $("viewLoading"), result: $("viewResult"), error: $("viewError") };

  function show(name, { focus = true } = {}) {
    if (name === "capture" && isGlasses()) name = "waiting";
    state.view = name;
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    if (!focus) return;
    const target = {
      capture: state.image ? $("solveBtn") : (isTouch() ? $("cameraBtn") : $("uploadBtn")),
      waiting: $("latestBtn"),
      loading: $("cancelBtn"),
      result: $("nextBtn"),
      error: $("retryBtn"),
    }[name];
    // Don't pop the keyboard/focus ring on touch phones; do on glasses & PC.
    if (target && (!isTouch() || isGlasses())) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }

  function applyLayout() {
    const g = isGlasses();
    document.body.classList.toggle("glasses", g);
    $("cameraBtn").style.display = isTouch() ? "" : "none"; // PCs usually have no rear camera: UPLOAD only
    $("newBtn").textContent = g ? "DONE" : "NEW PROBLEM";
    $("uploadBtn").parentElement.classList.toggle("two", isTouch());
    $("pcHint").hidden = isTouch();
    if (g && state.view === "capture") show("waiting", { focus: false });
    if (!g && state.view === "waiting") show("capture", { focus: false });
    managePolling();
  }

  /* ---------------- model switch ---------------- */
  function renderModel() { $("modelBtn").textContent = "MODEL: " + MODELS[cfg.model]; }
  $("modelBtn").addEventListener("click", () => {
    store.set("model", cfg.model === "opus" ? "sonnet" : "opus");
    renderModel();
    toast(cfg.model === "opus" ? "Opus: most accurate (costs more)" : "Sonnet: faster and cheaper");
  });

  /* ---------------- toast ---------------- */
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  /* ---------------- photo input ---------------- */
  $("cameraBtn").addEventListener("click", () => $("cameraInput").click());
  $("uploadBtn").addEventListener("click", () => $("uploadInput").click());
  for (const id of ["cameraInput", "uploadInput"]) {
    $(id).addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) loadImage(f);
    });
  }

  const dz = $("dropZone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
    if (f) loadImage(f); else toast("Please drop an image file.");
  });
  window.addEventListener("paste", (e) => {
    if (state.view !== "capture" || $("settings").open) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); loadImage(item.getAsFile()); }
  });

  async function loadImage(file) {
    if (!file.type.startsWith("image/") && !/\.(heic|heif|jpe?g|png|webp|gif)$/i.test(file.name || "")) {
      toast("That file isn't a picture. Choose a photo.");
      return;
    }
    $("previewHint").textContent = "Preparing photo…";
    try {
      state.image = await shrinkImage(file, 2000, 0.9);
      const img = $("previewImg");
      img.src = state.image.url; img.hidden = false;
      $("previewHint").hidden = true;
      $("solveBtn").disabled = false;
      if (!isTouch()) $("solveBtn").focus();
    } catch (err) {
      state.image = null;
      $("previewImg").hidden = true;
      $("previewHint").hidden = false;
      $("previewHint").textContent = "Couldn't open that photo. Try another one (JPG or PNG works best).";
      $("solveBtn").disabled = true;
    }
  }

  // Resize + convert to JPEG so uploads are fast and under Claude's 5 MB limit.
  function shrinkImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let { naturalWidth: w, naturalHeight: h } = img;
          const scale = Math.min(1, maxSide / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          let q = quality, dataUrl = c.toDataURL("image/jpeg", q);
          while (dataUrl.length > 6_000_000 && q > 0.5) { q -= 0.1; dataUrl = c.toDataURL("image/jpeg", q); }
          URL.revokeObjectURL(url);
          resolve({ data: dataUrl.split(",")[1], mediaType: "image/jpeg", url: dataUrl });
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  /* ---------------- solve ---------------- */
  $("solveBtn").addEventListener("click", solve);
  $("retryBtn").addEventListener("click", () => (state.image && !isGlasses() ? solve() : show("capture")));
  // Ignore CANCEL for 1.5 s after SOLVE so a double tap / double pinch can't cancel by accident.
  $("cancelBtn").addEventListener("click", () => { if (state.abort && Date.now() - state.solveStarted > 1500) state.abort.abort(); });

  async function solve() {
    if (state.busy) return;                       // no double submissions
    if (!state.image) { toast("Add a photo first."); return; }
    if (!cfg.api || !cfg.code) { openSettings("Add your backend URL and access code first."); return; }

    state.busy = true;
    $("solveBtn").disabled = true;
    state.abort = new AbortController();
    state.solveStarted = Date.now();
    show("loading");
    $("loadStatus").textContent = "Sending your photo…";
    const started = Date.now();
    const tick = setInterval(() => ($("loadTimer").textContent = Math.round((Date.now() - started) / 1000) + " s"), 1000);
    $("loadTimer").textContent = "0 s";

    try {
      const res = await fetch(cfg.api + "/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Code": cfg.code },
        body: JSON.stringify({ image: state.image.data, mediaType: state.image.mediaType, model: cfg.model }),
        signal: state.abort.signal,
      });
      if (!res.ok) throw new Error(await errorFrom(res));

      const result = await readStream(res, (msg) => ($("loadStatus").textContent = msg));
      state.lastSeen = result.solvedAt || Date.now();
      store.set("lastSeen", String(state.lastSeen));
      openResult(result);
    } catch (err) {
      if (err.name === "AbortError") { show("capture"); toast("Cancelled."); }
      else showError(networkMessage(err));
    } finally {
      clearInterval(tick);
      state.busy = false;
      state.abort = null;
      $("solveBtn").disabled = !state.image;
    }
  }

  async function readStream(res, onStatus) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", result = null, error = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "status") onStatus(m.message);
        else if (m.type === "result") result = m.result;
        else if (m.type === "error") error = m.error;
      }
      if (done) break;
    }
    if (error) throw new Error(error);
    if (!result) throw new Error("The connection ended before the answer arrived. Please try again.");
    return result;
  }

  async function errorFrom(res) {
    try { const j = await res.json(); if (j.error) return j.error; } catch {}
    return `Server error ${res.status}. Please try again.`;
  }

  function networkMessage(err) {
    const m = String(err && err.message || err);
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m))
      return "Can't reach the backend. Check your internet connection and the Backend URL in Settings.";
    return m;
  }

  function showError(msg) {
    $("errText").textContent = msg;
    show("error");
  }

  /* ---------------- results + NEXT / BACK ---------------- */
  function buildPages(r) {
    if (r.status && r.status !== "ok") {
      return [{
        title: r.status === "unclear" ? "Photo unclear" : "No problem found",
        body: [{ cls: "warn-text", text: r.message || "Claude couldn't read a problem in this photo." },
               { text: "Retake the photo closer, flat, and in good light, with the whole problem in frame." }],
      }];
    }
    const pages = [];
    const first = [{ label: "Final answer" }, { cls: "answer", text: r.final_answer || "—" }];
    if (r.problem) first.push({ label: "Problem" }, { text: r.problem });
    pages.push({ title: "Answer", body: first });
    (r.steps || []).forEach((s, i) => pages.push({ title: `Step ${i + 1}${s.title ? " · " + s.title : ""}`, body: [{ text: s.detail }] }));
    if (r.check) pages.push({ title: "Double-check", body: [{ text: r.check }, { label: "Final answer" }, { cls: "answer", text: r.final_answer || "—" }] });
    return pages;
  }

  function openResult(r) {
    state.result = r;
    state.pages = buildPages(r);
    state.page = 0;
    state.pending = null;
    $("newerBtn").hidden = true;
    if (!history.state || history.state.v !== "result") history.pushState({ v: "result" }, "");
    show("result");
    renderPage();
  }

  function renderPage() {
    const p = state.pages[state.page];
    const n = state.pages.length;
    $("stepTitle").textContent = p.title;
    const body = $("stepBody");
    body.replaceChildren();
    for (const part of p.body) {
      const el = document.createElement(part.label ? "span" : "p");
      if (part.label) { el.className = "label"; el.textContent = part.label; }
      else { if (part.cls) el.className = part.cls; el.textContent = part.text; }
      body.appendChild(el);
    }
    $("stepPanel").scrollTop = 0;
    $("stepCounter").textContent = `${state.page + 1} / ${n}`;
    const r = state.result || {};
    $("stepSubject").textContent = [r.subject, r.model && r.model.replace("Claude ", "")].filter(Boolean).join(" · ");
    $("backBtn").disabled = state.page === 0;
    $("nextBtn").disabled = state.page >= n - 1;
    const dots = $("dots"); dots.replaceChildren();
    for (let i = 0; i < n; i++) { const d = document.createElement("i"); if (i === state.page) d.className = "on"; dots.appendChild(d); }
    // Keep focus on a usable button when one becomes disabled (important for Neural Band).
    const a = document.activeElement;
    if (a === $("nextBtn") && a.disabled) $("backBtn").focus();
    if (a === $("backBtn") && a.disabled) $("nextBtn").focus();
  }

  function step(delta) {
    if (state.view !== "result") return;
    const next = Math.max(0, Math.min(state.pages.length - 1, state.page + delta));
    if (next !== state.page) { state.page = next; renderPage(); }
  }
  $("nextBtn").addEventListener("click", () => step(1));
  $("backBtn").addEventListener("click", () => step(-1));

  // Swipe left/right on the explanation (phone). Up/down stays normal scrolling.
  let touchStart = null;
  $("stepPanel").addEventListener("touchstart", (e) => { const t = e.touches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
  $("stepPanel").addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  function newProblem() {
    state.image = null; state.result = null;
    $("previewImg").hidden = true; $("previewImg").removeAttribute("src");
    $("previewHint").hidden = false;
    $("previewHint").textContent = "Take or upload a photo of a math, chemistry, or statistics problem.";
    $("solveBtn").disabled = true;
    if (history.state && history.state.v === "result") history.back(); // popstate shows capture
    else show("capture");
  }
  $("newBtn").addEventListener("click", newProblem);
  $("errNewBtn").addEventListener("click", newProblem);

  // System Back (glasses Back gesture, browser back, Android back) returns to the start screen.
  window.addEventListener("popstate", () => {
    if ($("settings").open) $("settings").close();
    if (state.view === "result" || state.view === "error") show("capture");
  });

  /* ---------------- keyboard + Neural Band ---------------- */
  // Neural Band and glasses touchpad arrive as ArrowUp/Down/Left/Right + Enter key events.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if ($("settings").open) return; // dialog handles Tab/Escape natively
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) return;

    if (e.key === "Escape") {
      if (state.view === "loading" && state.abort && Date.now() - state.solveStarted > 1500) { e.preventDefault(); state.abort.abort(); }
      return;
    }
    if (state.view !== "result") return;

    const panel = $("stepPanel");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Scroll a long explanation first; only when at the edge let focus move normally.
      const down = e.key === "ArrowDown";
      const canScroll = down ? panel.scrollTop + panel.clientHeight < panel.scrollHeight - 2 : panel.scrollTop > 2;
      if (canScroll) { e.preventDefault(); panel.scrollBy({ top: (down ? 1 : -1) * panel.clientHeight * 0.6 }); }
      return;
    }
    // On PC, Left/Right turn pages. On the glasses they move the highlight between buttons
    // (the platform's own navigation), and you press NEXT/BACK with a pinch.
    if (!isGlasses() && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const onNav = t === document.body || t === panel || t === $("nextBtn") || t === $("backBtn") || !t;
      if (onNav) { e.preventDefault(); step(e.key === "ArrowRight" ? 1 : -1); }
    }
  });

  /* ---------------- glasses: get solutions from the phone ---------------- */
  $("latestBtn").addEventListener("click", () => fetchLatest(true));
  $("newerBtn").addEventListener("click", () => { if (state.pending) openResult(state.pending); });

  let polling = false;
  async function fetchLatest(manual) {
    if (polling) return;
    if (!cfg.api || !cfg.code) {
      if (manual) $("waitText").textContent = "Not set up. On your phone, open Settings → COPY GLASSES LINK, then add that link in the Meta AI app.";
      return;
    }
    polling = true;
    if (manual) $("waitText").textContent = "Checking…";
    try {
      const res = await fetch(cfg.api + "/latest", { headers: { "X-Access-Code": cfg.code }, cache: "no-store" });
      if (!res.ok) throw new Error(await errorFrom(res));
      const { result } = await res.json();
      if (!result) { if (manual) $("waitText").textContent = "No solutions yet. Solve one on your phone."; return; }
      const fresh = (result.solvedAt || 0) > state.lastSeen;
      if (fresh) { state.lastSeen = result.solvedAt; store.set("lastSeen", String(result.solvedAt)); }
      if (manual || (fresh && state.view === "waiting")) openResult(result);
      else if (fresh && state.view === "result") { state.pending = result; $("newerBtn").hidden = false; }
      if (!manual) $("waitText").textContent = "Solve a problem on your phone and it will appear here.";
    } catch (err) {
      if (manual) $("waitText").textContent = networkMessage(err);
    } finally {
      polling = false;
    }
  }

  function managePolling() {
    const want = isGlasses() && cfg.api && cfg.code && document.visibilityState === "visible";
    if (want && !state.pollTimer) { state.pollTimer = setInterval(() => fetchLatest(false), POLL_MS); fetchLatest(false); }
    if (!want && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }
  document.addEventListener("visibilitychange", managePolling);

  /* ---------------- settings dialog ---------------- */
  const dlg = $("settings");
  function openSettings(note) {
    $("apiUrl").value = cfg.api;
    $("accessCode").value = cfg.code;
    $("modeSelect").value = cfg.mode;
    $("testResult").textContent = note || "";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    setTimeout(() => (cfg.api ? $("testBtn") : $("apiUrl")).focus(), 50);
  }
  $("settingsBtn").addEventListener("click", () => openSettings());

  function saveSettings() {
    let api = $("apiUrl").value.trim();
    if (api && !/^https?:\/\//i.test(api)) api = "https://" + api;
    store.set("api", api.replace(/\/+$/, ""));
    store.set("code", $("accessCode").value.trim());
    store.set("mode", $("modeSelect").value);
  }

  $("saveBtn").addEventListener("click", () => { saveSettings(); dlg.close(); applyLayout(); show(state.view === "waiting" ? "capture" : state.view); toast("Settings saved."); });
  $("testBtn").addEventListener("click", async () => {
    saveSettings();
    const out = $("testResult");
    if (!cfg.api) { out.textContent = "Enter the Backend URL first."; return; }
    out.textContent = "Testing…";
    try {
      const h = await (await fetch(cfg.api + "/health", { cache: "no-store" })).json();
      if (!h.apiKeySet || !h.accessCodeSet) { out.textContent = "⚠️ Backend found, but secrets are missing: " + [!h.apiKeySet && "ANTHROPIC_API_KEY", !h.accessCodeSet && "ACCESS_CODE"].filter(Boolean).join(", "); return; }
      const v = await fetch(cfg.api + "/verify", { headers: { "X-Access-Code": cfg.code }, cache: "no-store" });
      if (!v.ok) { out.textContent = "⚠️ " + (await errorFrom(v)); return; }
      out.textContent = "✅ Connected! Glasses sync: " + (h.glassesSync ? "ON" : "OFF (optional: add SOLVER_KV)");
    } catch (err) {
      out.textContent = "⚠️ " + networkMessage(err);
    }
  });
  $("glassLinkBtn").addEventListener("click", async () => {
    saveSettings();
    if (!cfg.api || !cfg.code) { $("testResult").textContent = "Fill in Backend URL and Access code first."; return; }
    const link = `${location.origin}${location.pathname}?mode=glasses&api=${encodeURIComponent(cfg.api)}&code=${encodeURIComponent(cfg.code)}`;
    try { await navigator.clipboard.writeText(link); $("testResult").textContent = "✅ Glasses link copied. Paste it in Meta AI app → Web Apps → Connect Web App."; }
    catch { $("testResult").textContent = "Copy this link: " + link; }
  });
  dlg.addEventListener("close", () => { applyLayout(); });

  /* ---------------- start ---------------- */
  renderModel();
  applyLayout();
  show("capture", { focus: !isTouch() });
  window.addEventListener("resize", () => { clearTimeout(window.__rz); window.__rz = setTimeout(applyLayout, 150); });
  if (!cfg.api || !cfg.code) {
    if (isGlasses()) $("waitText").textContent = "Not set up. On your phone, open Settings → COPY GLASSES LINK, then add that link in the Meta AI app.";
    else setTimeout(() => openSettings("Welcome! Paste your Cloudflare backend URL and access code to begin."), 300);
  }
})();
