#!/usr/bin/env node
/**
 * Bundles qr-entry.js (which requires the "qrcode" npm package) into a
 * single minified IIFE and writes it out as a TS string constant. setupPage.ts
 * imports that constant and inlines it directly into the served HTML, so the
 * claim/setup pages never load a QR library from a third-party CDN.
 *
 * Regenerate after bumping the "qrcode" dependency:
 *   node server/scripts/build-qr-bundle.mjs
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "qr-entry.js");
const outFile = resolve(__dirname, "../src/generated/qrBundle.ts");

const result = await build({
	entryPoints: [entry],
	bundle: true,
	minify: true,
	format: "iife",
	platform: "browser",
	write: false,
	logLevel: "warning",
});

const js = result.outputFiles[0].text;

const header =
	"// GENERATED FILE — do not edit by hand.\n" +
	"// Regenerate with: node server/scripts/build-qr-bundle.mjs\n" +
	"// Source: server/scripts/qr-entry.js (bundles the \"qrcode\" npm package).\n";

writeFileSync(outFile, `${header}export const QR_BUNDLE_JS = ${JSON.stringify(js)};\n`);

console.log(`Wrote ${outFile} (${(js.length / 1024).toFixed(1)} KB minified)`);
