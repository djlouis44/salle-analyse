// Ajoute à bilans-2026-11/chesscom.json un relevé exporté de la page chess.com en lettres
// ({ id: ["prec. Blancs/prec. Noirs", "lettres", coups lus après attente maxi] }).
// Usage : node calibrage/importer-chesscom.mjs <fichier>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const F = fileURLToPath(new URL('./bilans-2026-11/chesscom.json', import.meta.url));
const L = { '!': 'brilliant', g: 'great_find', '*': 'best', s: 'skills', e: 'excellent', o: 'good', k: 'book', i: 'inaccuracy', m: 'mistake', x: 'incorrect', b: 'blunder', f: 'forced' };
const cur = existsSync(F) ? JSON.parse(readFileSync(F, 'utf8')) : { bilans: {} };
const add = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [id, [acc, s]] of Object.entries(add)) cur.bilans[id] = { acc: acc.split('/').map(Number), cls: [...s].map((c) => L[c] || '?') };
writeFileSync(F, JSON.stringify(cur));
console.log(Object.keys(cur.bilans).length, 'bilans');
