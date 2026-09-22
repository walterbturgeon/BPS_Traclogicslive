# Intégrer les flux MYLAPS / Speedhive dans une app mobile

Référence d'intégration — endpoints, modèles de données, architecture.
Cible : app mobile (iOS / Android / Flutter).

**Relevé effectué le 22 septembre 2026**, par observation directe du client web
Speedhive (`speedhive.mylaps.com`) et appels réels contre les API de production.
Tous les exemples de réponses ci-dessous sont des captures authentiques, pas des
schémas inventés.

---

## 0. Statut juridique et technique — à lire avant de coder

Ces API sont **accessibles publiquement mais non documentées publiquement**. Il
n'existe aucun portail développeur, aucune clé d'API, aucun contrat de niveau de
service, aucune promesse de compatibilité ascendante.

Conséquences concrètes :

| Fait | Implication pour ton app |
|---|---|
| Aucune auth sur les endpoints de lecture | Démarrage immédiat, zéro friction d'onboarding |
| Aucun versionnement stable annoncé | Le préfixe `v0.2.3` peut sauter sans préavis — isole-le dans une constante |
| Aucun SLA | Prévois un mode dégradé et un cache local dès le jour 1 |
| Pas de rate limit documenté | Aucun en-tête `X-RateLimit-*` observé, mais assume qu'il existe côté edge |
| Données personnelles présentes | Noms de pilotes, codes transpondeurs, courriels d'organisateurs |

