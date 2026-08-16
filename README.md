# Vents Pornichet

PWA de suivi du vent à Pornichet pour le kite et le wing : relevé actuel, courbe des
dernières 24 h et période personnalisable.

Site statique, **sans backend** : tout est récupéré et calculé dans le navigateur.

**URL de déploiement** : https://cedrixs.github.io/vents-pornichet/
_(active dès que GitHub Pages est activé sur le dépôt — voir « Déploiement » plus bas.)_

---

## ⚠️ Précision des données — à lire avant d'y faire confiance

Le vent officiel de Pornichet (GlissEvolution) n'est pas exposé en JSON accessible
depuis un navigateur (pas de CORS). L'app utilise donc **windmorbihan**, une source
publique qui sert de repli à ce même site et dont l'API est ouverte en CORS.

| Point | Ce que ça implique |
|---|---|
| Source | Réseau windmorbihan, capteur LCJ du feu du port (`nid = 8`) |
| Correction | `valeur_affichée = round(valeur_source − 1)` sur la **moyenne** et la **rafale** |
| Direction | Affichée telle quelle, **sans** correction |
| Champ « min » | **Absent** — la source ne le fournit pas, l'app n'en invente pas |
| Historique | **≈ 4 à 5 jours** seulement, résolution native ~10 min |

La correction de −1 nœud est une **approximation assumée**. L'écart entre windmorbihan
et le relevé officiel GlissEvolution a été mesuré empiriquement et s'est révélé
*variable selon les conditions* : ce n'est pas un décalage constant fiable. Un modèle
plus complexe a été volontairement écarté au profit de cette règle simple et lisible.
L'interface affiche systématiquement une mention « estimation » pour cette raison.

**Ne pas utiliser ces valeurs comme donnée officielle.**

---

## Fonctionnalités

- **Vent actuel** — moyenne, rafale, direction (degrés + point cardinal, ex. `251° SO`),
  heure du relevé et fraîcheur (« il y a X min »). Rafraîchissement automatique toutes
  les 5 minutes tant que l'onglet est ouvert.
- **États dégradés explicites** — « Donnée indisponible » si la source est injoignable
  ou si le dernier relevé date de plus de 2 h (silence prolongé de la station). Le
  dernier relevé connu est réaffiché depuis le cache local au démarrage, avant même
  le réseau.
- **Courbe 24 h** par défaut, moyenne + rafale, avec la bande entre les deux séries
  (lecture immédiate de la « nervosité » du vent) et un bandeau de flèches de direction
  sous l'axe. Les trous de données sont rendus comme des coupures, pas comme des lignes
  droites traversant le vide.
- **Période personnalisable** — début, fin et pas d'agrégation (brut ~10 min / 30 min /
  1 h / 3 h, ou « Auto »). La sélection est **bornée à ce que la source fournit
  réellement** : remonter plus loin déclenche un avertissement et un recadrage sur le
  point le plus ancien disponible.
- **Survol / tableau** — réticule et infobulle au pointeur (flèches ← → au clavier),
  plus une vue tableau complète des valeurs affichées.
- **PWA installable** — manifeste, icônes, service worker : l'app se lance hors-ligne
  avec les dernières données mises en cache.

### Agrégation

Quand un pas supérieur à la résolution native est choisi, chaque point brut est
**d'abord corrigé**, puis les points d'un même intervalle sont regroupés :

- **moyenne** : moyenne simple des moyennes ;
- **rafale** : **maximum** des rafales de l'intervalle — délibérément pas leur moyenne,
  pour ne pas lisser les pics, qui sont l'information la plus utile pour un rider ;
- **direction** : moyenne vectorielle (circulaire), pas arithmétique.

---

## Endpoints utilisés

```
GET https://private2.windmorbihan.com/mesures/getlastalljson.json     # relevé live, toutes stations
GET https://private2.windmorbihan.com/mesures/history.json?nid=8      # historique (~6 Mo)
```

Deux pièges gérés côté client :

1. **`getlastalljson.json` renvoie tout le réseau** — on filtre sur `nid == 8`.
2. **`history.json` a été observé renvoyant toutes les stations mélangées malgré
   `?nid=8`.** Le parsing extrait donc systématiquement la clé `"8"` de chaque bucket
   horodaté, avec un repli si la source venait à filtrer correctement un jour.

### Volume et cache

`history.json` pèse ~6 Mo. Le résultat **filtré** (quelques centaines de points, ~20 Ko)
est mis en cache dans `localStorage` avec un TTL de **20 minutes** ; le téléchargement
complet n'est refait que si le cache est vide ou expiré, ou sur un clic explicite sur
le bouton de rafraîchissement. Si le réseau tombe, un cache expiré est réutilisé plutôt
que de ne rien afficher (le résumé le signale alors).

Les données de vent ne sont **jamais** mises en cache par le service worker : servir un
relevé périmé comme s'il était actuel serait pire que de ne rien servir.

---

## Structure

```
vents-pornichet/
├── index.html          # structure + template du bloc « vent actuel »
├── style.css           # thème sombre, mobile-first
├── app.js              # config, fetch, correction, agrégation, graphe SVG, UI
├── manifest.json       # PWA
├── service-worker.js   # cache de l'app shell (données exclues)
├── icons/              # 32 / 180 / 192 / 512 + maskable + SVG
└── README.md
```

Aucune dépendance, aucun build step. Le graphe est **généré en SVG directement en JS** :
pas de Chart.js ni de CDN, ce qui évite le rendu vide constaté dans certains aperçus
mobiles sandboxés et permet un fonctionnement hors-ligne complet.

### Ajouter un spot

Tout est déclaratif en haut de `app.js` — une entrée suffit, le sélecteur de spot
apparaît automatiquement dès qu'il y en a plus d'un :

```js
const SPOTS = {
  pornichet: { label: 'Pornichet', windmorbihanNid: 8 },
  // autre:   { label: 'Autre spot', windmorbihanNid: 12 },
};
```

Les autres réglages (correction, TTL du cache, seuils de fraîcheur, profondeur
d'historique) sont regroupés dans l'objet `CONFIG` juste en dessous.

---

## Développement local

Un simple serveur statique suffit (le service worker exige `http://` ou `https://`,
il ne s'enregistre pas en `file://`) :

```bash
npx http-server -p 8080 .
# puis http://localhost:8080
```

---

## Déploiement (GitHub Pages)

Le site se déploie tel quel depuis la racine du dépôt, sans configuration serveur ni
étape de build. Une fois la branche fusionnée dans `main` :

1. **Settings → Pages** ;
2. **Source** : `Deploy from a branch` ;
3. **Branch** : `main`, dossier `/ (root)` ;
4. **Save**.

Le site est alors publié sur https://cedrixs.github.io/vents-pornichet/ après une à
deux minutes. Tous les chemins de l'app sont relatifs (`./`), le sous-répertoire
`/vents-pornichet/` ne pose donc aucun problème.

Après une mise à jour, le service worker sert d'abord la version en cache puis
revalide en arrière-plan : un second rechargement peut être nécessaire pour voir le
nouveau contenu. Pour forcer la mise à jour immédiate de tous les clients, incrémenter
`CACHE` dans `service-worker.js` (`vents-pornichet-v1` → `v2`).

---

## Limites connues

- Données **estimées**, pas officielles (voir plus haut).
- Pas de valeur « min » : indisponible à la source.
- Historique limité à ~4-5 jours, borné par la source elle-même.
- Un seul capteur : si la station LCJ se tait, l'app n'a pas de repli et l'affiche
  clairement plutôt que de montrer un vieux relevé.
- Aucune prévision — l'app ne montre que du mesuré.
