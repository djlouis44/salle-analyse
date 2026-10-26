// Logique du bilan : conversion des évaluations, classement des coups, précision.
import { Chess } from './chess.js';

// Mêmes catégories que le bilan chess.com (Classification V2, support.chess.com, article 8572705).
// Seuils de perte d'espérance de points : Très bien < 2, Bon < 5, Imprécision < 10, Erreur < 20, Gaffe au-delà.
// Libellés relevés sur un vrai bilan chess.com en français (2026-10-26) : le « ! » (Great) s'y
// appelle « Excellent » et le pouce (Excellent) « Très bien ».
export const CLS = {
  brilliant:  { label: 'Brillant',      sym: '!!' },
  great:      { label: 'Excellent',     sym: '!' },
  best:       { label: 'Meilleur',      sym: '★' },
  excellent:  { label: 'Très bien',     sym: '✓' },
  good:       { label: 'Bon',           sym: '✓' },
  book:       { label: 'Théorique',     sym: '≡' },
  inaccuracy: { label: 'Imprécision',   sym: '?!' },
  mistake:    { label: 'Erreur',        sym: '?' },
  miss:       { label: 'Manqué',        sym: '✗' },
  blunder:    { label: 'Gaffe',         sym: '??' },
};
export const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

// Positions théoriques (base Lichess chess-openings, CC0), clé = FNV-1a des 3 premiers champs du FEN.
// Fichier construit une fois : ouvertures.json { names, pos: { hash: index du nom } }.
let BOOK = null;
export async function loadBook() {
  if (BOOK) return BOOK;
  try { const r = await fetch(new URL('./ouvertures.json?v=1', import.meta.url)); BOOK = r.ok ? await r.json() : { names: [], pos: {} }; } catch (_) { BOOK = { names: [], pos: {} }; }
  return BOOK;
}
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
export function openingName(book, fen) {
  if (!book) return null;
  const i = book.pos[fnv(fen.split(' ').slice(0, 3).join(' '))];
  return i == null ? null : book.names[i];
}

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

// Précision calée sur celle de chess.com le 2026-10-26 (calibrage/calibrer.html + caler.js) :
// 90 parties rapides de 100 à 2 400 Elo déjà passées au bilan chez eux, profondeur 12.
// Même forme que la formule de Lichess, deux réglages changés : une courbe de chances de gain
// plus plate (ACC_K) et une pénalité plus forte par point perdu (ACC_C).
// Écart moyen avec chess.com : 3,8 points (4,0 sur des parties hors calage), contre 10,9 avec
// la formule de Lichess et 5,7 avec l'ancienne droite de conversion.
// La courbe de classement des coups (wpLine) ne change pas tant qu'on ne l'a pas comparée à de
// vrais bilans chess.com coup par coup.
const ACC_K = 0.00258, ACC_C = 0.1015;
export function moveAccuracy(loss) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-ACC_C * loss) - 3.1669));
}
// Chances de gain des Blancs (0-100) lues dans l'évaluation enregistrée (« +1.2 », « -M3 », « 1-0 »…).
function wpWhite(e) {
  if (!e || e === '?') return null;
  if (e === '1-0' || e.startsWith('M')) return 100;
  if (e === '0-1' || e.startsWith('-M')) return 0;
  if (e === '½') return 50;
  return 50 + 50 * (2 / (1 + Math.exp(-ACC_K * parseFloat(e) * 100)) - 1);
}
// Précision des deux camps à partir d'un bilan enregistré : marche aussi pour les anciens bilans,
// sans relancer le moteur (l'arrondi des évaluations au dixième de pion ne change rien de mesurable).
export function accuracyOf(a, first = 'w') {
  const acc = { w: [], b: [] };
  a.ply.forEach((p, i) => {
    const mover = (i % 2 === 0) === (first === 'w') ? 'w' : 'b';
    let loss = 0;
    if (p.l > 0) {
      const x = wpWhite(a.pos[i].e); const y = wpWhite(a.pos[i + 1].e);
      loss = x == null || y == null ? p.l : Math.max(0, mover === 'w' ? x - y : y - x);
    }
    acc[mover].push(moveAccuracy(loss));
  });
  return { w: gameAccuracy(acc.w), b: gameAccuracy(acc.b) };
}
export const withAccuracy = (a, first) => (a && a.ply && a.pos ? { ...a, acc: accuracyOf(a, first) } : a);

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

