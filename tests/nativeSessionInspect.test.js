const fs = require('fs');
const path = require('path');

const swiftPath = path.join(__dirname, '../macOS/OnlyChatApp.swift');
if (!fs.existsSync(swiftPath)) {
  console.log('OnlyChatApp.swift does not exist at', swiftPath);
  process.exit(1);
}

const content = fs.readFileSync(swiftPath, 'utf8');
const lines = content.split('\n');
console.log('Total lines in OnlyChatApp.swift:', lines.length);

const matches = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/ThreeF|EmbeddedBrowser|Session|WebView|tab/i.test(line)) {
    matches.push({ lineNum: i + 1, text: line });
  }
}

console.log('Found matching lines:', matches.length);
matches.slice(0, 40).forEach(m => console.log(`${m.lineNum}: ${m.text}`));
