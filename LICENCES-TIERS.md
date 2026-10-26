# Licences des composants tiers

Le projet est distribué sous GPL v3 (voir `LICENSE`). Il embarque trois composants tiers.

## Base d'ouvertures Lichess (chess-openings)

- Fichier : `ouvertures.json`, construit le 2026-10-26 à partir des fichiers `a.tsv` à `e.tsv` de
  https://github.com/lichess-org/chess-openings (positions de chaque ligne, réduites à une empreinte, et noms).
- Licence : domaine public, CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).

## Stockfish 18 (stockfish.js 18.0.8)

- Fichiers : `moteur/stockfish-18-lite-single.js` et `moteur/stockfish-18-lite-single.wasm`, non modifiés.
- Licence : GPL v3, texte dans `moteur/COPYING.txt`.
- Code source : https://github.com/nmrugg/stockfish.js (portage WebAssembly) et https://github.com/official-stockfish/Stockfish (moteur).
- Paquet npm d'origine : `stockfish@18.0.8`.

## chess.js 1.4.0

- Fichier : `chess.js` (build ESM du paquet npm `chess.js@1.4.0`, seul un en-tête de licence a été ajouté).
- Licence : BSD-2-Clause.

```
Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```
