#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_PATH = resolve(ROOT, "data/routes.json");
const OUTPUT_PATH = resolve(ROOT, "data/latest.json");
const TEMP_PATH = `${OUTPUT_PATH}.tmp`;

const SOURCES = {
  registry:
    "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv",
  prices: "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv",
};

const USER_AGENT =
  "GPL-Road-Trip/1.0 (+https://github.com/; daily public-data snapshot)";
const MAX_PER_WINDOW = 12;

async function fetchText(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/csv,text/plain;q=0.9,*/*;q=0.5",
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const body = await response.text();
      if (body.length < 100 || /<html[\s>]/i.test(body.slice(0, 500))) {
        throw new Error("la risposta non sembra un CSV");
      }
      return body.replace(/^\uFEFF/, "");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((done) => setTimeout(done, attempt * 2_000));
      }
    }
  }
  throw new Error(`Download fallito per ${url}: ${lastError?.message}`);
}

function splitCsvLine(line, delimiter) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  fields.push(value.trim());
  return fields;
}

function normalizeHeader(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function parseMimitCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) throw new Error("CSV MIMIT incompleto");

  const headerIndex = lines.findIndex((line) =>
    /id[ _-]*impianto/i.test(line),
  );
  if (headerIndex < 0) throw new Error("intestazione idImpianto non trovata");

  const headerLine = lines[headerIndex];
  const delimiter = headerLine.includes("|") ? "|" : ";";
  const headers = splitCsvLine(headerLine, delimiter).map(normalizeHeader);
  const rows = [];

  for (const line of lines.slice(headerIndex + 1)) {
    const values = splitCsvLine(line, delimiter);
    if (values.length < headers.length) continue;
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push(row);
  }

  return {
    rows,
    sourceNote: lines.slice(0, headerIndex).join(" ") || null,
  };
}

function field(row, ...aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function number(value) {
  const parsed = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value) {
  return /^(1|true|si|s)$/i.test(String(value).trim());
}

function italianDateToIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const italian = raw.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (italian) {
    const [, day, month, year, hour = "00", minute = "00", second = "00"] =
      italian;
    const utcGuess = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(utcGuess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const displayedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const date = new Date(utcGuess - (displayedAsUtc - utcGuess));
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

function haversineKm(pointA, pointB) {
  const earthRadiusKm = 6371.0088;
  const dLat = radians(pointB[0] - pointA[0]);
  const dLng = radians(pointB[1] - pointA[1]);
  const latA = radians(pointA[0]);
  const latB = radians(pointB[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function routeMetrics(point, route) {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestProgress = 0;
  let progress = 0;

  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    const meanLat = radians((start[0] + end[0] + point[0]) / 3);
    const kmPerLat = 111.32;
    const kmPerLng = 111.32 * Math.cos(meanLat);
    const segmentX = (end[1] - start[1]) * kmPerLng;
    const segmentY = (end[0] - start[0]) * kmPerLat;
    const pointX = (point[1] - start[1]) * kmPerLng;
    const pointY = (point[0] - start[0]) * kmPerLat;
    const segmentSquared = segmentX ** 2 + segmentY ** 2;
    const fraction = segmentSquared
      ? Math.max(
          0,
          Math.min(1, (pointX * segmentX + pointY * segmentY) / segmentSquared),
        )
      : 0;
    const distance = Math.hypot(
      pointX - fraction * segmentX,
      pointY - fraction * segmentY,
    );
    const segmentLength = haversineKm(start, end);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestProgress = progress + segmentLength * fraction;
    }
    progress += segmentLength;
  }

  return {
    distanceKm: Number(bestDistance.toFixed(1)),
    progressKm: Number(bestProgress.toFixed(1)),
  };
}

function ageDays(isoDate, now) {
  if (!isoDate) return 60;
  const date = new Date(isoDate);
  if (Number.isNaN(date.valueOf())) return 60;
  return Math.max(0, (now.valueOf() - date.valueOf()) / 86_400_000);
}

function normalize(value, minimum, maximum) {
  if (maximum <= minimum) return 0;
  return (value - minimum) / (maximum - minimum);
}

function rankWindow(candidates, now) {
  if (!candidates.length) return [];
  const prices = candidates.map((candidate) => candidate.station.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  return candidates
    .map((candidate) => {
      const { match, station } = candidate;
      const score =
        normalize(station.price, minPrice, maxPrice) * 0.48 +
        Math.min(match.routeDistanceKm / 12, 1) * 0.32 +
        Math.min(match.zoneDistanceKm / match.zoneRadiusKm, 1) * 0.12 +
        Math.min(ageDays(station.communicatedAt, now) / 30, 1) * 0.08;
      return {
        ...candidate,
        match: { ...match, score: Number(score.toFixed(4)) },
      };
    })
    .sort(
      (a, b) =>
        a.match.score - b.match.score ||
        a.station.price - b.station.price ||
        a.match.zoneDistanceKm - b.match.zoneDistanceKm,
    )
    .slice(0, MAX_PER_WINDOW);
}

function buildStations(registryRows, priceRows, routes, now) {
  const registry = new Map();
  for (const row of registryRows) {
    const id = String(field(row, "idImpianto")).trim();
    const lat = number(field(row, "Latitudine"));
    const lng = number(field(row, "Longitudine"));
    if (!id || lat === null || lng === null) continue;
    if (lat < 35 || lat > 48 || lng < 5 || lng > 20) continue;
    registry.set(id, {
      id,
      name:
        field(row, "Nome Impianto", "NomeImpianto") ||
        field(row, "Bandiera") ||
        `Impianto ${id}`,
      brand: field(row, "Bandiera") || "Indipendente",
      manager: field(row, "Gestore") || null,
      roadType: field(row, "Tipo Impianto", "TipoImpianto") || null,
      address: field(row, "Indirizzo") || "Indirizzo non disponibile",
      municipality: field(row, "Comune") || "",
      province: field(row, "Provincia") || "",
      lat,
      lng,
    });
  }

  const pricesByStation = new Map();
  for (const row of priceRows) {
    const fuel = field(row, "descCarburante", "Carburante").trim();
    if (!/^g\.?p\.?l\.?$/i.test(fuel)) continue;
    const id = String(field(row, "idImpianto")).trim();
    const price = number(field(row, "prezzo"));
    if (!registry.has(id) || price === null || price < 0.3 || price > 2.5) continue;
    const entry = {
      price: Number(price.toFixed(3)),
      isSelf: boolean(field(row, "isSelf", "Self")),
      communicatedAt: italianDateToIso(
        field(row, "dtComu", "dataComunicazione", "Data"),
      ),
    };
    const previous = pricesByStation.get(id);
    if (!previous || entry.price < previous.price) pricesByStation.set(id, entry);
  }

  const allStations = [...pricesByStation.entries()].map(([id, price]) => ({
    ...registry.get(id),
    fuel: "GPL",
    ...price,
  }));
  const selected = new Map();

  for (const leg of routes.legs) {
    for (const window of leg.fuelWindows) {
      const candidates = [];
      for (const station of allStations) {
        const point = [station.lat, station.lng];
        const zoneDistanceKm = haversineKm(point, window.center);
        if (zoneDistanceKm > window.radiusKm) continue;
        const route = routeMetrics(point, leg.route);
        route.progressKm = Number((route.progressKm * (Number(leg.distanceScale) || 1)).toFixed(1));
        if (route.distanceKm > 12) continue;
        if (Number.isFinite(window.minProgressKm) && route.progressKm < window.minProgressKm) continue;
        if (Number.isFinite(window.maxProgressKm) && route.progressKm > window.maxProgressKm) continue;
        candidates.push({
          station,
          match: {
            legId: leg.id,
            zoneId: window.id,
            zoneLabel: window.label,
            zonePriority: window.priority,
            zoneRadiusKm: window.radiusKm,
            zoneDistanceKm: Number(zoneDistanceKm.toFixed(1)),
            routeDistanceKm: route.distanceKm,
            progressKm: route.progressKm,
          },
        });
      }

      for (const candidate of rankWindow(candidates, now)) {
        const existing = selected.get(candidate.station.id);
        if (existing) {
          existing.matches.push(candidate.match);
        } else {
          selected.set(candidate.station.id, {
            ...candidate.station,
            matches: [candidate.match],
          });
        }
      }
    }
  }

  return [...selected.values()]
    .map((station) => ({
      ...station,
      matches: station.matches.sort(
        (a, b) =>
          a.legId.localeCompare(b.legId) ||
          a.zonePriority - b.zonePriority ||
          a.score - b.score,
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "it", { numeric: true }));
}

async function main() {
  const now = new Date();
  const routes = JSON.parse(await readFile(ROUTES_PATH, "utf8"));
  const [registryText, pricesText] = await Promise.all([
    fetchText(SOURCES.registry),
    fetchText(SOURCES.prices),
  ]);
  const registryCsv = parseMimitCsv(registryText);
  const pricesCsv = parseMimitCsv(pricesText);
  const stations = buildStations(
    registryCsv.rows,
    pricesCsv.rows,
    routes,
    now,
  );

  if (!stations.length) {
    throw new Error("nessun distributore GPL trovato nelle finestre di viaggio");
  }

  const countsByZone = {};
  for (const station of stations) {
    for (const match of station.matches) {
      const key = `${match.legId}/${match.zoneId}`;
      countsByZone[key] = (countsByZone[key] || 0) + 1;
    }
  }
  const missingWindows = routes.legs.flatMap((leg) =>
    leg.fuelWindows
      .map((window) => `${leg.id}/${window.id}`)
      .filter((key) => !countsByZone[key]),
  );
  if (missingWindows.length) {
    throw new Error(
      `snapshot incompleto: nessun candidato GPL per ${missingWindows.join(", ")}`,
    );
  }

  const output = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    fuel: "GPL",
    unit: "EUR/L",
    source: {
      name: "Ministero delle Imprese e del Made in Italy — Osservaprezzi carburanti",
      license: "IODL 2.0",
      datasetPage:
        "https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti",
      registryUrl: SOURCES.registry,
      pricesUrl: SOURCES.prices,
      registryNote: registryCsv.sourceNote,
      pricesNote: pricesCsv.sourceNote,
    },
    selection: {
      strategy: "balanced-price-distance-freshness",
      maximumPerWindow: MAX_PER_WINDOW,
      countsByZone,
    },
    stations,
  };

  await writeFile(TEMP_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await rename(TEMP_PATH, OUTPUT_PATH);
  console.log(
    `Aggiornato ${OUTPUT_PATH}: ${stations.length} distributori GPL (${Object.entries(
      countsByZone,
    )
      .map(([zone, count]) => `${zone}=${count}`)
      .join(", ")}).`,
  );
}

main().catch(async (error) => {
  try {
    await unlink(TEMP_PATH);
  } catch {
    // Il file temporaneo può non esistere: l'ultimo snapshot valido resta intatto.
  }
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
