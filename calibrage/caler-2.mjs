// Calage n°2 (2026-11-20) : 30 parties relevées le 2026-11-16 + 20 nouvelles. Vérifie si les réglages
// calés sur les 30 premières tiennent sur les 20 nouvelles (jamais vues), puis recale sur les 50.
// Usage : node calibrage/caler-2.mjs [profondeur]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { G, score, fit } from './caler-classement.mjs';

const NEW = new Set(Object.keys(JSON.parse(readFileSync(fileURLToPath(new URL('./releve-2026-11-20.ids.json', import.meta.url)), 'utf8'))));
const oldG = G.filter((g) => !NEW.has(g.id)); const newG = G.filter((g) => NEW.has(g.id));
const pct = (x) => (100 * x).toFixed(1) + ' %';
// Réglages actuels de core.js (2026-11-16).
const CUR = { k: 0.00368208, e: 0, t1: 4, t2: 6, t3: 7, t4: 20, forced: true, bookLoss: 10, bookExt: 0, brilCap: 95, gGap: 15, gCap: 95,
  gNoRecap: true, gPunish: 0, mLoss: 0, mGain: 2, mWp: 70, useL2: false };
console.log(`${G.length} parties (${oldG.length} anciennes, ${newG.length} nouvelles)`);
console.log('Actuel : tout', pct(score(CUR)), '| anciennes', pct(score(CUR, oldG)), '| nouvelles', pct(score(CUR, newG)));
for (const [nom, keys] of [['prudent (4 seuils)', ['t1', 't2', 't3', 't4']], ['seuils + Manqué + Très bon coup', ['t1', 't2', 't3', 't4', 'mGain', 'mWp', 'gGap', 'gCap']], ['complet', ['k', 'e', 't1', 't2', 't3', 't4', 'bookExt', 'gGap', 'gCap', 'gPunish', 'mLoss', 'mGain', 'mWp']]]) {
  const a = fit(CUR, keys, oldG);
  const b = fit(CUR, keys, G);
  const h1 = G.filter((_, i) => i % 2 === 0), h2 = G.filter((_, i) => i % 2 === 1);
  const c1 = fit(CUR, keys, h1), c2 = fit(CUR, keys, h2);
  console.log(`\n${nom}`);
  console.log(`  calé sur les 30 anciennes → nouvelles ${pct(score(a.o, newG))} (actuel ${pct(score(CUR, newG))})`, JSON.stringify(pick(a.o, keys)));
  console.log(`  validation croisée sur 50 : calé A → B ${pct(score(c1.o, h2))} (actuel ${pct(score(CUR, h2))}) ; calé B → A ${pct(score(c2.o, h1))} (actuel ${pct(score(CUR, h1))})`);
  console.log(`  calé sur les 50 → ${pct(b.s)}`, JSON.stringify(pick(b.o, keys)));
}
function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }
