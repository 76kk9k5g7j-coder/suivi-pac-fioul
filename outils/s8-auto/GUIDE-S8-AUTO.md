# Relance automatique du relevé Midea (S8 / Termux)

Le script Python fait toujours le relevé. Ce qui est ajouté autour, c’est un filet de sécurité :

- au **allumage** du téléphone, Termux:Boot lance le relevé ;
- s’il **plante**, il repart tout seul (10 s, puis de plus en plus longtemps, jusqu’à 5 min) ;
- toutes les **15 min**, Android vérifie qu’il tourne encore et le relance s’il manque (même si Termux a été tué, tant que tu n’as pas fait « Forcer l’arrêt ») ;
- `termux-wake-lock` empêche le téléphone d’endormir Termux.

La file d’attente (`pac_file_attente.json`) est gardée : si Termux redémarre, les relevés non envoyés (jusqu’à 24 h) sont renvoyés.

## Pourquoi termux-job-scheduler, et pas cron

On utilise **termux-job-scheduler** (appli Termux:API), pas cronie. Cron ne vit que tant que Termux est déjà en vie : s’il est tué, cron meurt avec lui et ne peut rien relancer. Le planificateur d’Android, lui, peut réveiller Termux toutes les 15 min (minimum officiel depuis Android 7). C’est le choix le plus solide en 2025-2026, à condition de ne **jamais faire « Forcer l’arrêt »** sur Termux (ça annule les tâches).

## 1. Les trois applis, même source

Termux, Termux:Boot et Termux:API doivent venir **toutes les trois de F-Droid**, pas du Play Store. Si tu mélanges les sources, Boot et l’API ne parlent pas à Termux.

1. Installe F-Droid si besoin, puis les trois applis depuis F-Droid.
2. Si Termux est déjà installé depuis le Play Store, il faudra le réinstaller depuis F-Droid (et refaire `pkg install python` + `pip install midea-local`). Tes fichiers du dossier home peuvent être perdus : copie d’abord `midea_releve.py` ailleurs.
3. Ouvre **Termux:Boot** une fois (icône), puis referme. Sans ça, rien ne part au allumage.
4. Ouvre **Termux:API** une fois aussi.

## 2. Réglages batterie (Samsung, important)

Sans ça, Samsung finira par tuer Termux, surtout écran éteint. À faire pour **Termux**, **Termux:Boot** et **Termux:API** :

1. **Paramètres › Applications › (chaque appli) › Batterie** : choisis **Non restreint**, ou **Ne pas optimiser** (le mot dépend de la version Android).
2. **Paramètres › Entretien de l’appareil** (parfois « Maintenance de l’appareil ») **› Batterie** : **Applis jamais en veille** (parfois « Applications non surveillées ») : ajoute les trois.
3. Coupe la **Batterie adaptative** pour ces applis, ou désactive-la si tu ne trouves pas l’exception.
4. Laisse le **chargeur branché**. Ce téléphone fait un travail en continu : sur batterie seule, ça ne tiendra pas longtemps.

**Redémarrage auto** (Entretien / Maintenance de l’appareil, parfois « Redémarrage automatique ») : tu peux le laisser, **à condition d’avoir testé** qu’un redémarrage relance bien le relevé (étape 4). Si le test échoue, désactive-le, surtout avant un voyage.

## 3. Installer (une commande)

Dans Termux, dézippe ce dossier (par exemple vers `~/pac-install`), puis :

```bash
bash ~/pac-install/installe-auto.sh
```

Tout est copié dans `~/pac/`. Si `~/pac/midea_releve.py` existe déjà, il n’est **pas** écrasé : tes identifiants restent. S’il est copié pour la première fois, ouvre-le et remplis `EMAIL`, `MDP`, `URL` et `TOKEN` en haut, **les mêmes que maintenant**. Ne les envoie à personne.

Si tu lançais déjà le script dans un autre dossier, copie aussi vers `~/pac/` ton `midea_releve.py` rempli et, s’il existe, `pac_file_attente.json` (la file des relevés pas encore envoyés).

Si le script dit que `termux-job-scheduler` manque :

```bash
pkg install termux-api
bash ~/pac/installe-auto.sh
```

## 4. Vérifier que ça marche

```bash
bash ~/pac/etat-midea.sh
```

Tu dois voir le superviseur et le Python « en cours », et dans le journal une ligne par minute (`soufflerie … tr/min`). Autre façon :

```bash
tail -30 ~/pac/midea.log
ps -ef | grep -E 'lance-midea|midea_releve' | grep -v grep
```

**Test du boot (une fois, maintenant, pas la veille du départ) :** redémarre le téléphone, attends une ou deux minutes, rouvre Termux, relance `bash ~/pac/etat-midea.sh`. Si le relevé tourne tout seul, c’est bon. Si ce n’est pas le cas : Termux:Boot n’a pas été ouvert, ou les réglages batterie bloquent encore.

## 5. Après une mise à jour de Termux

1. Rouvre Termux (ne le « force » jamais à s’arrêter).
2. `bash ~/pac/etat-midea.sh`
3. S’il est arrêté : `bash ~/pac/installe-auto.sh` (tu peux le relancer, c’est sans danger).
4. Mets aussi à jour Termux:Boot et Termux:API **depuis F-Droid**, pas ailleurs.

## 6. Arrêter, ou enlever l’automatique

Arrêt temporaire (repartira au prochain allumage, ou dans les 15 min) :

```bash
bash ~/pac/arrete-midea.sh
```

Pour l’arrêter pour de bon (le script Python, le journal et la file d’attente restent) :

```bash
bash ~/pac/desinstalle-auto.sh
```

Ensuite, tu peux encore lancer à la main : `python ~/pac/midea_releve.py`.
