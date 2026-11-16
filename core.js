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
  forced:     { label: 'Forcé',         sym: '□' },
  inaccuracy: { label: 'Imprécision',   sym: '?!' },
  mistake:    { label: 'Erreur',        sym: '?' },
  miss:       { label: 'Manqué',        sym: '✗' },
  blunder:    { label: 'Gaffe',         sym: '??' },
};
export const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder'];

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
    // Suite optimale (bouton « Afficher ») : les 10 premiers demi-coups de la ligne du moteur.
    pv: l1 && l1.pv && l1.pv.length ? l1.pv.slice(0, PV_LEN).join(' ') : null,
  };
}
export const PV_LEN = 10;

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

// Seuils de perte de chances de gain (en points de %). Calés le 2026-11-16 sur de vrais bilans
// chess.com relevés coup par coup (calibrage/caler-classement.mjs) : chess.com est plus large que
// sa propre documentation (2 / 5 / 10) sur les petits écarts et plus sévère sur l'Erreur, d'où 4 / 6 / 7.
// Sur 30 parties de 100 à 2 500 Elo : accord 57,1 → 60,7 % en profondeur 15, 53,8 → 58,9 % en 12.
export const SEUILS = { excellent: 4, good: 6, inaccuracy: 7, mistake: 20 };
export function classify(loss, isBest) {
  if (isBest) return 'best';
  if (loss < SEUILS.excellent) return 'excellent';
  if (loss < SEUILS.good) return 'good';
  if (loss < SEUILS.inaccuracy) return 'inaccuracy';
  if (loss < SEUILS.mistake) return 'mistake';
  return 'blunder';
}

const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];

// Matériel que le camp au trait gagne en suivant la ligne du moteur (6 demi-coups au plus), compté
// après chaque réponse adverse. Sert à « Manqué » : il y avait quelque chose à prendre.
function pvGain(fen, pv) {
  if (!fen || !pv) return 0;
  const c = new Chess(fen); const me = c.turn(); let net = 0, best = 0;
  for (const u of pv.split(' ').slice(0, 6)) {
    let m = null; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (_) { m = null; }
    if (!m) break;
    if (m.captured) net += (m.color === me ? 1 : -1) * (m.captured === 'k' ? 0 : VAL[m.captured]);
    if (m.color !== me) best = Math.max(best, net);
  }
  return best;
}

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
    // Forcé : un seul coup légal (chess.com l'affiche à part).
    if (new Chess(m.before).moves().length === 1) cls = 'forced';
    // Théorique : tant que la partie reste dans la base d'ouvertures (un piège qui perd gros en sort).
    else if (inBook && loss < 10 && openingName(book, m.after)) cls = 'book';
    else {
      inBook = false;
      if ((cls === 'best' || cls === 'excellent') && wpB < 95 && wpA >= 50 && isSacrifice(m)) cls = 'brilliant';
      else if (cls === 'best' && exact && A.gap != null && A.gap >= 15 && wpB < 95 && !isRecapture(hist, i)) cls = 'great';
      // Manqué (calé le 2026-11-16) : un coup faible alors que la ligne du moteur gagnait du matériel,
      // ou que l'adversaire venait de se tromper et laissait une position gagnante.
      else if (BAD.includes(cls) && (pvGain(m.before, A.pv) >= 2 || (i > 0 && BAD.includes(ply[i - 1].c) && wpB >= 70))) cls = 'miss';
      // Manqué aussi : un mat forcé laissé passer (mat en 5 ou moins perdu, ou mat en 1-2 rallongé).
      else if (cls !== 'brilliant' && missedMate(m.color, A.e, B.e)) cls = 'miss';
    }
    ply.push({ c: cls, l: +loss.toFixed(1) });
  }
  const out = {
    v: 2,
    depth,
    at: new Date().toISOString(),
    pos: pos.map((x) => ({ w: x.w, e: x.e, b: x.b || null, bs: x.bs || null, p: x.pv || null })),
    ply,
  };
  out.acc = accuracyOf(out, hist.length ? hist[0].color : 'w');
  return out;
}

