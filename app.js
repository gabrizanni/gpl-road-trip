(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const euro = new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  });
  const decimal = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    config: null,
    snapshot: null,
    day: new URLSearchParams(location.search).get("day") === "2" ? 2 : 1,
    zoneId: null,
    filter: localStorage.getItem("gpl-road-trip-filter") || "balanced",
    selectedId: null,
    map: null,
    routeLayer: null,
    stationLayer: null,
    markers: new Map(),
    installPrompt: null,
    currentStations: []
  };

  function currentLeg() {
    return state.config.legs.find((leg) => leg.day === state.day) || state.config.legs[0];
  }

  function currentZone() {
    const leg = currentLeg();
    return leg.fuelWindows.find((zone) => zone.id === state.zoneId) || leg.fuelWindows[0];
  }

  function toDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function dateLabel(value, includeTime = true) {
    const parsed = toDate(value);
    if (!parsed) return "non comunicata";
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "short",
      ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {})
    }).format(parsed);
  }

  function ageHours(value) {
    const parsed = toDate(value);
    return parsed ? Math.max(0, (Date.now() - parsed.getTime()) / 3600000) : Number.POSITIVE_INFINITY;
  }

  function haversine(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLng = (b[1] - a[1]) * rad;
    const lat1 = a[0] * rad;
    const lat2 = b[0] * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  async function loadJson(path) {
    const response = await fetch(path, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  async function loadSnapshot() {
    const attempts = await Promise.allSettled([loadJson("./data/latest.json"), loadJson("./data/seed.json")]);
    const snapshots = attempts
      .filter((attempt) => attempt.status === "fulfilled")
      .map((attempt) => attempt.value);
    if (!snapshots.length) throw new Error("Nessuno snapshot disponibile");
    return snapshots.find((snapshot) => Array.isArray(snapshot.stations) && snapshot.stations.length) || snapshots[0];
  }

  function stationMatch(station, zoneId = state.zoneId) {
    const explicit = Array.isArray(station.matches)
      ? station.matches.find((match) => match.legId === currentLeg().id && match.zoneId === zoneId)
      : null;
    if (explicit) return explicit;

    const zone = currentLeg().fuelWindows.find((candidate) => candidate.id === zoneId);
    if (!zone || !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) return null;
    const zoneDistanceKm = haversine([station.lat, station.lng], zone.center);
    if (zoneDistanceKm > zone.radiusKm) return null;
    return { legId: currentLeg().id, zoneId, zoneDistanceKm, routeDistanceKm: null };
  }

  function filteredStations() {
    const zone = currentZone();
    const stations = (state.snapshot?.stations || [])
      .filter((station) => String(station.fuel || "GPL").toUpperCase() === "GPL")
      .map((station) => ({ ...station, match: stationMatch(station) }))
      .filter((station) => station.match);

    const finite = (value, fallback = Number.POSITIVE_INFINITY) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const prices = stations.map((station) => finite(station.price)).filter(Number.isFinite);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : minPrice + 0.001;
    const balancedScore = (station) => {
      const priceScore = Number.isFinite(Number(station.price))
        ? (Number(station.price) - minPrice) / Math.max(0.001, maxPrice - minPrice)
        : 1.4;
      const distanceScore = Math.min(finite(station.match.routeDistanceKm, 24) / 12, 2);
      const freshnessScore = Math.min(ageHours(station.communicatedAt) / (24 * 14), 2);
      const curatedBonus = finite(station.match.priority, 9) * 0.035;
      return priceScore * 0.55 + distanceScore * 0.25 + freshnessScore * 0.15 + curatedBonus;
    };

    return stations.sort((a, b) => {
      if (state.filter === "price") return finite(a.price) - finite(b.price);
      if (state.filter === "distance") return finite(a.match.routeDistanceKm) - finite(b.match.routeDistanceKm);
      if (state.filter === "fresh") return (toDate(b.communicatedAt)?.getTime() || 0) - (toDate(a.communicatedAt)?.getTime() || 0);
      return balancedScore(a) - balancedScore(b);
    });
  }

  function mapsUrl(station) {
    const destination = Number.isFinite(station.lat) && Number.isFinite(station.lng)
      ? `${station.lat},${station.lng}`
      : [station.name, station.address, station.municipality, station.province].filter(Boolean).join(" ");
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  }

  function detailsUrl(station) {
    if (station.detailsUrl) return station.detailsUrl;
    if (/^\d+$/.test(String(station.id))) {
      return `https://carburanti.mise.gov.it/ospzSearch/dettaglio/${encodeURIComponent(station.id)}`;
    }
    return "https://carburanti.mise.gov.it/ospzSearch/";
  }

  function stationMeta(station, includeHours = true) {
    const parts = [];
    if (Number.isFinite(Number(station.match?.routeDistanceKm))) {
      parts.push(`~${decimal.format(Number(station.match.routeDistanceKm))} km dalla traccia indicativa`);
    }
    parts.push(station.isSelf ? "self" : "servito");
    if (station.communicatedAt) parts.push(`prezzo ${dateLabel(station.communicatedAt)}`);
    if (includeHours && station.openingHours) parts.push(station.openingHours);
    return parts.join(" · ");
  }

  function renderHeaderAndTabs() {
    $$(".day-tab").forEach((tab) => {
      const active = Number(tab.dataset.day) === state.day;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
  }

  function renderRoute() {
    const leg = currentLeg();
    $("#leg-label").textContent = leg.label;
    $("#leg-title").textContent = leg.title;
    $("#full-route-link").href = leg.googleMapsUrl;
    const stepper = $("#route-stepper");
    stepper.replaceChildren();

    leg.stops.forEach((stop, index) => {
      const item = document.createElement("li");
      const isActive = stop.fuelZone && stop.fuelZone === state.zoneId;
      item.classList.toggle("is-active", isActive);

      const numberNode = document.createElement("span");
      numberNode.className = "step-number";
      numberNode.textContent = String(index + 1);
      const name = document.createElement(stop.fuelZone ? "button" : "span");
      name.className = "step-name";
      name.textContent = stop.shortName;
      if (stop.fuelZone) {
        name.type = "button";
        name.dataset.fuel = "true";
        name.title = `Mostra distributori: ${stop.name}`;
        if (isActive) name.setAttribute("aria-current", "step");
        name.addEventListener("click", () => {
          state.zoneId = stop.fuelZone;
          state.selectedId = null;
          renderAll();
        });
      }
      item.append(numberNode, name);
      stepper.append(item);
    });
  }

  function setSnapshotStatus() {
    const dataAge = ageHours(state.snapshot?.generatedAt || state.snapshot?.sourceUpdatedAt);
    const chip = $("#data-status");
    const curated = state.snapshot?.mode === "curated-seed";
    if (dataAge > 72) {
      chip.className = "status-chip status-error";
      chip.textContent = "Dati scaduti";
    } else if (dataAge > 36) {
      chip.className = "status-chip status-cached";
      chip.textContent = "Copia salvata";
    } else {
      chip.className = `status-chip ${curated ? "status-cached" : "status-live"}`;
      chip.textContent = curated ? "Dati iniziali" : "Dati MIMIT";
    }
    const when = state.snapshot?.sourceUpdatedAt || state.snapshot?.generatedAt;
    $("#last-update").textContent = `Ultimo dato disponibile: ${dateLabel(when)}`;
  }

  function makeButtonLink(className, label, href) {
    const link = document.createElement("a");
    link.className = className;
    link.textContent = label;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function renderVehicle() {
    const vehicle = state.config.vehicle;
    const percentage = Math.round((vehicle.planningRangeKm / vehicle.declaredRangeKm) * 100);
    $("#declared-range").textContent = String(vehicle.declaredRangeKm);
    $("#planning-range").textContent = String(vehicle.planningRangeKm);
    const ring = $(".range-ring");
    ring.style.setProperty("--range-percentage", `${percentage}%`);
    ring.setAttribute("aria-valuenow", String(percentage));
    $(".range-ring span").textContent = `${percentage}%`;
  }

  function updateMobileAction(station) {
    const bar = $("#mobile-action-bar");
    if (!station) {
      bar.hidden = true;
      return;
    }
    $("#mobile-station-name").textContent = station.name || station.brand || "Impianto GPL";
    $("#mobile-station-price").textContent = Number.isFinite(Number(station.price))
      ? `${euro.format(Number(station.price))}/L`
      : "Prezzo n.d.";
    $("#mobile-navigate-link").href = mapsUrl(station);
    bar.hidden = false;
  }

  function renderPrimary(station, animate = true) {
    const host = $("#primary-station");
    host.replaceChildren();
    if (!station) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Nessun impianto GPL nella copia disponibile per questa area.";
      host.append(empty);
      updateMobileAction(null);
      return;
    }

    const card = document.createElement("article");
    card.className = "primary-station";
    const copy = document.createElement("div");
    copy.className = "primary-station-copy";
    const name = document.createElement("strong");
    name.textContent = station.name || station.brand || "Impianto GPL";
    const address = document.createElement("span");
    address.textContent = [station.address, station.municipality, station.province].filter(Boolean).join(" · ");
    const meta = document.createElement("span");
    meta.textContent = stationMeta(station, false);
    const price = document.createElement("b");
    price.className = "primary-price";
    price.textContent = Number.isFinite(Number(station.price)) ? `${euro.format(Number(station.price))}/L` : "Prezzo n.d.";
    const proof = document.createElement("div");
    proof.className = "primary-proof-row";
    const fuelProof = document.createElement("span");
    fuelProof.className = "proof-chip proof-gpl";
    fuelProof.textContent = station.isSelf ? "GPL self" : "GPL servito";
    const hoursProof = document.createElement("span");
    hoursProof.className = "proof-chip proof-hours";
    hoursProof.textContent = station.openingHours || "Orari da verificare";
    proof.append(fuelProof, hoursProof);
    copy.append(name, address, meta, proof, price);

    const actions = document.createElement("div");
    actions.className = "primary-actions";
    actions.append(
      makeButtonLink("button button-primary", "Naviga", mapsUrl(station)),
      makeButtonLink("button button-secondary", "Verifica", detailsUrl(station))
    );
    if (animate) card.classList.add("motion-enter");
    card.append(copy, actions);
    host.append(card);
    updateMobileAction(station);
  }

  function fillStationMeta(node, station) {
    node.replaceChildren();
    const values = [
      Number.isFinite(Number(station.match?.routeDistanceKm))
        ? `~${decimal.format(Number(station.match.routeDistanceKm))} km dalla traccia`
        : "Distanza n.d.",
      station.isSelf ? "Self" : "Servito",
      station.communicatedAt ? `Agg. ${dateLabel(station.communicatedAt, false)}` : "Data n.d."
    ];
    values.forEach((value, index) => {
      const chip = document.createElement("span");
      chip.className = `station-meta-chip${index === 2 ? " is-price" : ""}`;
      chip.textContent = value;
      node.append(chip);
    });
    if (station.openingHours) {
      const hours = document.createElement("span");
      hours.className = "station-hours";
      hours.textContent = `Orari dichiarati: ${station.openingHours}`;
      node.append(hours);
    }
  }

  function stationCard(station, rank) {
    const fragment = $("#station-card-template").content.cloneNode(true);
    const card = $(".station-card", fragment);
    card.dataset.stationId = String(station.id);
    card.classList.add("motion-enter");
    card.style.setProperty("--motion-delay", `${Math.min(Math.max(0, rank - 2) * 40, 240)}ms`);
    card.classList.toggle("is-selected", String(station.id) === String(state.selectedId));
    $(".station-rank", card).textContent = String(rank);
    $(".station-name", card).textContent = station.name || station.brand || "Impianto GPL";
    $(".station-address", card).textContent = [station.address, station.municipality, station.province].filter(Boolean).join(" · ") || "Indirizzo non comunicato";
    fillStationMeta($(".station-meta", card), station);
    $(".station-price", card).textContent = Number.isFinite(Number(station.price)) ? `${euro.format(Number(station.price))}/L` : "n.d.";
    const details = $(".station-details", card);
    details.href = detailsUrl(station);
    details.textContent = station.detailsUrl ? "Verifica fonte" : "Scheda MIMIT";
    $(".station-navigate", card).href = mapsUrl(station);
    const select = $(".station-select", card);
    select.setAttribute("aria-pressed", String(String(station.id) === String(state.selectedId)));
    select.addEventListener("click", () => selectStation(station, true));
    return fragment;
  }

  function renderEmptyList() {
    const zone = currentZone();
    const box = document.createElement("div");
    box.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "Nessun prezzo GPL in questa copia";
    const text = document.createElement("p");
    text.textContent = "Usa la ricerca esterna e verifica apertura e prezzo prima di deviare.";
    const link = makeButtonLink(
      "button button-primary",
      "Cerca GPL su Maps",
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`GPL vicino ${zone.label}`)}`
    );
    box.append(title, text, link);
    return box;
  }

  function renderStations() {
    const zone = currentZone();
    const stations = filteredStations();
    $("#recommendation-title").textContent = zone.label;
    $$(".filter-chip").forEach((button) => {
      const active = button.dataset.filter === state.filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    if (!stations.some((station) => String(station.id) === String(state.selectedId))) {
      state.selectedId = stations[0]?.id ?? null;
    }
    const primary = stations[0];
    renderPrimary(primary);
    state.currentStations = stations;

    const list = $("#station-list");
    list.replaceChildren();
    const alternatives = stations.slice(1, 8);
    $("#station-count").textContent = `${alternatives.length} alternativ${alternatives.length === 1 ? "a" : "e"}`;
    if (!stations.length) {
      list.append(renderEmptyList());
    } else if (!alternatives.length) {
      const note = document.createElement("div");
      note.className = "empty-state empty-state-compact";
      note.textContent = "Nessun’altra alternativa nella copia disponibile per questa area.";
      list.append(note);
    } else {
      alternatives.forEach((station, index) => list.append(stationCard(station, index + 2)));
    }
    updateMap(stations);
  }

  function routeIcon(index) {
    return L.divIcon({
      className: "route-marker-wrap",
      html: `<span class="route-marker">${index + 1}</span>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function stationIcon(selected) {
    return L.divIcon({
      className: "station-marker-wrap",
      html: `<span class="station-marker${selected ? " is-selected" : ""}">GPL</span>`,
      iconSize: selected ? [40, 40] : [34, 34],
      iconAnchor: selected ? [20, 20] : [17, 17]
    });
  }

  function popupNode(station) {
    const root = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = station.name || "Impianto GPL";
    const price = document.createElement("div");
    price.textContent = Number.isFinite(Number(station.price)) ? `${euro.format(Number(station.price))}/L` : "Prezzo n.d.";
    const link = makeButtonLink("", "Avvia navigazione", mapsUrl(station));
    root.append(title, price, link);
    return root;
  }

  function initMap() {
    if (!window.L) {
      $("#map-unavailable").hidden = false;
      return;
    }
    state.map = L.map("map", {
      zoomControl: false,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion
    });
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);
    state.stationLayer = L.layerGroup().addTo(state.map);
  }

  function fitRoute() {
    if (!state.map || !state.routeLayer) return;
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [34, 34] });
  }

  function updateMap(stations = filteredStations()) {
    if (!state.map) return;
    const leg = currentLeg();
    if (state.routeLayer) state.routeLayer.remove();
    state.stationLayer.clearLayers();
    state.markers.clear();
    state.routeLayer = L.polyline(leg.route, { color: "#2f6bff", weight: 6, opacity: 0.88 }).addTo(state.map);
    leg.stops.forEach((stop, index) => {
      L.marker([stop.lat, stop.lng], { icon: routeIcon(index) })
        .bindTooltip(stop.name, { direction: "top" })
        .addTo(state.stationLayer);
    });
    stations.slice(0, 16).forEach((station) => {
      if (!Number.isFinite(station.lat) || !Number.isFinite(station.lng)) return;
      const selected = String(station.id) === String(state.selectedId);
      const marker = L.marker([station.lat, station.lng], { icon: stationIcon(selected), zIndexOffset: selected ? 1000 : 0 })
        .bindPopup(popupNode(station))
        .addTo(state.stationLayer);
      marker.on("click", () => selectStation(station, false));
      state.markers.set(String(station.id), marker);
    });
    fitRoute();
    setTimeout(() => state.map?.invalidateSize(), 60);
  }

  function selectStation(station, panToStation) {
    state.selectedId = station.id;
    $$(".station-card").forEach((card) => {
      const selected = card.dataset.stationId === String(station.id);
      card.classList.toggle("is-selected", selected);
      $(".station-select", card)?.setAttribute("aria-pressed", String(selected));
    });
    for (const candidate of state.currentStations) {
      const marker = state.markers.get(String(candidate.id));
      if (!marker) continue;
      const selected = String(candidate.id) === String(station.id);
      marker.setIcon(stationIcon(selected));
      marker.setZIndexOffset(selected ? 1000 : 0);
    }
    if (panToStation && state.map && Number.isFinite(station.lat) && Number.isFinite(station.lng)) {
      state.map.setView([station.lat, station.lng], Math.max(13, state.map.getZoom()), { animate: !reducedMotion });
      state.markers.get(String(station.id))?.openPopup();
    } else if (!panToStation) {
      setTimeout(() => state.markers.get(String(station.id))?.openPopup(), 0);
    }
  }

  function renderAll() {
    renderHeaderAndTabs();
    renderRoute();
    renderVehicle();
    setSnapshotStatus();
    renderStations();
    const url = new URL(location.href);
    url.searchParams.set("day", String(state.day));
    history.replaceState(null, "", url);
  }

  function bindEvents() {
    $$(".day-tab").forEach((tab) => tab.addEventListener("click", () => {
      state.day = Number(tab.dataset.day);
      state.zoneId = currentLeg().fuelWindows[0].id;
      state.selectedId = null;
      renderAll();
    }));
    $$(".filter-chip").forEach((button) => button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      state.selectedId = null;
      localStorage.setItem("gpl-road-trip-filter", state.filter);
      renderStations();
    }));
    $("#fit-route-button").addEventListener("click", fitRoute);
    $("#my-location-button").addEventListener("click", () => {
      if (!navigator.geolocation || !state.map) return;
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => state.map.setView([coords.latitude, coords.longitude], 13, { animate: !reducedMotion }),
        () => alert("Posizione non disponibile. Controlla i permessi del browser."),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
    $("#refresh-button").addEventListener("click", () => location.reload());
    $("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
    $("#install-button").addEventListener("click", async () => {
      if (state.installPrompt) {
        state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
      } else {
        $("#help-dialog").showModal();
      }
    });
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      $("#install-button").hidden = false;
    });
    window.addEventListener("appinstalled", () => { $("#install-button").hidden = true; });
    const updateConnectionBanner = () => { $("#offline-banner").hidden = navigator.onLine; };
    window.addEventListener("online", updateConnectionBanner);
    window.addEventListener("offline", updateConnectionBanner);
    updateConnectionBanner();

    const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (!installed) $("#install-button").hidden = false;
  }

  async function start() {
    try {
      [state.config, state.snapshot] = await Promise.all([loadJson("./data/routes.json"), loadSnapshot()]);
      state.zoneId = currentLeg().fuelWindows[0].id;
      initMap();
      bindEvents();
      renderAll();
      if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
        navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("Service worker:", error));
      }
    } catch (error) {
      console.error(error);
      $("#leg-title").textContent = "Percorso disponibile su Google Maps";
      $("#recommendation-title").textContent = "Dati locali non caricati";
      $("#data-status").className = "status-chip status-error";
      $("#data-status").textContent = "Riprova online";
      const list = $("#station-list");
      list.replaceChildren();
      const message = document.createElement("div");
      message.className = "empty-state";
      message.textContent = "Apri di nuovo la pagina con connessione. I file di viaggio restano nel pacchetto scaricato.";
      list.append(message);
    }
  }

  start();
})();
