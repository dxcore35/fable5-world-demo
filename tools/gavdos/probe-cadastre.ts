#!/usr/bin/env bun
// Probe Hellenic Cadastre INSPIRE WFS for parcel polygons covering Gavdos bbox
const endpoints = [
  "https://gis.ktimatologio.gr/arcgis/services/INSPIRE/INSPIRE_CP/MapServer/WFSServer?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities",
  "https://gis.ktimatologio.gr/inspire/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities",
  "https://www.ktimatologio.gr/arcgis/services/Cadastre/WFSServer?SERVICE=WFS&REQUEST=GetCapabilities",
];

async function main(): Promise<void> {
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "gavdos-probe/1.0" },
      });
      console.log(url.slice(0, 70), "->", r.status, r.headers.get("content-type") ?? "");
      if (r.ok) {
        const t = await r.text();
        console.log("  body[:400]:", t.slice(0, 400));
      }
    } catch (e) {
      console.log(url.slice(0, 70), "-> ERR:", (e as Error).message);
    }
  }
}

main();