// Phrase d'explication d'un coup, calculée à l'affichage (marche aussi pour les anciens bilans).
const PIECE = { p: 'le pion', n: 'le cavalier', b: 'le fou', r: 'la tour', q: 'la dame', k: 'le roi' };
const DU = { p: 'du pion', n: 'du cavalier', b: 'du fou', r: 'de la tour', q: 'de la dame', k: 'du roi' };
const NOM = { p: 'pion', n: 'cavalier', b: 'fou', r: 'tour', q: 'dame', k: 'roi' };
const LES = { p: 'les pions', n: 'les cavaliers', b: 'les fous', r: 'les tours', q: 'les dames' };
const FEM = { r: true, q: true };

// La pièce en `sq` peut-elle être gagnée par le camp `by` ? Oui si personne ne la défend, ou si
// une pièce moins chère l'attaque. Le roi n'est jamais « en prise ».
function enPrise(c, sq, by) {
  const p = c.get(sq); if (!p || p.type === 'k' || p.color === by) return false;
  const att = c.attackers(sq, by); if (!att.length) return false;
  if (!c.attackers(sq, p.color).length) return true;
  return Math.min(...att.map((s) => VAL[c.get(s).type])) < VAL[p.type];
}

// Ce que fait un coup, en quelques mots au présent (« prend le fou laissé sans défense »), ou null.
// Repris des motifs que nomme le coach de chess.com (relevé du 2026-11-16) : fourchette, pièce
// gratuite, reprise, échange, roque, sortie d'échec, pièce mise à l'abri, pion qui chasse une
// pièce, développement. fen = position avant le coup ; prev = coup précédent (chess.js verbeux).
export function motif(fen, uci, prev, ply) {
  if (!fen || !uci) return null;
  const c = new Chess(fen); const me = c.turn(); const opp = me === 'w' ? 'b' : 'w';
  const wasCheck = c.inCheck();
  const fromAttacked = enPrise(c, uci.slice(0, 2), opp);
  const target = c.get(uci.slice(2, 4));
  const targetFree = target && target.color === opp && target.type !== 'k' && !c.attackers(uci.slice(2, 4), opp).length;
  let m; try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch (_) { return null; }
  if (!m) return null;
  if (c.isCheckmate()) return 'donne mat';
  // Fourchette : la pièce jouée attaque deux cibles qui valent la peine (le roi en échec, une pièce
  // plus chère qu'elle, ou une pièce sans défenseur), sans être elle-même simplement perdue.
  if (m.piece !== 'k') {
    const t = [];
    for (const row of c.board()) for (const x of row) {
      if (!x || x.color !== opp || !c.attackers(x.square, me).includes(m.to)) continue;
      if (x.type === 'k' || VAL[x.type] > VAL[m.piece] || (x.type !== 'p' && !c.attackers(x.square, opp).length)) t.push(x);
    }
    if (t.length >= 2 && (t.some((x) => x.type === 'k') || !enPrise(c, m.to, opp))) {
      t.sort((a, b) => VAL[b.type] - VAL[a.type]);
      const [a, b] = t;
      return `fait une fourchette sur ${a.type === b.type ? LES[a.type] : PIECE[a.type] + ' et ' + PIECE[b.type]}`;
    }
  }
  if (m.captured) {
    const pc = m.captured;
    if (prev && prev.captured && prev.to === m.to) return `reprend ${PIECE[pc]}`;
    if (targetFree) return `prend ${PIECE[pc]} laissé${FEM[pc] ? 'e' : ''} sans défense`;
    if (VAL[pc] > VAL[m.piece] + 1) return `gagne du matériel en prenant ${PIECE[pc]}`;
    if (VAL[pc] === VAL[m.piece] || (VAL[pc] === 3 && VAL[m.piece] === 3)) return pc === m.piece ? `échange ${LES[pc]}` : `échange ${PIECE[m.piece]} contre ${PIECE[pc]}`;
    return `prend ${PIECE[pc]}`;
  }
  if (m.flags.includes('k') || m.flags.includes('q')) return 'roque et met le roi à l’abri';
  // Gain de temps : la pièce jouée attaque la dame adverse sans être elle-même perdue.
  if (m.piece !== 'q' && !wasCheck && !enPrise(c, m.to, opp)
    && c.board().flat().some((x) => x && x.color === opp && x.type === 'q' && c.attackers(x.square, me).includes(m.to))) return 'gagne du temps en attaquant la dame';
  if (wasCheck) return m.piece === 'k' ? 'sort le roi de l’échec' : 'pare l’échec';
  if (m.promotion) return `amène le pion à ${PIECE[m.promotion].replace(/^l[ea] /, '')}`;
  if (fromAttacked && m.piece !== 'p') return `met ${PIECE[m.piece]} à l’abri`;
  if (m.piece === 'p') {
    const chased = c.board().flat().find((x) => x && x.color === opp && x.type !== 'p' && x.type !== 'k' && c.attackers(x.square, me).includes(m.to));
    if (chased && !enPrise(c, m.to, opp)) return `chasse ${PIECE[chased.type]} avec un pion`;
  }
  if ((m.piece === 'n' || m.piece === 'b') && m.from[1] === (me === 'w' ? '1' : '8') && (ply == null || ply < 30)) return `développe ${PIECE[m.piece]}`;
  if (c.inCheck()) return 'fait échec au roi';
  return null;
}
const motifOf = (hist, i, fen, uci) => motif(fen, uci, i > 0 ? hist[i - 1] : null, i);

