# Serveur trains-api

Ce dossier est le serveur de l'app (Cloudflare Worker).
Chaque envoi sur la branche main redéploie automatiquement le serveur sur Cloudflare.

- worker.js : le code du serveur (temps réel SNCF, carte, paris).
- wrangler.jsonc : sa configuration (nom, base D1, déclencheur toutes les 5 min).

Les secrets (SNCF_KEY, TEAM_CODE) sont dans le tableau de bord Cloudflare, jamais ici.
