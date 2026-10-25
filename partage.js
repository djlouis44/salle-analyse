// Partage du groupe dans Firestore. Tout est rangé sous groupes/<code>/ :
//   joueurs/<id> : { name, chesscom, lichess }
//   bilans/<id>  : la partie (PGN et infos) + son bilan, pour que tout le groupe le voie
// Les parties elles-mêmes ne sont pas stockées : chaque appareil les récupère sur chess.com
// et Lichess. Ça garde le nombre de lectures loin du quota gratuit.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1 : rien à confondre
const CODE_RE = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

export const enabled = !!firebaseConfig.projectId;

// 10 caractères tirés au hasard : environ 10^15 codes possibles, impossible à deviner.
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  const s = [...r].map((x) => ALPHA[x % ALPHA.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}

export function cleanCode(s) {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = c.slice(0, 5) + '-' + c.slice(5, 10);
  return CODE_RE.test(code) ? code : null;
}

// Ouvre le groupe et écoute les changements en direct. Renvoie les fonctions d'écriture.
export async function openGroup(code, { onPlayers, onBilans, onError }) {
  const [{ initializeApp }, fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js')]);
  const app = initializeApp(firebaseConfig);
  // Cache local : l'appli s'affiche tout de suite au rechargement, même hors ligne.
  const db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  const base = 'groupes/' + code + '/';
  fs.onSnapshot(fs.collection(db, base + 'joueurs'), (s) => onPlayers(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError);
  fs.onSnapshot(fs.collection(db, base + 'bilans'), (s) => onBilans(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError);
  return {
    putPlayer: ({ id, ...p }) => fs.setDoc(fs.doc(db, base + 'joueurs', id), p),
    delPlayer: (id) => fs.deleteDoc(fs.doc(db, base + 'joueurs', id)),
    putBilan: ({ id, ...b }) => fs.setDoc(fs.doc(db, base + 'bilans', id), b),
  };
}
