const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const swiftPath = path.join(__dirname, '../macOS/OnlyChatApp.swift');
const content = fs.readFileSync(swiftPath, 'utf8');

const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('ThreeFEmbeddedBrowserSession') || line.includes('ThreeFURLRouter') || line.includes('import ')) {
    console.log(`${idx + 1}: ${line}`);
  }
});

function searchDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) searchDir(full);
    else if (entry.isFile()) {
      const data = fs.readFileSync(full, 'utf8');
      if (data.includes('ThreeFEmbeddedBrowserSession')) {
        console.log('Found ThreeFEmbeddedBrowserSession in:', full);
      }
    }
  }
}
searchDir(path.join(__dirname, '..'));
