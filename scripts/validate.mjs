#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routes = JSON.parse(await readFile(resolve(ROOT, "data/routes.json"), "utf8"));
const snapshot = JSON.parse(await readFile(resolve(ROOT, "data/latest.json"), "utf8"));
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

assert(snapshot.schemaVersion === 1, "schemaVersion deve essere 1");
assert(snapshot.fuel === "GPL", "il dataset deve contenere esclusivamente GPL");
assert(snapshot.unit === "EUR/L", "l'unità deve essere EUR/L");
assert(!Number.isNaN(new Date(snapshot.generatedAt).valueOf()), "generatedAt non valido");
const officialMimit = /^https:\/\/www\.mimit\.gov\.it\//.test(
  snapshot.source?.pricesUrl || "",
);
const curatedSeed = snapshot.mode === "curated-seed";
assert(
  officialMimit || curatedSeed,
  "la fonte deve essere il CSV ufficiale MIMIT o lo snapshot iniziale curato",
);
assert(Array.isArray(snapshot.stations), "stations deve essere un array");
assert(snapshot.stations?.length > 0, "lo snapshot non può essere vuoto");

const legZones = new Map(
  routes.legs.map((leg) => [leg.id, new Set(leg.fuelWindows.map((zone) => zone.id))]),
);
const expectedWindows = routes.legs.flatMap((leg) =>
  leg.fuelWindows.map((zone) => `${leg.id}/${zone.id}`),
);
const seenWindows = new Set();
const ids = new Set();

for (const [index, station] of (snapshot.stations || []).entries()) {
  const label = `stations[${index}]`;
  assert(station.fuel === "GPL", `${label}: carburante diverso da GPL`);
  assert(station.id !== undefined && station.id !== "", `${label}: id mancante`);
  assert(!ids.has(String(station.id)), `${label}: id duplicato ${station.id}`);
  ids.add(String(station.id));
  assert(typeof station.name === "string" && station.name, `${label}: nome mancante`);
  assert(Number.isFinite(station.lat) && station.lat >= 35 && station.lat <= 48, `${label}: latitudine non valida`);
  assert(Number.isFinite(station.lng) && station.lng >= 5 && station.lng <= 20, `${label}: longitudine non valida`);
  assert(Number.isFinite(station.price) && station.price >= 0.3 && station.price <= 2.5, `${label}: prezzo non plausibile`);
  assert(!Number.isNaN(new Date(station.communicatedAt).valueOf()), `${label}: data prezzo non valida`);
  if (curatedSeed) {
    assert(/^https:\/\//.test(station.detailsUrl || ""), `${label}: fonte di verifica mancante`);
  }
  assert(Array.isArray(station.matches) && station.matches.length > 0, `${label}: matches mancante`);

  for (const match of station.matches || []) {
    assert(legZones.has(match.legId), `${label}: legId sconosciuto ${match.legId}`);
    assert(
      legZones.get(match.legId)?.has(match.zoneId),
      `${label}: fuel window sconosciuta ${match.legId}/${match.zoneId}`,
    );
    assert(Number.isFinite(match.zoneDistanceKm), `${label}: zoneDistanceKm non valida`);
    assert(Number.isFinite(match.routeDistanceKm), `${label}: routeDistanceKm non valida`);
    assert(match.routeDistanceKm <= 12, `${label}: impianto oltre 12 km dalla traccia`);
    assert(Number.isFinite(match.progressKm), `${label}: progressKm non valido`);
    assert(Number.isFinite(match.score), `${label}: score non valido`);
    seenWindows.add(`${match.legId}/${match.zoneId}`);
  }
}

for (const window of expectedWindows) {
  assert(seenWindows.has(window), `nessun candidato GPL per ${window}`);
}

if (errors.length) {
  console.error(`Validazione fallita (${errors.length} errori):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    `Snapshot valido: ${snapshot.stations.length} distributori GPL, ${seenWindows.size} finestre coperte.`,
  );
}
