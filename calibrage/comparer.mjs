// Compare notre classement des coups à celui de chess.com, partie par partie, sans relancer le moteur.
// Entrées (calibrage/bilans-2026-11/) : parties.json, chesscom.json (relevé des bilans chess.com),
// brut-p<prof>.json (moteur-node.mjs). Usage : node calibrage/comparer.mjs [profondeur]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from '../chess.js';
import { summarizePosition, buildAnalysis } from '../core.js';

const DIR = fileURLToPath(new URL('./bilans-2026-11/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEPTH = +process.argv[2] || 12;
const BOOK = JSON.parse(readFileSync(ROOT + 'ouvertures.json', 'utf8'));
const games = JSON.parse(readFileSync(DIR + 'parties.json', 'utf8')).parties;
const CC = JSON.parse(readFileSync(DIR + 'chesscom.json', 'utf8')).bilans;
const RAW = JSON.parse(readFileSync(DIR + `brut-p${DEPTH}.json`, 'utf8'));

// Icônes de chess.com → nos catégories. « Compétence » est un « Meilleur » mis en avant par le coach ;
// « Forcé » (seul coup légal) n'existe pas chez nous : compté à part.
export const FROM_CC = { brilliant: 'brilliant', great_find: 'great', best: 'best', skills: 'best', excellent: 'excellent',
  good: 'good', book: 'book', inaccuracy: 'inaccuracy', mistake: 'mistake', incorrect: 'miss', blunder: 'blunder', forced: 'forced' };
const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];

export function ours(g, raw, build = buildAnalysis) {
  const c = new Chess(); c.loadPgn(g.pgn);
  const hist = c.history({ verbose: true });
  const fens = [hist[0].before, ...hist.map((m) => m.after)];
  const pos = fens.map((fen, i) => {
    const r = raw[i];
    const res = r && { best: r.b, lines: r.l.map(([type, v, pv]) => ({ type, v, pv: pv ? pv.split(' ') : [] })) };
    return summarizePosition(fen, res);
  });
  return { hist, a: build(hist, pos, DEPTH, BOOK) };
}

export function compare(build = buildAnalysis, { verbose = false } = {}) {
  const conf = {}; let ok = 0, n = 0, accErr = 0, accN = 0;
  const per = [];
  for (const g of games) {
    const cc = CC[g.id]; const raw = RAW[g.id]; if (!cc || !raw) continue;
    const { a } = ours(g, raw, build);
    const theirs = cc.cls.map((x) => FROM_CC[x] || '?');
    if (theirs.length !== a.ply.length) { console.log('longueurs différentes', g.id, theirs.length, a.ply.length); continue; }
    let gok = 0;
    a.ply.forEach((p, i) => {
      const t = theirs[i]; if (t === '?') return;
      (conf[t] = conf[t] || {})[p.c] = (conf[t][p.c] || 0) + 1;
      // Forcé : un seul coup légal, le nôtre dit Meilleur, c'est la même chose.
      const same = p.c === t || (t === 'forced' && p.c === 'best');
      if (same) { ok++; gok++; } n++;
    });
    const ccAcc = cc.acc && cc.acc.length === 2 ? cc.acc.map(Number) : g.cc;
    if (ccAcc) for (const s of [0, 1]) { const o = s ? a.acc.b : a.acc.w; if (o != null) { accErr += Math.abs(o - ccAcc[s]); accN++; } }
    per.push({ id: g.id, elo: Math.round((g.elo[0] + g.elo[1]) / 2), accord: +(gok / a.ply.length).toFixed(2), ours: [a.acc.w, a.acc.b], cc: ccAcc });
  }
  const res = { accord: +(ok / n).toFixed(4), coups: n, parties: per.length, ecartPrecision: +(accErr / accN).toFixed(2) };
  if (verbose) {
    console.log(`Profondeur ${DEPTH} : ${per.length} parties, ${n} coups, accord ${(100 * ok / n).toFixed(1)} %, écart de précision moyen ${res.ecartPrecision}`);
    console.log('\nLignes : chess.com ; colonnes : nous');
    const cols = ORDER.filter((c) => c !== 'forced');
    console.log('            ' + cols.map((c) => c.slice(0, 5).padStart(6)).join(''));
    for (const t of ORDER) { if (!conf[t]) continue; console.log(t.padEnd(12) + cols.map((c) => String(conf[t][c] || '').padStart(6)).join('')); }
    console.log('\nPar tranche d\'Elo :');
    for (const [lo, hi] of [[0, 600], [600, 1000], [1000, 1400], [1400, 1800], [1800, 2200], [2200, 4000]]) {
      const r = per.filter((x) => x.elo >= lo && x.elo < hi); if (!r.length) continue;
      console.log(`  ${lo}-${hi} : accord ${(100 * r.reduce((s, x) => s + x.accord, 0) / r.length).toFixed(1)} % (${r.length} parties)`);
    }
  }
  return { ...res, conf, per };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) compare(buildAnalysis, { verbose: true });