**Sur la vie privée :** la réponse `classification` expose le **code transpondeur**
(`"transponder": "11267382"`) et un identifiant de compte MYLAPS
(`MYLAPS-GA-2cf382313b07...`). Le flux live expose le **courriel du chronométreur**
(champ `u` de la liste d'événements). Ne recopie pas ces champs dans une base que
tu exposes ensuite, et ne les affiche pas sans raison. C'est le genre de détail
qui transforme un projet perso en problème.

**Recommandation :** si l'app devient publique ou commerciale, écris à
`support@mylaps.com` avant le lancement. Un usage personnel ou un projet de
club ne pose pas le même problème qu'une app distribuée.

---

## 1. Architecture réelle de la chaîne

```
  Transpondeur (TranX / X2 / Flex)
          │  passage sur boucle
          ▼
  Décodeur MYLAPS en bord de piste
          │  timestamp
          ▼
  Orbits (logiciel du chronométreur)          ← version visible dans l'API : "Orbits 5.15.1"
          │
          ├──► publication résultats ────► eventresults-api.speedhive.com
          │                                 (post-session, persistant)
          │
          └──► flux live ────────────────► lt-api.speedhive.com
                                            (session active, éphémère)
                                                   │
                                                   └──► Azure SignalR ──► push temps réel
```

Point clé : **deux API distinctes, deux espaces d'identifiants incompatibles.**

- Event Results → `eventId` **numérique** (`3721130`)
- Live Timing → `eventId` **alphanumérique** (`OUMMNDLQ-2147485640`)

Il n'existe pas de table de correspondance exposée entre les deux. Une session
live devient un résultat d'événement après publication, mais **tu ne peux pas
suivre le même objet d'un système à l'autre par son id**. Le recoupement se fait
par heuristique : nom d'organisation + circuit + date. Traite-les comme deux
domaines séparés dans ton modèle.

---

## 2. Bootstrap : ne jamais coder les URLs en dur

Le client web récupère toute sa configuration au démarrage :

```
GET https://speedhive.mylaps.com/api/clientSettings
```

Réponse (extrait utile) :

```json
{
  "eventResultApiUrl": "https://eventresults-api.speedhive.com",
  "liveTimingApiUrl": "https://lt-api.speedhive.com",
  "liveTimingNotificationsApiUrl": "https://notifications.speedhive.com",
  "practiceApiUrl": "https://practice-api.speedhive.com",
  "usersAndProductsApiUrl": "https://usersandproducts-api.speedhive.com",
  "searchApiUrl": "https://search.speedhive.com",
  "clientId": "d9109f5a-bce9-4ff7-8c8f-71bf4fb68c40",
  "tenantId": "mylapsb2cprd"
}
```

**Fais pareil.** Appelle `clientSettings` au lancement, mets le résultat en cache
24 h, et construis toutes tes requêtes à partir de là. Si MYLAPS déplace un
service, ton app suit toute seule. C'est le seul mécanisme de résilience qu'ils
t'offrent gratuitement — sers-t'en.

> Piège : le host `eventresult-api.speedhive.com` (sans « s ») **ne résout pas**.
> Plusieurs bibliothèques tierces publient cette URL. La bonne est
> `eventresults-api.speedhive.com`.

---

## 3. API Event Results — résultats publiés

**Base :** `https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/`
**Auth :** aucune
**En-têtes de réponse :** `Cache-Control: no-cache, no-store, must-revalidate` — le
serveur interdit la mise en cache HTTP ; ton cache applicatif est donc obligatoire.

### 3.1 Endpoints

| Méthode | Chemin | Description |
|---|---|---|
| GET | `events` | Liste d'événements (filtrable) |
| GET | `events/{eventId}` | Détail d'un événement |
| GET | `events/{eventId}/sessions` | Sessions de l'événement |
| GET | `sessions/{sessionId}` | Métadonnées d'une session |
| GET | `sessions/{sessionId}/classification` | Classement complet |
| GET | `sessions/{sessionId}/lapchart` | Grille position-par-tour |
| GET | `sessions/{sessionId}/lapdata/{finishPosition}/laps` | **Tours détaillés d'un pilote** |
| GET | `sessions/{sessionId}/announcements` | Drapeaux, pénalités, annonces |
| GET | `sessions/{sessionId}/csv` | Export CSV de la session |
| GET | `sessions/{sessionId}/lapdata/{finishPosition}/csv` | Export CSV des tours |
| GET | `organizations/{orgId}` | Détail organisateur |
| GET | `organizations/{orgId}/events` | Événements d'un organisateur |
| GET | `organizations/{orgId}/championships` | Championnats d'un organisateur |
| GET | `championships/{champId}` | Classement de championnat |
| GET | `championships/{champId}/csv` | Export CSV championnat |
| GET | `accounts/{accountId}/events` | Événements d'un compte MYLAPS |

**Attention au paramètre `{finishPosition}`.** Ce n'est pas un id de pilote ni un
numéro de voiture : c'est la **position finale au classement**. Pour obtenir les
tours du 3ᵉ, tu appelles `.../lapdata/3/laps`. Il faut donc toujours charger la
`classification` d'abord pour savoir quelle position interroger.

> Piège vérifié : une position inexistante renvoie **`200 OK`** avec
> `{"lapDataInfo": null, "laps": []}`, pas un `404`. Ton code doit tester
> `lapDataInfo != null` — un `switch` sur le code HTTP seul te donnera un écran
> vide sans erreur.

### 3.2 Paramètres de `events`

| Paramètre | Valeurs |
|---|---|
| `sportCategory` | `Motorized`, `Active`, `ActiveEvent`, `ActiveRace` |
| `sport` | `Karting`, `MX`, `Car`, `Bike`, `RC`, `StockCar`, `Cycling`, `IceSkating`, `Running`, `ModelBoatRacing`, `InlineSkating`, `Swimming`, `Equine`, `Triathlon`, `Duathlon`, `Other`, `All` |
| `startDate` / `endDate` | ISO 8601 |
| `country` | code pays |
| `count` / `offset` | pagination |

`events/{id}` accepte `?sessions=true` pour inclure l'arborescence des sessions.

### 3.3 Modèle de données réel

**Événement** (`GET events?count=1&sportCategory=Motorized`) :

```json
{
  "id": 3721130,
  "name": "Curbstone 22 & 23 September",
  "organization": {
    "id": 596024,
    "name": "Races Information Services SRL",
    "city": "WERBOMONT",
    "country": { "id": 56, "name": "Belgium", "alpha2": "BE" },
    "sport": "Car",
    "ref": "/api/organizations/596024"
  },
  "sport": "Car",
  "startDate": "2026-09-22",
  "location": {
    "id": 533312,
    "name": "Spa Francorchamps",
    "length": 7.004,
    "lengthUnit": "km",
    "lengthLabel": "7.0040 km"
  },
  "uploadSoftware": { "name": "Orbits", "version": "5.15.0" },
  "updatedAt": "2026-09-22T15:13:52",
  "sessions": null
}
```

**`updatedAt` est ta clé d'invalidation de cache.** C'est le seul signal de
fraîcheur fiable de toute l'API.

**Sessions** — structure **imbriquée**, pas une liste plate :

```json
{
  "sessions": [],
  "groups": [
    {
      "id": 3721133,
      "name": "RACE Day 1",
      "date": "2026-09-21",
      "subGroups": [],
      "sessions": [
        {
          "id": 12867842,
          "name": "Session 1",
          "eventId": 3721130,
          "type": "practice",
          "startTime": "2026-09-22T09:00:00",
          "groupName": "RACE Day 1",
          "isMerge": false,
          "resultStatus": "Provisional",
          "participated": 0
        }
      ]
    }
  ]
}
```

Le tableau `sessions` de premier niveau est **vide** ; tout est sous
`groups[].sessions[]`, avec un niveau `subGroups[]` possible. Écris une fonction
d'aplatissement récursive dès le départ.

`resultStatus` vaut `Provisional` ou `Official`. **Affiche cette distinction dans
ton UI** — un classement provisoire peut encore bouger après vérification
technique, et un utilisateur qui prend un provisoire pour un officiel te le
reprochera.

**Classement** (`sessions/12867842/classification`) :

```json
{
  "type": "PracticeAndQualification",
  "bestLap": { "name": "ANS #1", "lapNumber": 9, "lapTime": "02:19.630", "speed": 180.58 },
  "classes": ["Race", "RACE", "Sport"],
  "rows": [
    {
      "position": 1,
      "positionInClass": 1,
      "name": "ANS #1",
      "startNumber": "178",
      "resultClass": "Race",
      "status": "Normal",
      "numberOfLaps": 12,
      "bestTime": "02:19.630",
      "bestLap": 9,
      "bestSpeed": 180.58,
      "gap":        { "lapsBehind": 0, "timeDifference": "00.000" },
      "difference": { "lapsBehind": 0, "timeDifference": "00.000" },
      "gapClass":   { "lapsBehind": 0, "timeDifference": "00.000" },
      "diffClass":  { "lapsBehind": 0, "timeDifference": "00.000" },
      "transponder": "11267382",
      "transponderCategory": "TR2",
      "accountId": "MYLAPS-GA-2cf382313b074227865126225132e59d",
      "isQualified": true,
      "additionalFields": []
    }
  ]
}
```

Noter : `classes` peut contenir des doublons de casse (`"Race"` et `"RACE"`) —
les données viennent de la saisie libre du chronométreur. Normalise avant de
grouper.

**Tours détaillés** (`sessions/12867842/lapdata/1/laps?count=5`) — le morceau
intéressant pour de la télémétrie :

```json
{
  "lapDataInfo": {
    "participantInfo": {
      "name": "ANS #1", "class": "Race", "transponder": "11267382",
      "startNr": "178", "startPos": 7, "fieldFinishPos": 1, "classFinishPos": 1
    },
    "lapCount": 12, "lapsDriven": 12, "firstLapNr": 1,
    "classificationTypeString": "PracticeAndQualification",
    "sessionId": 12867842
  },
  "laps": [
    {
      "lapNr": 1,
      "timeOfDay": "2026-09-22T09:08:16.65",
      "lapTime": "2:26.905",
      "diffWithLastLap": "0.000",
      "diffWithBestLap": "7.275",
      "speed": 171.637,
      "sectionTimes": ["03:11.454", "02:35.099", "02:58.598"],
      "inPit": false,
      "status": ["GREEN"],
      "fieldComparison": { "position": 6, "leaderLap": 1, "diff": null, "gapAhead": null, "gapBehind": null }
    }
  ]
}
```

`timeOfDay` en précision centiseconde est **la clé de synchronisation** avec une
source externe de télémétrie : c'est l'horodatage absolu du passage sur la ligne.

> Incohérence observée : sur cet échantillon, les `sectionTimes` additionnés
> dépassent le `lapTime`. La configuration des boucles intermédiaires est laissée
> au chronométreur et n'est pas normalisée. **Ne calcule jamais un temps au tour
> en sommant les secteurs** — prends `lapTime`, et traite `sectionTimes` comme
> indicatif.

### 3.4 Formats à parser soi-même

Les durées sont des **chaînes**, jamais des nombres, et le format varie :

| Vu dans l'API | Signification |
|---|---|
| `"2:26.905"` | 2 min 26,905 s |
| `"02:19.630"` | idem, zéro initial |
| `"58.047"` | 58,047 s, sans champ minutes |
| `"00:37:19.000"` | 37 min 19 s (temps de course) |
| `"00.000"` | écart nul |

Écris un parseur unique et tolérant, et convertis tout en `Duration` (ms) à la
frontière de ta couche réseau. Ne laisse jamais ces chaînes remonter dans ta
logique métier.

Les dates aussi changent de format selon l'API :
`"2026-09-22T09:08:16.65"` (Event Results, ISO sans fuseau) contre
`"22-09-2026 20:00:00.000"` (Live Timing, jour-mois-année).

**Aucune des deux ne porte de fuseau horaire.** Les heures sont locales au
circuit. Pour afficher correctement, il faut déduire le fuseau depuis
`location.country` ou les coordonnées `lat`/`lon` du flux live.

---

## 4. API Live Timing — session en cours

**Base :** `https://lt-api.speedhive.com/api/`
**Auth :** aucune

### 4.1 Endpoints REST

| Méthode | Chemin | Description |
|---|---|---|
| GET | `events` | **Tous les événements live en cours, mondialement** |
| GET | `events/{eventId}` | Détail + liste des sessions |
| GET | `events/{eventId}/active` | Session active + classement instantané |
| GET | `events/{eventId}/sessions/{sessionId}/data` | Classement d'une session donnée |
| GET | `events/{eventId}/sessions/{sessionId}/stats` | Statistiques de session |
| GET | `events/{eventId}/sessions/{sessionId}/weather` | Météo (404 si non configurée) |
| GET | `events/{eventId}/sessions/{sessionId}/announcements` | Annonces |
| GET | `events/{eventId}/active/announcements` | Annonces de la session active |
| GET | `events/{eventId}/trackmap` | Tracé du circuit (404 si non configuré) |
| GET | `timers/{timerId}/sponsors` | Commanditaires (`timerId` = courriel du chronométreur) |

`GET events` retournait **84 événements live simultanés** au moment du relevé.
C'est le point d'entrée de découverte : aucun paramètre, aucune auth.

### 4.2 Clés compactes — table de décodage

Le flux live utilise des noms de champs abrégés pour réduire la bande passante.
Décodage établi par recoupement avec l'affichage du client web :

**Événement** (`events`) :

| Clé | Sens | Confiance |
|---|---|---|
| `id` | id événement (`OUMMNDLQ-2147485640`) | certain |
| `n` | nom | certain |
| `dt` | date (`22-09-2026 00:00:00.000`) | certain |
| `l` | lieu : `c` pays, `cc` code, `ct` ville, `lat`, `lon` | certain |
| `t` | circuit : `id`, `n` nom, `l` longueur, `um` unité | certain |
| `u` | courriel du chronométreur (= `timerId`) | certain |
| `ov` | version du logiciel (`Orbits 5.15.0`) | certain |
| `s` | code de statut | inféré |
| `f` | drapeau courant | inféré |
| `pyt` | — | inconnu |

**Session** (`events/{id}` → `ss[]`) :

| Clé | Sens | Confiance |
|---|---|---|
| `id` | id session (`{eventId}-1073749484`) | certain |
| `eId` / `eNam` | id / nom de l'événement parent | certain |
| `gNam` | nom du groupe (`タイムトライアル`) | certain |
| `rnNam` | nom de la manche | certain |
| `stod` | heure de départ prévue | certain |
| `rnTp` | type de manche (practice / qualif / course) | inféré |
| `ls` | tours complétés | certain |
| `lsTg` | tours restants (laps to go) | inféré |
| `rcTm` | temps de course écoulé | certain |
| `btLpTim` | meilleur tour de la session | certain |
| `f` | drapeau | inféré |

L'id de session **contient** l'id d'événement en préfixe — pratique pour valider
la cohérence côté client.

**Ligne de classement live** (`active` → `l[]`) :

| Clé | Sens | Confiance |
|---|---|---|
| `pos` / `lbpos` | position affichée / position au tableau | certain |
| `pCl` | position dans la classe | certain |
| `nam` | nom du concurrent | certain |
| `no` / `dNo` | numéro / numéro affiché | certain |
| `cl` / `cln` | classe / nom de classe | certain |
| `ls` | nombre de tours | certain |
| `lsTm` | dernier temps au tour | certain |
| `btTm` | meilleur temps | certain |
| `tTm` | temps total | certain |
| `ibt` | meilleur tour de la session (booléen) | inféré |
| `btCl` | meilleur tour de sa classe (booléen) | inféré |
| `id` | id du concurrent dans la session | certain |
| `sesId` | id de session (redondant, à ignorer) | certain |
| `if` | voiture aux stands | inféré |
| `mkr` | marqueur / état visuel | inconnu |
| `anim` | distance parcourue pour l'animation carte | inféré |
| `asp` | vitesse d'animation | inféré |

**Traite les champs « inféré » et « inconnu » comme non fiables.** Mappe-les
dans ton modèle mais ne construis aucune logique métier dessus sans les avoir
validés toi-même contre un événement que tu peux observer en direct.

**Statistiques** (`sessions/{id}/stats`) :

```json
{
  "rnNam": "タイムアタック　1", "stDt": "09:41",
  "numPs": 14, "numPar": 15,
  "tLs": 11, "tPs": 0, "tLsLdr": 11, "mstTo": 1,
  "bestLapTime": "58.047", "bestLapDriverName": "ＬＲ１号車",
  "ldrH": [], "btLpH": [], "pgH": []
}
```

`numPar` = participants, `tLsLdr` = tours du leader. Les tableaux `ldrH`, `btLpH`,
`pgH` sont des historiques (leader, meilleur tour, progression) — vides sur cet
échantillon.

### 4.3 Push temps réel — Azure SignalR

Le client web **ne fait pas de polling**. Il ouvre une connexion SignalR.

**Étape 1 — négociation** (anonyme, `POST`, pas de corps) :

```
POST https://notifications.speedhive.com/api/negotiate?negotiateVersion=1
```

Réponse :

```json
{
  "url": "https://livetimingnotifications-eu-prd-sig01.service.signalr.net/client/?hub=livetiminghub",
  "accessToken": "<JWT>"
}
```

**Étape 2 — connexion** au hub `livetiminghub` avec ce jeton.

**Étape 3 — abonnement.** Le hub expose deux méthodes :

| Méthode | Argument |
|---|---|
| `JoinGroup` | l'**eventId live** (`OUMMNDLQ-2147485640`) |
| `LeaveGroup` | le groupe courant |

Le groupe est l'id d'événement, pas l'id de session. Un seul groupe actif à la
fois côté client web.

**Étape 4 — événements reçus** :

| Événement | Charge utile |
|---|---|
| `leaderboardUpdated` | classement complet (remplace, ne fusionne pas) |
| `sessionAddedOrUpdated` | métadonnées de session |
| `eventAddedOrUpdated` | métadonnées d'événement |
| `announcementsUpdated` | une annonce (à empiler côté client) |
| `statisticsUpdated` | statistiques |
| `weatherUpdated` | météo |
| `progressUpdated` | progression (animation carte) |
| `sessionsModified` | liste des sessions modifiée |
| `resultsForSessionReceived` | résultats d'une session |
| `weatherForecastUpdated` | prévisions |

`leaderboardUpdated` envoie le **tableau complet**, pas un delta. Simple à gérer,
mais volumineux sur un plateau de 40 voitures — prévois du throttling d'affichage
si tu rafraîchis une liste Flutter à chaque message.

**Séquence correcte au démarrage :**

1. `GET events/{id}` → sessions
2. `GET events/{id}/active` → instantané initial (sinon écran vide jusqu'au premier push)
3. Négocier + connecter SignalR
4. `JoinGroup(eventId)`
5. Appliquer les mises à jour

Inverser 2 et 3 te fait rater l'état initial : le hub ne renvoie pas de snapshot
à l'arrivée.

**Reconnexion.** Le client web utilise `withAutomaticReconnect()` et **rejoint le
groupe après chaque reconnexion** — le serveur ne conserve pas l'appartenance.
Câble ce comportement, sinon ton app se retrouve connectée mais silencieuse, le
pire des modes de panne parce qu'il ne lève aucune erreur.

---

## 5. Les autres services

| Service | Base | Préfixe | Auth | Contenu |
|---|---|---|---|---|
| Practice | `practice-api.speedhive.com` | `/api/v1/` | **OAuth2** | `training/activities/{id}`, `/statistics`, `/sessions`, `/chips`, `accounts/{id}/training/activities` |
| Users & Products | `usersandproducts-api.speedhive.com` | `/api/v2/accounts`, `/api/v1/speedhiveprofile` | **OAuth2** | profils, avatars, vidéos, transpondeurs enregistrés |
| Search | `search.speedhive.com` | `/sporthive/` | aucune | `search?...`, `races/{id}/participants`, `teams/{id}` |

Les sessions de practice personnelles (celles liées à **ton** transpondeur) sont
derrière **Azure AD B2C** : tenant `mylapsb2cprd`, `clientId`
`d9109f5a-bce9-4ff7-8c8f-71bf4fb68c40`, portail `account.mylaps.com`.

Le jeton se passe en `Authorization: Bearer <token>` — le client web utilise le
même mécanisme pour toutes les API, ce qui laisse penser que les endpoints
publics acceptent aussi un jeton et peuvent renvoyer plus de données une fois
authentifié. **Non vérifié.**

**Conseil de séquencement :** livre d'abord le périmètre sans auth (Event Results
+ Live Timing). Il couvre l'essentiel et ne demande aucun compte. N'ajoute OAuth2
que si tu veux vraiment les sessions personnelles — c'est un chantier à lui seul
et le client B2C d'un tiers peut se refermer sans préavis.

---

## 6. Architecture applicative recommandée

```
┌──────────────────────────────────────────┐
│  UI (Flutter widgets)                    │
├──────────────────────────────────────────┤
│  State (Riverpod / Bloc)                 │
├──────────────────────────────────────────┤
│  Repository                              │  ← fusionne cache + réseau, arbitre la fraîcheur
├───────────────┬──────────────────────────┤
│  Cache (Isar  │  Clients API             │
│  / Drift)     │  ├─ ClientSettings       │
│               │  ├─ EventResults (REST)  │
│               │  ├─ LiveTiming   (REST)  │
│               │  └─ LiveHub   (SignalR)  │
└───────────────┴──────────────────────────┘
```

### Politique de cache

| Donnée | Durée | Invalidation |
|---|---|---|
| `clientSettings` | 24 h | au lancement |
| Liste d'événements | 15 min | pull-to-refresh |
| Événement + sessions | 1 h | comparer `updatedAt` |
| Classement `Official` | **permanent** | jamais — un résultat officiel est figé |
| Classement `Provisional` | 5 min | `updatedAt` |
| Lapdata | suit le statut de la session parente | — |
| Liste live `events` | 60 s | — |
| Classement live | pas de cache | SignalR |

Le cache permanent sur les résultats officiels est le gain le plus important :
l'essentiel des consultations porte sur des courses passées, et ces données ne
changent plus jamais. Ça rend l'app utilisable hors ligne et réduit ta charge
réseau d'un ordre de grandeur.

### Paquets Flutter

```yaml
dependencies:
  dio: ^5.4.0                    # client HTTP, intercepteurs, retry
  signalr_netcore: ^1.3.7        # client SignalR, reconnexion auto
  isar: ^3.1.0                   # cache local, requêtable
  riverpod: ^2.5.0               # état
  freezed_annotation: ^2.4.1     # modèles immuables
  json_annotation: ^4.8.1
```

`signalr_netcore` est le client SignalR Dart le plus mature et supporte
`withAutomaticReconnect` — indispensable ici.

### Parseur de durée

Écris-le une fois, teste-le contre les cinq formats du §3.4 :

```dart
Duration? parseLapTime(String? s) {
  if (s == null || s.isEmpty || s == '-') return null;
  final parts = s.split(':');
  double seconds = double.parse(parts.last);
  int minutes = 0, hours = 0;
  if (parts.length >= 2) minutes = int.parse(parts[parts.length - 2]);
  if (parts.length >= 3) hours = int.parse(parts[parts.length - 3]);
  return Duration(
    milliseconds: (hours * 3600000) + (minutes * 60000) + (seconds * 1000).round(),
  );
}
```

### Connexion au hub

```dart
final negotiate = await dio.post(
  '${settings.liveTimingNotificationsApiUrl}/api/negotiate',
  queryParameters: {'negotiateVersion': 1},
);

final connection = HubConnectionBuilder()
    .withUrl(
      negotiate.data['url'],
      options: HttpConnectionOptions(
        accessTokenFactory: () async => negotiate.data['accessToken'],
      ),
    )
    .withAutomaticReconnect()
    .build();

connection.on('leaderboardUpdated', (args) {
  final rows = (args?.first as Map)['l'] as List;
  leaderboardController.add(rows.map(LiveRow.fromJson).toList());
});

connection.onreconnected(({connectionId}) async {
  await connection.invoke('JoinGroup', args: [eventId]);   // impératif
});

await connection.start();
await connection.invoke('JoinGroup', args: [eventId]);
```

---

## 7. Pièges — récapitulatif

1. **`eventresults-api`**, pas `eventresult-api`. Le second ne résout pas.
2. **Deux espaces d'identifiants** sans pont entre eux.
3. **Sessions imbriquées** dans `groups[].sessions[]`, avec `subGroups[]`.
4. **`lapdata/{finishPosition}`** — position finale, pas un id de pilote ; une
   position invalide renvoie `200` avec `lapDataInfo: null`, pas `404`.
5. **Durées en chaînes**, cinq formats, à normaliser à la frontière réseau.
6. **Dates sans fuseau**, locales au circuit, deux formats selon l'API.
7. **`sectionTimes` incohérents** avec `lapTime` — ne jamais sommer.
8. **`Provisional` vs `Official`** — à refléter dans l'UI.
9. **`no-store`** côté serveur : cache applicatif obligatoire.
10. **Rejoindre le groupe après reconnexion** — panne silencieuse sinon.
11. **Snapshot REST avant SignalR**, jamais l'inverse.
12. **Casse incohérente** des noms de classes (saisie libre).
13. **Données personnelles** dans les réponses (transpondeurs, courriels).
14. **Versionnement `v0.2.3`** — isoler dans une constante.

---

## 8. Ordre de construction suggéré

1. `clientSettings` + couche réseau + parseur de durée, avec tests unitaires sur
   les formats réels ci-dessus.
2. Liste d'événements + détail + sessions. Valide l'aplatissement des groupes.
3. Classement + lapdata. C'est le cœur de valeur de l'app.
4. Cache Isar avec la politique du §6. Teste le mode avion.
5. Live timing REST : liste live, session active, rafraîchissement 60 s.
6. SignalR par-dessus. Teste explicitement la coupure réseau et la reconnexion.
7. OAuth2 B2C seulement si les sessions personnelles sont vraiment nécessaires.

Les étapes 1 à 4 donnent une app complète et utile sans jamais toucher au temps
réel. Si le temps manque, c'est là qu'il faut s'arrêter.

---

*Relevé du 22 septembre 2026. Ces API n'étant pas contractuelles, revérifie les
endpoints avant toute mise en production.*

---

## 9. Ce que le relevé du 22 septembre 2026 ajoute : la PWA ne peut pas appeler ces API

Mesure faite depuis la page TRACLOGICS Live (origine `walterbturgeon.github.io`)
et en ligne de commande, le 22 septembre 2026 :

| Appel | En-tete `Origin` envoye | Reponse |
|---|---|---|
| `GET lt-api.speedhive.com/api/events` | `https://walterbturgeon.github.io` | **401** `API key incorrect or expired` |
| `GET lt-api.speedhive.com/api/events` | `https://speedhive.mylaps.com` | **200**, 129 541 octets |
| `GET speedhive.mylaps.com/api/clientSettings` | quelconque | 200, mais **aucun en-tete CORS** |

Le serveur renvoie `Access-Control-Allow-Origin: https://speedhive.mylaps.com` :
l'API de chronometrage en direct n'est ouverte qu'a son propre client web. La
mention « aucune auth » de la section 4 est donc vraie pour un client NATIF,
faux pour un navigateur : le filtre est l'origine, pas une cle.

**Consequence pour ce projet.** La page TRACLOGICS Live est une PWA : elle ne
peut pas lire ces flux. Deux chemins seulement :

1. Un relais (serveur) qui refait l'appel en se presentant comme le client web
   de Speedhive. Il contourne leur barriere d'origine -- decision de l'utilisateur,
   et courriel a `support@mylaps.com` avant tout usage public.
2. **Choix retenu le 22 septembre 2026 : l'application native.** Quand la page
   sera emballee en application (Capacitor, jalon deja note pour le portage
   iOS/Android), l'appel HTTP natif ignore le CORS et la section 4 s'applique
   telle quelle. L'integration du chronometrage en direct et des positions
   attend ce moment.
