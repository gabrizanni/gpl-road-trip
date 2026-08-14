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
  const isFiniteNumber = (value) => value !== null && value !== "" && Number.isFinite(Number(value));

  const state = {
    config: null,
    snapshot: null,
    day: new URLSearchParams(location.search).get("day") === "2" ? 2 : 1,
    zoneId: null,
    filter: localStorage.getItem("gpl-road-trip-filter") || "balanced",
    planningRangeKm: null,
    allowPetrol: true,
    selectedId: null,
    map: null,
    routeLayer: null,
    stationLayer: null,
    markers: new Map(),
    resizeObserver: null,
    mapLayoutFrame: null,
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

  function normalizedPlanningRange(value) {
    const vehicle = state.config.vehicle;
    const minimum = Number(vehicle.planningRangeMinKm) || 300;
    const maximum = Number(vehicle.planningRangeMaxKm) || 320;
    const step = Number(vehicle.planningRangeStepKm) || 10;
    const numeric = Number(value);
    const fallback = Number(vehicle.planningRangeKm) || 310;
    const clamped = Math.min(maximum, Math.max(minimum, Number.isFinite(numeric) ? numeric : fallback));
    return Math.round((clamped - minimum) / step) * step + minimum;
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
    const vehicle = state.config.vehicle;
    const dynamicTarget = Boolean(zone.dynamicTarget);
    const maximumProgressKm = Number(vehicle.declaredRangeKm)
      + (state.allowPetrol ? Number(vehicle.petrolBufferKm) || 0 : 0);
    let stations = (state.snapshot?.stations || [])
      .filter((station) => String(station.fuel || "GPL").toUpperCase() === "GPL")
      .map((station) => {
        const match = stationMatch(station);
        const progressKm = Number(match?.progressKm);
        return {
          ...station,
          match,
          targetProgressKm: Number.isFinite(progressKm) ? progressKm : null,
          targetDeltaKm: dynamicTarget && Number.isFinite(progressKm)
            ? Math.abs(progressKm - state.planningRangeKm)
            : null,
          withinTarget: dynamicTarget && Number.isFinite(progressKm)
            ? Math.abs(progressKm - state.planningRangeKm) <= 20
            : false,
          petrolKm: dynamicTarget && Number.isFinite(progressKm)
            ? Math.max(0, progressKm - Number(vehicle.declaredRangeKm))
            : 0
        };
      })
      .filter((station) => station.match);

    if (dynamicTarget) {
      const feasible = stations.filter((station) =>
        station.targetProgressKm === null || station.targetProgressKm <= maximumProgressKm
      );
      if (feasible.length) stations = feasible;
    }

    const finite = (value, fallback = Number.POSITIVE_INFINITY) => isFiniteNumber(value) ? Number(value) : fallback;
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
      const targetScore = dynamicTarget ? Math.min(finite(station.targetDeltaKm, 120) / 80, 2) : 0;
      return dynamicTarget
        ? priceScore * 0.32 + distanceScore * 0.18 + freshnessScore * 0.1 + targetScore * 0.4 + curatedBonus
        : priceScore * 0.55 + distanceScore * 0.25 + freshnessScore * 0.15 + curatedBonus;
    };

    return stations.sort((a, b) => {
      if (dynamicTarget) {
        const targetDifference = finite(a.targetDeltaKm, 999) - finite(b.targetDeltaKm, 999);
        if (Math.abs(targetDifference) > 10) return targetDifference;
      }
      if (state.filter === "price") return finite(a.price) - finite(b.price);
      if (state.filter === "distance") return finite(a.match.routeDistanceKm) - finite(b.match.routeDistanceKm);
      if (state.filter === "fresh") return (toDate(b.communicatedAt)?.getTime() || 0) - (toDate(a.communicatedAt)?.getTime() || 0);
      return balancedScore(a) - balancedScore(b);
    });
  }

  function mappedStationsForCurrentLeg() {
    const leg = currentLeg();
    const zones = new Map(leg.fuelWindows.map((zone) => [zone.id, zone]));
    return (state.snapshot?.stations || [])
      .filter((station) => String(station.fuel || "GPL").toUpperCase() === "GPL")
      .filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lng))
      .map((station) => {
        const explicitMatches = Array.isArray(station.matches)
          ? station.matches.filter((match) => match.legId === leg.id && zones.has(match.zoneId))
          : [];
        const inferredMatches = explicitMatches.length
          ? []
          : leg.fuelWindows
            .map((zone) => ({
              legId: leg.id,
              zoneId: zone.id,
              zoneDistanceKm: haversine([station.lat, station.lng], zone.center),
              routeDistanceKm: null
            }))
            .filter((match) => match.zoneDistanceKm <= zones.get(match.zoneId).radiusKm);
        const legMatches = [...explicitMatches, ...inferredMatches].sort((a, b) => {
          const zonePriority = (zones.get(a.zoneId)?.priority ?? 99) - (zones.get(b.zoneId)?.priority ?? 99);
          if (zonePriority) return zonePriority;
          return (Number(a.progressKm) || 0) - (Number(b.progressKm) || 0);
        });
        if (!legMatches.length) return null;
        const activeMatch = legMatches.find((match) => match.zoneId === state.zoneId) || legMatches[0];
        return { ...station, mapZoneId: activeMatch.zoneId, mapMatch: activeMatch };
      })
      .filter(Boolean);
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
    if (isFiniteNumber(station.targetProgressKm)) {
      parts.push(`~${decimal.format(Number(station.targetProgressKm))} km dal pieno`);
    }
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
    const percentage = Math.round((state.planningRangeKm / vehicle.declaredRangeKm) * 100);
    $("#declared-range").textContent = String(vehicle.declaredRangeKm);
    $("#planning-range").textContent = String(state.planningRangeKm);
    const control = $("#planning-range-control");
    control.min = String(vehicle.planningRangeMinKm || 300);
    control.max = String(vehicle.planningRangeMaxKm || 320);
    control.step = String(vehicle.planningRangeStepKm || 10);
    control.value = String(state.planningRangeKm);
    control.setAttribute("aria-valuetext", `Sosta obiettivo a circa ${state.planningRangeKm} chilometri dal pieno`);
    $("#petrol-buffer-control").checked = state.allowPetrol;
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
    if (isFiniteNumber(station.targetProgressKm)) {
      const targetProof = document.createElement("span");
      targetProof.className = `proof-chip ${station.petrolKm > 0 ? "proof-hours" : "proof-target"}`;
      targetProof.textContent = station.petrolKm > 0
        ? `~${decimal.format(station.targetProgressKm)} km · ~${decimal.format(station.petrolKm)} km a benzina`
        : `~${decimal.format(station.targetProgressKm)} km dal pieno${station.withinTarget ? " · nel target" : ""}`;
      proof.append(targetProof);
    }
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
      ...(isFiniteNumber(station.targetProgressKm)
        ? [`~${decimal.format(Number(station.targetProgressKm))} km dal pieno${station.withinTarget ? " · nel target" : ""}`]
        : []),
      Number.isFinite(Number(station.match?.routeDistanceKm))
        ? `~${decimal.format(Number(station.match.routeDistanceKm))} km dalla traccia`
        : "Distanza n.d.",
      station.isSelf ? "Self" : "Servito",
      station.communicatedAt ? `Agg. ${dateLabel(station.communicatedAt, false)}` : "Data n.d."
    ];
    values.forEach((value, index) => {
      const chip = document.createElement("span");
      const isTarget = isFiniteNumber(station.targetProgressKm) && index === 0;
      chip.className = `station-meta-chip${isTarget ? " is-target" : ""}`;
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

  function renderStations({ fitMap = true } = {}) {
    const zone = currentZone();
    const stations = filteredStations();
    $("#recommendation-title").textContent = zone.dynamicTarget
      ? `Sosta intermedia · obiettivo ~${state.planningRangeKm} km`
      : zone.label;
    $$(".filter-chip").forEach((button) => {
      const active = button.dataset.filter === state.filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    if (!stations.some((station) => String(station.id) === String(state.selectedId))) {
      state.selectedId = stations[0]?.id ?? null;
    }
    const primary = stations.find((station) => String(station.id) === String(state.selectedId)) || stations[0];
    renderPrimary(primary);
    state.currentStations = stations;

    const list = $("#station-list");
    list.replaceChildren();
    const visibleStations = stations.slice(0, 8);
    $("#station-count").textContent = `${visibleStations.length} distributor${visibleStations.length === 1 ? "e" : "i"}`;
    if (!stations.length) {
      list.append(renderEmptyList());
    } else {
      visibleStations.forEach((station, index) => list.append(stationCard(station, index + 1)));
    }
    updateMap({ fit: fitMap });
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
    root.className = "station-popup";
    const title = document.createElement("strong");
    title.textContent = station.name || "Impianto GPL";
    const price = document.createElement("div");
    price.textContent = Number.isFinite(Number(station.price)) ? `${euro.format(Number(station.price))}/L` : "Prezzo n.d.";
    const area = document.createElement("small");
    const zone = currentLeg().fuelWindows.find((candidate) => candidate.id === station.mapZoneId);
    area.textContent = zone?.label || [station.municipality, station.province].filter(Boolean).join(" · ");
    const link = makeButtonLink("station-popup-link", "Avvia navigazione", mapsUrl(station));
    root.append(title, price, area, link);
    return root;
  }

  function initMap() {
    if (!window.L) {
      $("#map-unavailable").hidden = false;
      return;
    }
    state.map = L.map("map", {
      zoomControl: false,
      preferCanvas: false,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion
    });
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      detectRetina: false,
      updateWhenIdle: true,
      keepBuffer: 3,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);
    state.stationLayer = L.layerGroup().addTo(state.map);

    if ("ResizeObserver" in window) {
      state.resizeObserver = new ResizeObserver(() => scheduleMapLayout(false));
      state.resizeObserver.observe($("#map"));
    }
  }

  function fitRoute() {
    if (!state.map || !state.routeLayer) return;
    state.map.invalidateSize({ pan: false, animate: false });
    const bounds = state.routeLayer.getBounds();
    for (const station of mappedStationsForCurrentLeg()) {
      bounds.extend([station.lat, station.lng]);
    }
    state.map.fitBounds(bounds, {
      paddingTopLeft: [34, 88],
      paddingBottomRight: [34, 54],
      animate: false
    });
  }

  function scheduleMapLayout(fit = false) {
    if (!state.map) return;
    if (state.mapLayoutFrame) cancelAnimationFrame(state.mapLayoutFrame);
    state.mapLayoutFrame = requestAnimationFrame(() => {
      state.mapLayoutFrame = requestAnimationFrame(() => {
        state.mapLayoutFrame = null;
        state.map?.invalidateSize({ pan: false, animate: false });
        if (fit) fitRoute();
      });
    });
  }

  function updateMap({ fit = true } = {}) {
    if (!state.map) return;
    const leg = currentLeg();
    const stations = mappedStationsForCurrentLeg();
    if (state.routeLayer) state.routeLayer.remove();
    state.stationLayer.clearLayers();
    state.markers.clear();
    state.routeLayer = L.polyline(leg.route, {
      color: "#2f6bff",
      weight: 6,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(state.map);
    leg.stops.forEach((stop, index) => {
      L.marker([stop.lat, stop.lng], { icon: routeIcon(index) })
        .bindTooltip(stop.name, { direction: "top" })
        .addTo(state.stationLayer);
    });
    stations.forEach((station) => {
      const selected = String(station.id) === String(state.selectedId);
      const marker = L.marker([station.lat, station.lng], {
        icon: stationIcon(selected),
        keyboard: true,
        title: `${station.name || "Distributore GPL"}${Number.isFinite(Number(station.price)) ? ` · ${euro.format(Number(station.price))}/L` : ""}`,
        zIndexOffset: selected ? 1000 : 0
      })
        .bindPopup(popupNode(station))
        .addTo(state.stationLayer);
      marker.on("click", () => selectStation(station, false, { source: "marker" }));
      state.markers.set(String(station.id), marker);
    });
    scheduleMapLayout(fit);
  }

  function revealStationCard(stationId) {
    const card = $$(".station-card").find((candidate) => candidate.dataset.stationId === String(stationId));
    card?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
      inline: "nearest"
    });
  }

  function focusStationOnMap(station, { pan = true, openPopup = true } = {}) {
    if (!state.map || !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) return;
    const marker = state.markers.get(String(station.id));
    if (pan) {
      state.map.setView([station.lat, station.lng], Math.max(13, state.map.getZoom()), {
        animate: !reducedMotion
      });
    }
    if (openPopup) marker?.openPopup();
  }

  function selectStation(station, panToStation, { source = "card" } = {}) {
    const targetZone = station.mapZoneId
      || station.matches?.find((match) => match.legId === currentLeg().id)?.zoneId
      || state.zoneId;
    const zoneChanged = targetZone !== state.zoneId;
    if (zoneChanged) state.zoneId = targetZone;
    state.selectedId = station.id;

    if (zoneChanged) {
      renderRoute();
      renderStations({ fitMap: false });
      setTimeout(() => {
        focusStationOnMap(station, { pan: true, openPopup: true });
        if (source === "marker") revealStationCard(station.id);
      }, 80);
      return;
    }

    const selectedStation = state.currentStations.find((candidate) => String(candidate.id) === String(station.id)) || station;
    renderPrimary(selectedStation, false);
    $$(".station-card").forEach((card) => {
      const selected = card.dataset.stationId === String(station.id);
      card.classList.toggle("is-selected", selected);
      $(".station-select", card)?.setAttribute("aria-pressed", String(selected));
    });
    for (const [candidateId, marker] of state.markers) {
      if (!marker) continue;
      const selected = candidateId === String(station.id);
      marker.setIcon(stationIcon(selected));
      marker.setZIndexOffset(selected ? 1000 : 0);
    }
    focusStationOnMap(station, { pan: panToStation, openPopup: true });
    if (source === "marker") setTimeout(() => revealStationCard(station.id), 40);
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
    $("#planning-range-control").addEventListener("input", (event) => {
      state.planningRangeKm = normalizedPlanningRange(event.target.value);
      state.selectedId = null;
      localStorage.setItem("gpl-road-trip-planning-range", String(state.planningRangeKm));
      renderVehicle();
      if (currentZone().dynamicTarget) renderStations({ fitMap: false });
    });
    $("#petrol-buffer-control").addEventListener("change", (event) => {
      state.allowPetrol = event.target.checked;
      state.selectedId = null;
      localStorage.setItem("gpl-road-trip-allow-petrol", String(state.allowPetrol));
      renderVehicle();
      if (currentZone().dynamicTarget) renderStations({ fitMap: false });
    });
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
    window.addEventListener("resize", () => scheduleMapLayout(false), { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(() => scheduleMapLayout(false), 120));
    window.addEventListener("pageshow", () => scheduleMapLayout(false));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleMapLayout(false);
    });
    updateConnectionBanner();

    const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (!installed) $("#install-button").hidden = false;
  }

  async function start() {
    try {
      [state.config, state.snapshot] = await Promise.all([loadJson("./data/routes.json"), loadSnapshot()]);
      state.planningRangeKm = normalizedPlanningRange(localStorage.getItem("gpl-road-trip-planning-range"));
      const savedPetrol = localStorage.getItem("gpl-road-trip-allow-petrol");
      state.allowPetrol = savedPetrol === null
        ? state.config.vehicle.allowPetrolDefault !== false
        : savedPetrol === "true";
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
