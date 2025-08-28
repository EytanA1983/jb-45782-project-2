"use strict";

(async () => {
  const USE_PRO   = true;
  const API_KEY   = "7a46cd1fddaa92fb55b2c20758ffbf040fcea0a051c1521d3fb0a4cf3641e2c6"; 
  const COINCAP_BASE  = (USE_PRO && API_KEY) ? "https://rest.coincap.io/v3": {};
  const AUTH_HEADERS  = (USE_PRO && API_KEY) ? { Authorization: `Bearer ${API_KEY}` } : {};

  const STORAGE_KEY    = "reports.selected.symbols"; 
  const LIST_LIMIT     = 100;            
  const TTL_ASSETS_MS  = 60 * 1000;     
  const TTL_INFO_MS    = 2 * 60 * 1000;  
  const POLL_MS        = 2000;           

  const assetsURL = (limit = LIST_LIMIT, offset = 0) =>
    `${COINCAP_BASE}/assets?limit=${limit}&offset=${offset}`;
  const assetByIdURL = (id) => `${COINCAP_BASE}/assets/${encodeURIComponent(id)}`;
  const ratesURL = `${COINCAP_BASE}/rates`;

  const cryptoCompareURL = (symbolsCSV) =>
    `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${symbolsCSV}&tsyms=USD`;

 
  let assets = [];               
  let filtered = [];             
  let selected = loadSelected(); 
  const infoCache = {};          
  let ratesCache = null;         


  let pageSize = 20, page = 1, pages = 1;

  
  let chart = null, pollTimer = null;

  const el = {
    spinner:        document.getElementById("global-spinner"),
    coinsSection:   document.getElementById("coins-section"),
    reportsSection: document.getElementById("reports-section"),
    aboutSection:   document.getElementById("about-section"),
    coinsContainer: document.getElementById("coins-container"),
    noResults:      document.getElementById("no-results"),
    loadInfo:       document.getElementById("loading-info"),
    loadTime:       document.getElementById("last-load-time"),

    searchForm:     document.getElementById("search-form"),
    searchInput:    document.getElementById("search-input"),
    onlySelected:   document.getElementById("only-selected"),

    sizeTop:        document.getElementById("page-size-selector"),
    sizeBottom:     document.getElementById("page-size-selector-bottom"),
    prevBtn:        document.getElementById("prev-page"),
    nextBtn:        document.getElementById("next-page"),
    curPage:        document.getElementById("current-page"),
    totPages:       document.getElementById("total-pages"),
    showRange:      document.getElementById("showing-range"),
    totCoins:       document.getElementById("total-coins"),
    paging:         document.getElementById("paging-controls"),

    navHome:        document.getElementById("nav-home"),
    selectedBadges: document.getElementById("selected-badges"),
    noSelected:     document.getElementById("no-selected"),
    chartMessages:  document.getElementById("chart-messages"),
    chartContainer: document.getElementById("chartContainer"),

    limitModal:     document.getElementById("limitModal"),
    limitList:      document.getElementById("limit-list"),
    limitConfirm:   document.getElementById("limit-confirm"),
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms)); // explicit Promise usage
  const showSpinner = (show) => el.spinner.classList.toggle("d-none", !show);
  const escapeHtml = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function loadSelected() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 5).map((x) => String(x).toUpperCase()) : [];
    } catch { return []; }
  }
  function persistSelected() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
  }

  async function getJSON(url, ttlMs = 0) {
    const hit = localStorage.getItem(url);
    if (ttlMs && hit) {
      try {
        const { data, ts } = JSON.parse(hit);
        if (Date.now() - ts < ttlMs) return data; 
      } catch {}
    }
    const res = await fetch(url, { headers: AUTH_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (ttlMs) localStorage.setItem(url, JSON.stringify({ data: json, ts: Date.now() }));
    return json;
  }
  function getLastLoadTsFor(url) {
    const raw = localStorage.getItem(url);
    if (!raw) return null;
    try { const { ts } = JSON.parse(raw); return typeof ts === "number" ? ts : null; }
    catch { return null; }
  }
  async function loadAssets() {
  
    const url = assetsURL(LIST_LIMIT, 0);
    try {
      showSpinner(true);

      const json = await getJSON(url, TTL_ASSETS_MS);
      const list = Array.isArray(json?.data) ? json.data : [];

      assets = list.map((a) => ({
        id: a.id,
        symbol: a.symbol?.toUpperCase?.() || "",
        name: a.name || "",
        priceUsd: Number(a.priceUsd || 0),
        change24h: Number(a.changePercent24Hr || 0),
        rank: a.rank ? Number(a.rank) : null,
      }));

      filtered = [...assets];
      renderCoins();

      const ts = getLastLoadTsFor(url);
      el.loadTime.textContent = ts ? new Date(ts).toLocaleString("en-US") : "No successful load yet";
      el.loadInfo.classList.remove("d-none");

      const avg = filtered.map((x) => x.priceUsd).reduce((s, v) => s + v, 0) / (filtered.length || 1);
      console.debug("Avg USD (map/reduce):", avg);
    } catch (e) {
      const ts = getLastLoadTsFor(url);
      const lastTxt = ts ? new Date(ts).toLocaleString("en-US") : "No successful load yet";
      el.coinsContainer.innerHTML = `
        <div class="col-12">
          <div class="alert alert-danger" role="alert">
            <div class="d-flex align-items-center gap-2 mb-2">
              <i class="bi bi-exclamation-triangle-fill"></i><strong>Failed to load coins</strong>
            </div>
            <p class="mb-2">Could not fetch data from CoinCap.</p>
            <p class="mb-0 text-muted small">${escapeHtml(lastTxt)}</p>
          </div>
          <div class="d-flex gap-2">
            <button class="btn btn-primary" id="reload-btn"><i class="bi bi-arrow-clockwise"></i> Try again</button>
          </div>
        </div>`;
      document.getElementById("reload-btn")?.addEventListener("click", () => location.reload());
      el.loadInfo.classList.remove("d-none");
    } finally {
      await wait(250); 
      showSpinner(false);
    }
  }

  async function loadRates() {
    if (ratesCache && Date.now() - ratesCache.ts < TTL_INFO_MS) return ratesCache.bySymbol;
    const json = await getJSON(ratesURL, TTL_INFO_MS);
    const arr = Array.isArray(json?.data) ? json.data : [];
    const bySymbol = Object.fromEntries(arr.map((r) => [r.symbol, Number(r.rateUsd || 0)])); // USD per 1 unit
    ratesCache = { bySymbol, ts: Date.now() };
    return bySymbol;
  }

  async function convertFromUsd(usd) {
    const rates = await loadRates();
    const to = (sym) => {
      const rateUsd = rates[sym]; 
      return rateUsd ? usd / rateUsd : null;
    };
    return { USD: usd, EUR: to("EUR"), ILS: to("ILS") };
  }

  async function loadAssetById(id) {
    const json = await getJSON(assetByIdURL(id), TTL_INFO_MS);
    return json?.data || null; 
  }

  function renderCoins() {
    const onlySel = el.onlySelected.checked;
    const q = (el.searchInput.value || "").trim().toUpperCase();

    let list = [...assets];
    if (q) {
      const valid = /^[A-Z]{2,10}$/.test(q);
      list = valid ? list.filter((a) => a.symbol === q) : [];
    }
    if (onlySel) list = list.filter((a) => selected.includes(a.symbol));

    filtered = list;
    updatePaging();

    const items = pageSlice();
    const frag = document.createDocumentFragment();

    items.forEach((a) => {
      const col = document.createElement("div");
      col.className = "col-12 col-sm-6 col-md-4 col-lg-3";
      const collapseId = `extra-${a.id}`;
      const isOn = selected.includes(a.symbol);

      col.innerHTML = `
        <div class="card coin-card h-100 shadow-sm">
          <div class="card-body d-flex flex-column">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div class="d-flex align-items-center gap-2 mb-1">
                  <span class="symbol h5 mb-0">${escapeHtml(a.symbol)}</span>
                  ${a.rank ? `<span class="badge bg-secondary small">#${a.rank}</span>` : ""}
                </div>
                <div class="text-muted small mb-1">${escapeHtml(a.name)}</div>
                <div class="text-success small fw-bold">${
                  a.priceUsd ? `$${a.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })}` : "N/A"
                }</div>
              </div>
              <button class="btn btn-outline-primary btn-sm toggle-btn ${isOn ? "active" : ""}" data-symbol="${escapeHtml(a.symbol)}">
                ${isOn ? "ON" : "OFF"}
              </button>
            </div>
            <div class="mt-3 d-grid">
              <button class="btn btn-light border d-flex justify-content-center align-items-center gap-2"
                      data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="false">
                <i class="bi bi-info-circle"></i> Info More
              </button>
            </div>
            <div class="collapse mt-3" id="${collapseId}" data-coin-id="${escapeHtml(a.id)}">
              <div class="moreinfo-body border rounded p-3">
                <div class="progress progress-tiny mb-2">
                  <div class="progress-bar progress-bar-striped progress-bar-animated indeterminate"></div>
                </div>
                <div class="text-muted">Loading details…</div>
              </div>
            </div>
          </div>
        </div>`;
      frag.appendChild(col);
    });

    el.coinsContainer.replaceChildren(frag);
    el.noResults.classList.toggle("d-none", filtered.length !== 0);
  }

  
  function updatePaging() {
    const total = filtered.length;
    pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) page = pages;
    if (page < 1) page = 1;

    el.curPage.textContent = `page ${page}`;
    el.totPages.textContent = pages;

    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    el.showRange.textContent = `Show ${total ? start : 0}-${end}`;
    el.totCoins.textContent = `${total} Coins`;

    el.prevBtn.disabled = page <= 1;
    el.nextBtn.disabled = page >= pages;
    el.paging.classList.toggle("d-none", total <= pageSize);
  }
  function pageSlice() {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }

  document.addEventListener("click", (ev) => {
    const link = ev.target.closest("a.nav-link, #nav-home");
    if (!link) return;
    ev.preventDefault();
    const view = link.id === "nav-home" ? "coins" : link.getAttribute("data-view");
    switchView(view || "coins");
  });

  function switchView(view) {
    el.coinsSection.classList.toggle("d-none", view !== "coins");
    el.reportsSection.classList.toggle("d-none", view !== "reports");
    el.aboutSection.classList.toggle("d-none", view !== "about");
    document.querySelectorAll("a.nav-link").forEach((a) => a.classList.remove("active"));
    const active = document.querySelector(`a.nav-link[data-view='${view}']`);
    if (active) active.classList.add("active");
    if (view === "reports") startReports(); else stopReports();
  }

  el.searchForm.addEventListener("submit", (e) => { e.preventDefault(); page = 1; renderCoins(); });
  el.onlySelected.addEventListener("change", () => { page = 1; renderCoins(); });
  el.sizeTop.addEventListener("change", (e) => { pageSize = parseInt(e.target.value, 10); page = 1; renderCoins(); });
  el.sizeBottom.addEventListener("change", (e) => { pageSize = parseInt(e.target.value, 10); page = 1; renderCoins(); });
  el.prevBtn.addEventListener("click", () => { if (page > 1) { page--; renderCoins(); } });
  el.nextBtn.addEventListener("click", () => { if (page < pages) { page++; renderCoins(); } });

  el.coinsContainer.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".toggle-btn"); if (!btn) return;
    const sym = btn.getAttribute("data-symbol"); if (!sym) return;

    const idx = selected.indexOf(sym);
    if (idx >= 0) {
      selected.splice(idx, 1);
      btn.classList.remove("active");
      btn.textContent = "OFF";
      persistSelected();
      if (!el.reportsSection.classList.contains("d-none")) startReports();
    } else {
      if (selected.length < 5) {
        selected.push(sym);
        btn.classList.add("active");
        btn.textContent = "ON";
        persistSelected();
        if (!el.reportsSection.classList.contains("d-none")) startReports();
      } else {
        openReplaceModal(sym);
      }
    }
  });

  function openReplaceModal(requested) {
    el.limitList.replaceChildren();
    selected.forEach((s, i) => {
      const label = document.createElement("label");
      label.className = "list-group-item d-flex justify-content-between align-items-center";
      label.innerHTML = `
        <div class="d-flex align-items-center gap-2">
          <input class="form-check-input me-1" type="radio" name="to-remove" value="${s}" ${i === 0 ? "checked" : ""}>
          <span>${s}</span>
        </div>
        <span class="badge bg-primary rounded-pill">in report</span>`;
      el.limitList.appendChild(label);
    });
    el.limitConfirm.onclick = () => {
      const toRemove = el.limitList.querySelector("input[name='to-remove']:checked")?.value;
      if (!toRemove) return;
      selected = selected.filter((x) => x !== toRemove);
      selected.push(requested);
      persistSelected();
      document.querySelectorAll(".toggle-btn").forEach((b) => {
        const s = b.getAttribute("data-symbol");
        const on = selected.includes(s);
        b.classList.toggle("active", on);
        b.textContent = on ? "ON" : "OFF";
      });
      bootstrap.Modal.getOrCreateInstance(el.limitModal).hide();
      if (!el.reportsSection.classList.contains("d-none")) startReports();
    };
    bootstrap.Modal.getOrCreateInstance(el.limitModal).show();
  }

  document.addEventListener("show.bs.collapse", async (ev) => {
    const wrap = ev.target.closest("[data-coin-id]");
    if (!wrap) return;
    const coinId = wrap.getAttribute("data-coin-id");
    const container = wrap.querySelector(".moreinfo-body");
    if (!coinId || !container) return;

    const cached = infoCache[coinId];
    if (cached && Date.now() - cached.ts < TTL_INFO_MS) {
      renderMoreInfo(container, cached.data, true);
      return;
    }
    try {
      const data = await loadAssetById(coinId);
      infoCache[coinId] = { data, ts: Date.now() };
      renderMoreInfo(container, data, false);
    } catch {
      container.innerHTML = `<div class="alert alert-danger m-0">Error loading details.</div>`;
    }
  });

  async function renderMoreInfo(container, data, fromCache) {
    const usd = Number(data?.priceUsd || 0);
    const conv = await convertFromUsd(usd);
    container.innerHTML = `
      <div class="row g-2">
        <div class="col-12 col-sm-4"><span class="badge text-bg-light border price-badge w-100">USD</span><div class="mt-1">${conv.USD ? "$" + conv.USD.toLocaleString("en-US") : "N/A"}</div></div>
        <div class="col-12 col-sm-4"><span class="badge text-bg-light border price-badge w-100">EUR</span><div class="mt-1">${typeof conv.EUR === "number" ? "€" + conv.EUR.toLocaleString("en-US") : "N/A"}</div></div>
        <div class="col-12 col-sm-4"><span class="badge text-bg-light border price-badge w-100">ILS</span><div class="mt-1">${typeof conv.ILS === "number" ? "₪" + conv.ILS.toLocaleString("en-US") : "N/A"}</div></div>
      </div>
      <div class="mt-2 small text-muted">${fromCache ? "Loaded from cache (≤2m)" : "Fresh data"}</div>
      ${data?.explorer ? `<div class="mt-2"><a class="link-secondary" href="${escapeHtml(data.explorer)}" target="_blank" rel="noopener">Explorer</a></div>` : ""}`;
  }

  function startReports() {
    stopReports();
    renderBadges();

    if (!selected.length) {
      el.noSelected.classList.remove("d-none");
      el.chartContainer.classList.add("d-none");
      return;
    }
    el.noSelected.classList.add("d-none");
    el.chartContainer.classList.remove("d-none");

    if (typeof CanvasJS === "undefined" || typeof CanvasJS.Chart !== "function") {
      el.chartMessages.innerHTML = `<div class="alert alert-danger"><i class="bi bi-exclamation-triangle"></i> Chart library failed to load.</div>`;
      return;
    }

    if (chart) { chart.destroy(); chart = null; }
    el.chartMessages.innerHTML = `<div class="alert alert-info"><div class="text-center p-3">
      <div class="progress progress-thin mb-3"><div class="progress-bar progress-bar-striped progress-bar-animated indeterminate"></div></div>
      <span>Preparing chart…</span></div></div>`;

    const series = selected.map((sym) => ({ type: "line", name: sym, showInLegend: true, dataPoints: [] }));
    chart = new CanvasJS.Chart("chartContainer", {
      animationEnabled: false,
      theme: "light2",
      axisX: { valueFormatString: window.innerWidth <= 768 ? "HH:mm" : "HH:mm:ss" },
      axisY: { title: "Price (USD)" },
      legend: { cursor: "pointer" },
      data: series,
      height: window.innerWidth <= 768 ? 300 : 420,
      interactivityEnabled: true,
      zoomEnabled: true,
      zoomType: "x",
    });
    chart.render();
    el.chartMessages.innerHTML = "";

    pollTimer = setInterval(pollPrices, POLL_MS);
    pollPrices();
  }
  function stopReports() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollPrices() {
    if (!selected.length || !chart) return;
    const url = cryptoCompareURL(selected.join(","));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const now = new Date();
      let changed = false;

      selected.forEach((sym, i) => {
        const price = json?.[sym]?.USD;
        if (typeof price === "number" && chart.options.data[i]) {
          const pts = chart.options.data[i].dataPoints;
          pts.push({ x: now, y: price });
          if (pts.length > 60) pts.splice(0, pts.length - 60); 
          changed = true;
        }
      });
      if (changed) chart.render();
    } catch {
      if (!document.querySelector("#chart-messages .alert-warning")) {
        el.chartMessages.innerHTML = `<div class="alert alert-warning alert-dismissible fade show" role="alert">
          <i class="bi bi-exclamation-triangle"></i> Could not fetch latest prices. Retrying…
          <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>`;
        setTimeout(() => { document.querySelector("#chart-messages .alert-warning")?.remove(); }, 5000);
      }
    }
  }

  function renderBadges() {
    el.selectedBadges.replaceChildren(
      ...selected.map((s) => {
        const b = document.createElement("span");
        b.className = "badge text-bg-primary";
        b.textContent = s;
        return b;
      })
    );
  }

  window.addEventListener("resize", () => {
    if (chart && !el.reportsSection.classList.contains("d-none")) setTimeout(() => chart.render(), 100);
  });
  window.addEventListener("beforeunload", () => {
    stopReports();
    if (chart) { chart.destroy(); chart = null; }
  });

  await loadAssets();
})();