const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];

// Mat en n pour le camp `color`, lu dans l'évaluation enregistrée (point de vue des Blancs), sinon null.
function mateIn(color, e) {
  const m = /^(-?)M(\d+)$/.exec(e || '');
  return m && (m[1] === '') === (color === 'w') ? +m[2] : null;
}
// Calé sur un bilan chess.com du 2026-10-26 (partie 185975480636) : 3 « Manqué » sur 3 retrouvés.
function missedMate(color, before, after) {
  const nb = mateIn(color, before);
  if (nb == null || nb > 5 || ['1-0', '0-1', '½'].includes(after)) return false;
  const na = mateIn(color, after);
  return na == null || (nb <= 2 && na > nb);
}

// hist = historique verbeux chess.js ; pos = positions résumées (hist.length + 1) ;
// book = base d'ouvertures (loadBook), facultative.
export function buildAnalysis(hist, pos, depth, book) {
  const ply = [];
  let inBook = !!book;
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    const A = pos[i];
    const B = pos[i + 1];
    const wpB = A.stm;
    const wpA = 100 - B.stm;
    const exact = A.b === m.lan;
    // Si le coup joué est celui du moteur, l'écart vient seulement de l'horizon de calcul.
    const loss = exact ? 0 : Math.max(0, wpB - wpA);
    // « Meilleur » seulement pour le coup du moteur, comme chess.com ; un autre coup sans perte est « Très bien ».
    let cls = classify(loss, exact);
    // Théorique : tant que la partie reste dans la base d'ouvertures (un piège qui perd gros en sort).
    if (inBook && loss < 10 && openingName(book, m.after)) cls = 'book';
    else {
      inBook = false;
      if ((cls === 'best' || cls === 'excellent') && wpB < 95 && wpA >= 50 && isSacrifice(m)) cls = 'brilliant';
      else if (cls === 'best' && exact && A.gap != null && A.gap >= 15 && wpB < 95 && !isRecapture(hist, i)) cls = 'great';
      // Manqué : l'adversaire vient de se tromper et offrait une position gagnante, on la laisse passer.
      else if ((cls === 'mistake' || cls === 'blunder') && i > 0 && BAD.includes(ply[i - 1].c)
        && wpB >= 70 && 100 - pos[i - 1].stm < 70 && wpA < 70) cls = 'miss';
      // Manqué aussi : un mat forcé laissé passer (mat en 5 ou moins perdu, ou mat en 1-2 rallongé).
      else if (cls !== 'brilliant' && missedMate(m.color, A.e, B.e)) cls = 'miss';
    }
    ply.push({ c: cls, l: +loss.toFixed(1) });
  }
  const out = {
    v: 2,
    depth,
    at: new Date().toISOString(),
    pos: pos.map((x) => ({ w: x.w, e: x.e, b: x.b || null, bs: x.bs || null })),
    ply,
  };
  out.acc = accuracyOf(out, hist.length ? hist[0].color : 'w');
  return out;
}

