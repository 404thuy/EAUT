const fs = require('fs');
const path = require('path');

const faviconPath = path.join(__dirname, '../public/favicon.png');

// Optimized 64x64 PNG icon (1KB instead of 557KB)
const base64Png = 
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5wgREQk6o/ZlBgAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmhoAAAAQUlEQVR42u3PMQEAAAgAIEu1/4VrYw4gYCUAAAAAAAAAAAAAAADwYz4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBsS7wABqN4o3QAAAABJRU5ErkJggg==";

const buffer = Buffer.from(base64Png, 'base64');
fs.writeFileSync(faviconPath, buffer);
console.log('Favicon replaced. New size:', fs.statSync(faviconPath).size, 'bytes');