// Matériel gagné par le camp au trait en suivant la ligne du moteur (`pv`, coups UCI séparés par
// des espaces) : 6 demi-coups, prolongés tant que les prises s'enchaînent (pour finir les échanges).
// Renvoie { san: 'Qh5+ g6 Qxe5+ …', net, top } ou null. top = plus grosse pièce prise à l'adversaire.
const UNE = { p: 'un pion', n: 'un cavalier', b: 'un fou', r: 'une tour', q: 'la dame' };
function lineGain(fen, pv) {
  if (!fen || !pv) return null;
  const c = new Chess(fen); const me = c.turn(); const sans = []; let net = 0; let top = null; let lastCap = false; let cut = 0;
  for (const u of pv.split(' ').slice(0, 8)) {
    if (sans.length >= 6 && !lastCap) break;
    let m; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (_) { break; }
    if (!m) break;
    sans.push(m.san); lastCap = !!m.captured;
    if (m.captured) {
      if (m.color === me) cut = sans.length;
      if (m.color === me) { net += VAL[m.captured]; if (!top || VAL[m.captured] > VAL[top]) top = m.captured; } else net -= VAL[m.captured];
    }
    if (m.promotion) { if (m.color === me) cut = sans.length; net += (m.color === me ? 1 : -1) * (VAL[m.promotion] - 1); }
  }
  // La ligne affichée s'arrête à la dernière prise du camp qui gagne : la suite n'apprend rien.
  return cut ? { san: sans.slice(0, cut).join(' '), net, top } : null;
}
// « une tour », « la dame »… ce que la ligne gagne vraiment, au bilan des échanges (2 points au
// moins), sinon ''. On lit le gain net, pas la plus grosse prise : dame contre tour n'est pas « la dame ».
function gainText(g) {
  if (!g || g.net < 2 || !g.top) return '';
  if (g.net >= 8) return g.top === 'q' ? 'la dame' : 'beaucoup de matériel';
  if (g.net >= 5) return g.top === 'r' ? 'une tour' : 'l’équivalent d’une tour';
  if (g.net >= 3) return g.top === 'n' || g.top === 'b' ? UNE[g.top] : 'une pièce';
  return 'deux pions';
}

