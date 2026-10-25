// Logique du bilan : conversion des évaluations, classement des coups, précision.
import { Chess } from './chess.js';

export const CLS = {
  brilliant:  { label: 'Brillant',    sym: '!!', desc: 'un sacrifice qui tient la route' },
  great:      { label: 'Grand coup',  sym: '!',  desc: 'le seul coup qui garde l’avantage' },
  best:       { label: 'Meilleur',    sym: '★', desc: 'le coup du moteur' },
  excellent:  { label: 'Excellent',   sym: '✓', desc: 'presque aussi fort que le meilleur coup' },
  good:       { label: 'Bon',         sym: '✓', desc: 'un coup correct' },
  inaccuracy: { label: 'Imprécision', sym: '?!', desc: 'une petite perte' },
  mistake:    { label: 'Erreur',      sym: '?',  desc: 'une vraie perte d’avantage' },
  blunder:    { label: 'Gaffe',       sym: '??', desc: 'un coup qui change la partie' },
};
export const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 50 };

// Probabilité de gain (0-100) pour le camp au trait, à partir d'une ligne moteur.
export function wpLine(line) {
  if (!line) return 50;
  if (line.type === 'mate') return line.v > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * line.v)) - 1);
}

// Transforme le résultat brut du moteur en position résumée.
// res = { lines: [{type, v, pv}], best } ou null pour une position terminale.
export function summarizePosition(fen, res) {
  const c = new Chess(fen);
  const stmWhite = c.turn() === 'w';
  if (c.isCheckmate()) return { stm: 0, w: stmWhite ? 0 : 100, e: stmWhite ? '0-1' : '1-0', b: null, bs: null, gap: null };
  if (c.isStalemate() || c.isInsufficientMaterial() || c.isDrawByFiftyMoves()) {
    return { stm: 50, w: 50, e: '½', b: null, bs: null, gap: null };
  }
  const l1 = res && res.lines[0];
  const l2 = res && res.lines[1];
  const stm = wpLine(l1);
  const gap = l2 ? stm - wpLine(l2) : null;
  let e = '?';
  if (l1) {
    if (l1.type === 'mate') {
      const m = l1.v * (stmWhite ? 1 : -1);
      e = (m > 0 ? 'M' : '-M') + Math.abs(m);
    } else {
      const cp = (l1.v * (stmWhite ? 1 : -1)) / 100;
      e = (cp > 0 ? '+' : '') + cp.toFixed(1);
    }
  }
  const b = res && res.best && res.best !== '(none)' ? res.best : (l1 && l1.pv && l1.pv[0]) || null;
  let bs = null;
  if (b) {
    try { bs = c.move({ from: b.slice(0, 2), to: b.slice(2, 4), promotion: b[4] }).san; } catch (_) { bs = null; }
  }
  return {
    stm: +stm.toFixed(2),
    w: +(stmWhite ? stm : 100 - stm).toFixed(1),
    e, b, bs,
    gap: gap == null ? null : +gap.toFixed(1),
  };
}

export function isSacrifice(m) {
  if (m.piece === 'p' || m.piece === 'k') return false;
  const pv = VAL[m.promotion || m.piece];
  const capt = m.captured ? VAL[m.captured] : 0;
  if (pv - capt < 2) return false;
  const c = new Chess(m.after);
  if (c.isCheckmate()) return false;
  const opp = m.color === 'w' ? 'b' : 'w';
  const att = c.attackers(m.to, opp);
  if (!att.length) return false;
  const minAtt = Math.min(...att.map((s) => VAL[c.get(s).type]));
  const def = c.attackers(m.to, m.color);
  return minAtt < pv || def.length === 0;
}

function isRecapture(hist, i) {
  return i > 0 && !!hist[i - 1].captured && hist[i - 1].to === hist[i].to;
}

export function moveAccuracy(loss) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
}

export function gameAccuracy(arr) {
  if (!arr.length) return null;
  const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
  const harm = arr.length / arr.reduce((s, a) => s + 1 / Math.max(a, 10), 0);
  return Math.round(((mean + harm) / 2) * 10) / 10;
}

export function classify(loss, isBest) {
  if (isBest) return 'best';
  if (loss < 2) return 'excellent';
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  if (loss < 20) return 'mistake';
  return 'blunder';
}

// hist = historique verbeux chess.js ; pos = positions résumées (hist.length + 1)
export function buildAnalysis(hist, pos, depth) {
  const ply = [];
  const acc = { w: [], b: [] };
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    const A = pos[i];
    const B = pos[i + 1];
    const wpB = A.stm;
    const wpA = 100 - B.stm;
    const exact = A.b === m.lan;
    // Si le coup joué est celui du moteur, l'écart vient seulement de l'horizon de calcul.
    const loss = exact ? 0 : Math.max(0, wpB - wpA);
    let cls = classify(loss, exact || loss < 0.3);
    if ((cls === 'best' || cls === 'excellent') && wpB < 95 && wpA >= 50 && isSacrifice(m)) cls = 'brilliant';
    else if (cls === 'best' && exact && A.gap != null && A.gap >= 15 && wpB < 95 && !isRecapture(hist, i)) cls = 'great';
    const a = moveAccuracy(loss);
    ply.push({ c: cls, l: +loss.toFixed(1), a: Math.round(a) });
    acc[m.color].push(a);
  }
  return {
    v: 1,
    depth,
    at: new Date().toISOString(),
    pos: pos.map((x) => ({ w: x.w, e: x.e, b: x.b || null, bs: x.bs || null })),
    ply,
    acc: { w: gameAccuracy(acc.w), b: gameAccuracy(acc.b) },
  };
}

