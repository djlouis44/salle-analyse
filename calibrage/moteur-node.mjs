// Calibrage hors navigateur : fait tourner notre Stockfish (même fichier que le site, mêmes réglages :
// MultiPV 2, Hash 32) sur les parties de calibrage/bilans-2026-11/parties.json, et garde pour chaque
// position les deux lignes du moteur. Le calage des règles se fait ensuite sans relancer le moteur.
// Usage : node calibrage/moteur-node.mjs <profondeur> [moteurs en parallèle]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from '../chess.js';
import { parseInfo } from '../core.js';

const DIR = fileURLToPath(new URL('./bilans-2026-11/', import.meta.url));
const ENGINE = fileURLToPath(new URL('../moteur/stockfish-18-lite-single.js', import.meta.url));
const DEPTH = +process.argv[2] || 12;
const NW = +process.argv[3] || 4;
const OUT = DIR + `brut-p${DEPTH}.json`; // relancer = compléter : supprimer le fichier pour tout refaire

class Eng {
  constructor() {
    this.p = spawn(process.execPath, [ENGINE], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = ''; this.cb = null;
    this.p.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (this.cb) this.cb(l); }
    });
    this.ready = this.until('uci', (l) => l === 'uciok')
      .then(() => { this.send('setoption name MultiPV value 2'); this.send('setoption name Hash value 32'); return this.until('isready', (l) => l === 'readyok'); });
  }
  send(s) { this.p.stdin.write(s + '\n'); }
  until(cmd, done) { return new Promise((res) => { const seen = []; this.cb = (l) => { seen.push(l); if (done(l)) { this.cb = null; res(seen); } }; this.send(cmd); }); }
  async evaluate(fen) {
    // Pas de « ucinewgame » : comme sur le site, la table de hachage sert d'une position à la suivante.
    this.send('position fen ' + fen);
    const lines = {}; let best = null;
    await this.until('go depth ' + DEPTH, (l) => {
      const x = parseInfo(l); if (x) lines[x.mpv] = x.line;
      if (l.startsWith('bestmove')) { best = l.split(' ')[1]; return true; }
      return false;
    });
    return { best, lines: [lines[1], lines[2]].filter(Boolean) };
  }
  quit() { this.send('quit'); }
}

const games = JSON.parse(readFileSync(DIR + 'parties.json', 'utf8')).parties;
const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const todo = games.filter((g) => !out[g.id]);
console.log(`Profondeur ${DEPTH}, ${todo.length} parties à analyser, ${NW} moteurs.`);
const engs = Array.from({ length: NW }, () => new Eng());
await Promise.all(engs.map((e) => e.ready));
let next = 0; const t0 = Date.now();
await Promise.all(engs.map(async (eng) => {
  while (next < todo.length) {
    const g = todo[next++];
    const c = new Chess(); c.loadPgn(g.pgn);
    const hist = c.history({ verbose: true });
    const fens = [hist[0].before, ...hist.map((m) => m.after)];
    const raw = [];
    for (const fen of fens) raw.push(new Chess(fen).isGameOver() ? null : await eng.evaluate(fen));
    // Lignes allégées : type, valeur, la suite du moteur (10 demi-coups) pour la 1re ligne, le
    // premier coup seulement pour la 2e.
    out[g.id] = raw.map((r) => r && { b: r.best, l: r.lines.map((x, j) => [x.type, x.v, j ? x.pv[0] : x.pv.slice(0, 10).join(' ')]) });
    writeFileSync(OUT, JSON.stringify(out));
    console.log(`${Object.keys(out).length}/${games.length}  ${g.id}  ${fens.length} positions  ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}));
engs.forEach((e) => e.quit());
console.log('Terminé.');