// Ce que l'adversaire peut faire après le coup : mat, fourchette, ou la ligne du moteur qui gagne du
// matériel. Rien si sa meilleure réponse n'explique pas la faute (on garde alors « Il fallait jouer »).
function replyText(hist, i, B) {
  const m = hist[i];
  if (!B) return '';
  const e = B.e || '';
  if ((e.startsWith('M') && m.color === 'b') || (e.startsWith('-M') && m.color === 'w')) return `Ça permet un mat en ${e.replace('-', '').slice(1)}.`;
  if (!B.b) return '';
  let r = null;
  try { r = new Chess(m.after).move({ from: B.b.slice(0, 2), to: B.b.slice(2, 4), promotion: B.b[4] }); } catch (_) { return ''; }
  if (!r) return '';
  const d = motif(m.after, B.b, m, i + 1);
  if (d && d.startsWith('fait une fourchette')) return `L’adversaire répond ${r.san}, qui ${d}.`;
  const lg = lineGain(m.after, B.p); const g = gainText(lg);
  if (g) return `Après ${lg.san}, l’adversaire gagne ${g}.`;
  if (d && /^(prend|gagne)/.test(d)) return `L’adversaire répond ${r.san}, qui ${d}.`;
  return '';
}
export function explainMove(hist, a, i, book) {
  const m = hist[i]; const cls = a.ply[i].c; const A = a.pos[i]; const B = a.pos[i + 1];
  const best = A && A.bs && A.bs !== m.san ? A.bs : null;
  if (m.san.endsWith('#')) return 'Échec et mat.';
  const d = motifOf(hist, i, m.before, m.lan);
  let bd = best ? motifOf(hist, i, m.before, A.b) : null;
  if (bd && bd === d) bd = null; // « il sort le roi de l'échec, mais Rh7 sortait aussi le roi… » n'apprend rien
  switch (cls) {
    case 'book': { const n = openingName(book, m.after); return n ? `Coup connu de la théorie (${n}).` : 'Coup connu de la théorie des ouvertures.'; }
    case 'forced': return 'C’était le seul coup légal.';
    case 'brilliant': return `Sacrifice ${DU[m.promotion || m.piece]} qui tient la route : le moteur le valide.`;
    case 'great': return `Le seul bon coup de la position${d ? ` : il ${d}` : ', les autres laissaient filer l’avantage'}.`;
    case 'best': return d ? `Le coup du moteur : il ${d}.` : 'C’est le coup que le moteur aurait joué.';
    case 'excellent': return d ? `Ce coup ${d}, presque aussi fort que ${best || 'le meilleur coup'}.` : `Presque aussi fort que le meilleur coup${best ? ` (${best})` : ''}.`;
    case 'good': {
      const alt = best ? `${best} était plus précis${bd ? ` : il ${bd}` : ''}` : '';
      if (d) return `Ce coup ${d}${alt ? `, mais ${alt}` : ''}.`;
      return alt ? `Correct, mais ${alt}.` : 'Un coup correct.';
    }
    case 'miss': {
      const n = mateIn(m.color, A && A.e);
      if (n) return `Occasion manquée : il y avait un mat en ${n}${best ? `, à commencer par ${best}` : ''}.`;
      const lg = lineGain(m.before, A && A.p); const g = gainText(lg);
      if (best && g) return `Occasion manquée : ${lg.san} gagnait ${g}.`;
      if (best && bd) return `Occasion manquée : ${best} ${bd} et donnait une position gagnante.`;
      return `Occasion manquée : après l’erreur adverse, ${best || 'un autre coup'} donnait une position gagnante.`;
    }
    default: {
      const head = { inaccuracy: 'Il y avait plus précis.', mistake: 'Ce coup coûte cher.', blunder: 'Grosse faute.' }[cls] || '';
      // Une imprécision ne perd rien de concret : on donne seulement le meilleur coup.
      const why = cls === 'inaccuracy' ? '' : replyText(hist, i, B);
      return [head, why, best ? `Il fallait jouer ${best}${bd ? `, qui ${bd}` : ''}.` : ''].filter(Boolean).join(' ');
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