// Phrase d'explication d'un coup, calculée à l'affichage (marche aussi pour les anciens bilans).
const PIECE = { p: 'le pion', n: 'le cavalier', b: 'le fou', r: 'la tour', q: 'la dame', k: 'le roi' };
const DU = { p: 'du pion', n: 'du cavalier', b: 'du fou', r: 'de la tour', q: 'de la dame', k: 'du roi' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Ce que l'adversaire peut faire après le coup : mat, prise, ou sa meilleure réponse.
function replyText(m, B) {
  if (!B) return '';
  const e = B.e || '';
  if ((e.startsWith('M') && m.color === 'b') || (e.startsWith('-M') && m.color === 'w')) return `Ça permet un mat en ${e.replace('-', '').slice(1)}.`;
  if (!B.b) return '';
  let r = null;
  try { r = new Chess(m.after).move({ from: B.b.slice(0, 2), to: B.b.slice(2, 4), promotion: B.b[4] }); } catch (_) { return ''; }
  // Une reprise après un échange égal n'est pas une pièce perdue.
  const trade = r.to === m.to && m.captured && VAL[m.captured] >= VAL[r.captured];
  if (r.captured && !trade) return `${cap(PIECE[r.captured])} en ${r.to} tombe après ${r.san}.`;
  return `La bonne réponse adverse : ${r.san}.`;
}
export function explainMove(hist, a, i, book) {
  const m = hist[i]; const cls = a.ply[i].c; const A = a.pos[i]; const B = a.pos[i + 1];
  const best = A && A.bs && A.bs !== m.san ? A.bs : null;
  if (m.san.endsWith('#')) return 'Échec et mat.';
  switch (cls) {
    case 'book': { const n = openingName(book, m.after); return n ? `Coup connu de la théorie (${n}).` : 'Coup connu de la théorie des ouvertures.'; }
    case 'brilliant': return `Sacrifice ${DU[m.promotion || m.piece]} qui tient la route : le moteur le valide.`;
    case 'great': return 'Le seul bon coup de la position : les autres laissaient filer l’avantage.';
    case 'best': return 'C’est le coup que le moteur aurait joué.';
    case 'excellent': return `Presque aussi fort que le meilleur coup${best ? ` (${best})` : ''}.`;
    case 'good': return best ? `Correct, mais ${best} était plus précis.` : 'Un coup correct.';
    case 'miss': {
      const n = mateIn(m.color, A && A.e);
      if (n) return `Occasion manquée : il y avait un mat en ${n}${best ? `, à commencer par ${best}` : ''}.`;
      return `Occasion manquée : après l’erreur adverse, ${best || 'un autre coup'} donnait une position gagnante.`;
    }
    default: {
      const head = { inaccuracy: 'Il y avait plus précis.', mistake: 'Ce coup coûte cher.', blunder: 'Grosse faute.' }[cls] || '';
      return [head, replyText(m, B), best ? `Il fallait jouer ${best}.` : ''].filter(Boolean).join(' ');
    }
  }
}

// Elo estimé à partir de la précision. Tables calées le 2026-10-25 sur 2 908 parties rapides
// chess.com (précision chess.com et Elo des deux joueurs, 300 joueurs de 100 à 2 500 Elo).
// Méthode : précision typique de chaque niveau, puis lecture inverse (« tu as joué comme un
// joueur de X »), ce qui évite de ramener tout le monde vers la moyenne.
// Erreurs mesurées par validation croisée :
//   - sur une seule partie : ~530 en moyenne, pas mieux qu'un chiffre fixe, d'où « indicatif » ;
//   - sur la moyenne de 8 à 20 parties d'un joueur : ~220 (contre ~570 pour un chiffre fixe).
// Depuis le 2026-10-26, notre précision est calée sur celle de chess.com (moveAccuracy) : on lit
// les tables directement. L'ancienne droite de conversion (−38,36 + 1,305 × précision, erreur ~5
// à 5,7 points) n'a plus lieu d'être.
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
export const estimateGameElo = (acc) => readElo(ELO_GAME, acc);
// accs : précisions des bilans du joueur, de la plus récente à la plus ancienne.
export function estimatePlayerElo(accs) {
  const last = accs.slice(0, ELO_LAST_GAMES);
  if (last.length < ELO_MIN_GAMES) return null;
  const e = readElo(ELO_AVG, last.reduce((s, a) => s + a, 0) / last.length);
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
