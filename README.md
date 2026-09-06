# TRAQUE — jeu multijoueur killer/white

## Installation
```bash
npm install
node server.js
```
Puis ouvre `http://localhost:3000` dans ton navigateur. Pour jouer à plusieurs
depuis d'autres appareils sur le même réseau, remplace `localhost` par l'adresse
IP locale de la machine qui héberge (ex. `http://192.168.1.23:3000`), ou déploie
le projet sur un hébergeur (Render, Railway, Glitch...) pour y jouer depuis
n'importe où.

## Ajouter tes modèles 3D
Dépose tes fichiers `.glb` dans `public/models/` avec exactement ces noms :
- `public/models/white.glb`   → le joueur "white"
- `public/models/red.glb`     → le killer
- `public/models/phantom.glb` → le fantôme (joueur éliminé)
- `public/models/map.glb`     → la map

Si un fichier est absent, le jeu utilise automatiquement une forme de secours
(capsule colorée / sol + obstacles) pour que tout reste jouable en attendant.

## Règles
- 3 à 8 joueurs. L'hôte lance la partie une fois le nombre atteint.
- Un killer est tiré au sort ; les autres sont "white". Personne ne sait qui
  est le killer à part lui-même.
- Phase de cachette de 15s au début : le killer ne peut pas bouger.
- Le killer va 30% plus vite que les white.
- Killer touche un white → il devient fantôme (transparent, traverse tout,
  ne peut plus qu'observer).
- White gagne si tout le monde survit 5 minutes après la phase de cachette.
- Killer gagne s'il élimine tous les white avant.

## Contrôles
Z / S : avancer / reculer — Q / D : tourner (caméra 3e personne derrière le joueur).

## Structure
```
server.js           serveur Node (Express + Socket.io) : lobby, rôles, sync, victoire
public/index.html    écrans (menu, lobby, jeu, fin)
public/style.css     thème visuel
public/client.js     scène Three.js, contrôles, chargement des modèles, réseau
public/models/       dépose ici tes .glb (white / red / phantom / map)
```
