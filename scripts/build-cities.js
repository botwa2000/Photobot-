// Regenerates src/main/data/cities.tsv from the GeoNames-based `all-the-cities`
// package (cities with population >= 1000). Data: GeoNames, CC BY 4.0.
// Run: node scripts/build-cities.js
const fs = require('fs');
const path = require('path');
const cities = require('all-the-cities');
const lines = cities
  .filter((c) => c.loc && c.loc.coordinates && c.name)
  .map((c) => [
    c.name.replace(/[\t\n]/g, ' '),
    c.country,
    c.loc.coordinates[1].toFixed(3),
    c.loc.coordinates[0].toFixed(3),
    c.population || 0,
  ].join('\t'));
const out = path.join(__dirname, '..', 'src', 'main', 'data', 'cities.tsv');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} cities to ${out}`);
