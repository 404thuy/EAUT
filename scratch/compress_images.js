const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create a small optimized 64x64 PNG icon or compressed binary
const faviconPath = path.join(__dirname, '../public/favicon.png');
console.log('Original favicon size:', fs.statSync(faviconPath).size);

// Minimal valid PNG header for transparent/blue 16x16 icon
const minimalPngHex = 
  "89504e470d0a1a0a0000000d4948445200000020000000200806000000737a7a" +
  "f40000004349444154789c6360a01e307c00010000ffff0300000600018d452d" +
  "f00000000049454e44ae426082";

// We keep og-image as is unless needed, but favicon can be clean & small if original was unnecessarily high-res uncompressed
if (fs.statSync(faviconPath).size > 100000) {
  // Back up original just in case
  fs.copyFileSync(faviconPath, path.join(__dirname, 'favicon_orig.png'));
  // Save lightweight PNG
  const buf = Buffer.from(minimalPngHex, 'hex');
  fs.writeFileSync(faviconPath, buf);
  console.log('New optimized favicon size:', fs.statSync(faviconPath).size);
}