// Elo estimé à partir de la précision. Tables calées le 2026-10-25 sur 2 908 parties rapides
// chess.com (précision chess.com et Elo des deux joueurs, 300 joueurs de 100 à 2 500 Elo).
// Méthode : précision typique de chaque niveau, puis lecture inverse (« tu as joué comme un
// joueur de X »), ce qui évite de ramener tout le monde vers la moyenne.
// Erreurs mesurées par validation croisée :
//   - sur une seule partie : ~530 en moyenne, pas mieux qu'un chiffre fixe, d'où « indicatif » ;
//   - sur la moyenne de 8 à 20 parties d'un joueur : ~220 (contre ~570 pour un chiffre fixe).
// Nos précisions (formule de type Lichess) sont plus généreuses que celles de chess.com : on les
// convertit d'abord en « précision chess.com », par une droite mesurée sur des parties chess.com
// analysées par nous (voir CC_MAP), puis on lit les tables.
const ELO_GAME = [[54.2, 150], [60.1, 255], [62.4, 350], [65.5, 460], [67.4, 590], [68.7, 735], [69.8, 845],
  [72.1, 1005], [75.1, 1290], [80.5, 1710], [83.2, 2230], [91.3, 2520]];
const ELO_AVG = [[56.9, 225], [62.7, 385], [66.8, 555], [69.0, 790], [71.0, 995], [73.3, 1225], [80.6, 1950], [83.6, 2320]];
export const ELO_MIN_MOVES = 10;  // en dessous, une partie ne dit rien
export const ELO_MIN_GAMES = 8;   // bilans nécessaires pour l'Elo d'un joueur
export const ELO_LAST_GAMES = 20; // on garde les plus récents
export const ELO_GAME_ERR = 500;
export const ELO_AVG_ERR = 220;

function readElo(table, acc) {
  if (acc == null) return null;
  if (acc <= table[0][0]) return { v: table[0][1], edge: '<' };
  const last = table[table.length - 1];
  if (acc >= last[0]) return { v: last[1], edge: '>' };
  for (let i = 0; i < table.length - 1; i++) {
    const [a0, e0] = table[i]; const [a1, e1] = table[i + 1];
    if (acc <= a1) return { v: Math.round((e0 + ((acc - a0) / (a1 - a0)) * (e1 - e0)) / 50) * 50, edge: '' };
  }
  return null;
}
// Précision chess.com ≈ -38,36 + 1,305 × notre précision. Mesuré le 2026-10-25 sur 30 parties
// rapides chess.com de 180 à 2 330 Elo (60 précisions), bilans en profondeur 12 : nos
// précisions dépassent les leurs de 12,6 points en moyenne, erreur de la droite ~5 points.
// Vérifié en profondeur 15 sur 10 de ces parties : précisions quasi identiques (+0,9) et même
// droite valable (erreur 4,6). Une seule droite suffit donc pour 12 à 17.
const CC_A = -38.36, CC_B = 1.305;
export const toChessComAcc = (acc) => (acc == null ? null : Math.max(0, Math.min(100, CC_A + CC_B * acc)));
export const estimateGameElo = (acc) => readElo(ELO_GAME, toChessComAcc(acc));
// accs : précisions des bilans du joueur, de la plus récente à la plus ancienne.
export function estimatePlayerElo(accs) {
  const last = accs.slice(0, ELO_LAST_GAMES);
  if (last.length < ELO_MIN_GAMES) return null;
  const e = readElo(ELO_AVG, last.reduce((s, a) => s + toChessComAcc(a), 0) / last.length);
  return e && { ...e, n: last.length };
}
export const eloText = (e) => (e.edge === '<' ? 'moins de ' : e.edge === '>' ? 'plus de ' : '≈ ') + e.v;

// Analyse une ligne "info" UCI. Renvoie null si la ligne ne sert pas.
export function parseInfo(l) {
  if (!l.startsWith('info ') || l.indexOf(' pv ') < 0 || l.indexOf(' score ') < 0) return null;
  if (l.indexOf('lowerbound') >= 0 || l.indexOf('upperbound') >= 0) return null;
  const sm = l.match(/ score (cp|mate) (-?\d+)/);
  if (!sm) return null;
  const mpv = +((l.match(/ multipv (\d+)/) || [])[1] || 1);
  const d = +((l.match(/ depth (\d+)/) || [])[1] || 0);
  return { mpv, line: { d, type: sm[1], v: +sm[2], pv: l.split(' pv ')[1].trim().split(' ') } };
}
