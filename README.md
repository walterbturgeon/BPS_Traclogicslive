# TRACKLOGICS MT

Page de tours de piste (PWA) : un onglet par voiture, journées et sessions,
carte du tour, partielles, comparaison entre tours, 8 canaux à 1 Hz.

Elle se connecte en Bluetooth au collecteur `RELAY_MT` (ESP32-S3 `TBS_ble`),
qui reçoit les tours des boîtes DLPT2 par un T-Beam (`TBS_collecteur`).

Publiée : https://walterbturgeon.github.io/BPS_Traclogicslive/

Dépôt séparé de `DLDP_fusion1` pour que l'installation de cette PWA n'entre
pas en conflit avec celle de DRAGLOGICS : leurs portées ne se recouvrent plus.

Source de travail : `Documents/DRAGLOG_TRLG_webapp/mt/`.
