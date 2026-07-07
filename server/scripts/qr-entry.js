// Bundled at build time into a self-contained IIFE embedded directly in the
// setup pages' HTML (see build-qr-bundle.mjs). No CDN, no third-party script
// tag on the page that generates and holds a fresh sync token.
const QRCode = require("qrcode");

window.LodestoneQR = {
	toCanvas: QRCode.toCanvas,
};
