> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../setup.md) maßgeblich.

# Einrichtungsanleitung

[< Zurück zur README](../../README.md)

## Option 1: Desktop-App (am einfachsten)

Lade den neuesten Installer für deine Plattform von [GitHub Releases](https://github.com/hyiger/filament-db/releases):

- **macOS (Apple Silicon)**: `FilamentDB-x.x.x-mac-arm64.dmg`
- **macOS (Intel)**: `FilamentDB-x.x.x-mac-x64.dmg`
- **Windows**: `FilamentDB-x.x.x-windows-x64-setup.exe`
- **Linux x64**: `FilamentDB-x.x.x-linux-x86_64.AppImage` oder `FilamentDB-x.x.x-linux-amd64.deb`
- **Linux arm64** (Raspberry Pi 5): `FilamentDB-x.x.x-linux-arm64.AppImage` oder `FilamentDB-x.x.x-linux-arm64.deb`

Beim ersten Start wirst du nach einem Verbindungsmodus gefragt:

- **MongoDB Atlas (Cloud)** — Verbindung zu einer Cloud-Datenbank. Benötigt ein MongoDB-Atlas-Konto und Internet.
- **Hybrid (Lokal + Cloud-Sync)** — Daten lokal speichern mit automatischem Hintergrund-Sync zu Atlas. Funktioniert offline und synchronisiert, sobald Internet verfügbar ist. *Empfohlen für die meisten Nutzer.*
- **Nur lokal (Offline)** — alle Daten auf deinem Computer gespeichert. Kein Cloud-Konto, kein Internet nötig. Du kannst später in den Hybrid-Modus wechseln.

Für Atlas- und Hybrid-Modus brauchst du eine MongoDB-Atlas-Verbindungszeichenfolge. Siehe [MongoDB Atlas einrichten](#mongodb-atlas-einrichten-kostenlose-stufe), falls du noch kein Konto hast.

## Option 2: Docker

Filament DB als Docker-Container betreiben. Das Image ist ~72 MB groß, basiert auf `node:22-alpine` und unterstützt sowohl `linux/amd64` als auch `linux/arm64` (Raspberry Pi).

> **Hinweis:** Das Docker-Image betreibt nur die Web-App. NFC-Tag-Lesen/Schreiben (OpenPrintTag, Bambu und OpenTag3D) erfordert die [Desktop-App](#option-1-desktop-app-am-einfachsten) für den direkten USB-Hardwarezugriff.

### Schnellstart

```bash
docker run -p 127.0.0.1:3456:3000 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  ghcr.io/hyiger/filament-db
```

Öffne http://localhost:3456.

> **Sicherheit:** Das Präfix `127.0.0.1:` bindet den Port **nur an diese Maschine**. Ein bloßes `-p 3456:3000` veröffentlicht auf **allen** Host-Schnittstellen und gibt damit die API von Filament DB im gesamten LAN frei — und die API ist **standardmäßig nicht authentifiziert**. Lass das `127.0.0.1:`-Präfix nur weg, wenn du den Dienst von anderen Geräten aus erreichen willst, und lies zuerst [Eine netzwerkexponierte Instanz absichern](#eine-netzwerkexponierte-instanz-absichern).

### Docker Compose

Lege eine `docker-compose.yml` an:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      # Nur Loopback — von diesem Host erreichbar. Für den Zugriff von anderen
      # Geräten "3456:3000" verwenden und "Eine netzwerkexponierte Instanz
      # absichern" lesen.
      - "127.0.0.1:3456:3000"
    environment:
      - MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db
      # Optional: AI-Provider für TDS-Extraktion (eine wählen)
      # - GEMINI_API_KEY=your-key
      # - ANTHROPIC_API_KEY=your-key
      # - OPENAI_API_KEY=your-key
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Docker Compose mit lokaler MongoDB

Wenn du kein MongoDB-Atlas-Konto hast, kannst du MongoDB neben Filament DB laufen lassen:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      # Nur Loopback (siehe Hinweis oben). "3456:3000" für LAN-Freigabe.
      - "127.0.0.1:3456:3000"
    environment:
      - MONGODB_URI=mongodb://mongo:27017/filament-db
    depends_on:
      - mongo
    restart: unless-stopped

  mongo:
    image: mongo:8
    volumes:
      - mongo-data:/data/db
    restart: unless-stopped

volumes:
  mongo-data:
```

### Umgebungsvariablen

| Variable | Erforderlich | Beschreibung |
|----------|----------|-------------|
| `MONGODB_URI` | Ja | MongoDB-Verbindungszeichenfolge |
| `PORT` | Nein | Serverport im Container (Standard: `3000`) |
| `HOSTNAME` | Nein | Schnittstelle, an die der Server im Container bindet (Standard: `0.0.0.0`). Die Erreichbarkeit steuert das `docker run -p`-Mapping, nicht diese Variable. |
| `TZ` | Nein | IANA-Zeitzone für die Container-Uhr, z. B. `Europe/Berlin` (Standard: UTC). Das Image enthält `tzdata`, sodass ein Zonenname korrekt aufgelöst wird. |
| `FILAMENTDB_HTTPS_PORT` | Nein | Schaltet das **sichere Gateway** ein: einen zweiten Port, der HTTPS spricht und einen API-Schlüssel verlangt, für den Zugriff von anderen Geräten. Der HTTP-Port bleibt für diese Maschine offen. Siehe [Eine netzwerkexponierte Instanz absichern](#eine-netzwerkexponierte-instanz-absichern). |
| `FILAMENTDB_HTTPS_HOST` | Nein | Schnittstelle, an die das sichere Gateway bindet (Standard: `0.0.0.0`). |
| `FILAMENTDB_API_KEY` | Nein | Der API-Schlüssel. Bei laufendem sicherem Gateway: der Schlüssel des Gateways, 32 bis 512 Zeichen lang (ungesetzt wird ein zufälliger erzeugt, der sich in den Einstellungen erneuern lässt). Sonst: ein Bearer-Token-Gate für **jede** `/api/*`-Anfrage am HTTP-Port, das auch die Browser-Web-UI deaktiviert. |
| `FILAMENTDB_SECURE_DIR` | Nein | Wo das sichere Gateway den erzeugten API-Schlüssel und die Zertifikate ablegt. Standard im Image: `/data/secure` (binde ein Volume unter `/data` ein, um sie zu behalten). Sonst `~/.filament-db/secure` des Benutzers, unter dem der Server läuft; setze für einen Systemdienst einen absoluten Pfad, in den dieser Benutzer schreiben darf. |
| `FILAMENTDB_TLS_CERT`, `FILAMENTDB_TLS_KEY` | Nein | Absolute Pfade der PEM-Dateien deines eigenen Zertifikats für das sichere Gateway. Ungesetzt erzeugt es eine lokale Zertifizierungsstelle und ein Serverzertifikat. |
| `FILAMENTDB_TLS_HOSTS` | Nein | Zusätzliche, durch Komma getrennte DNS-Namen und IP-Adressen für das erzeugte Zertifikat, z. B. `192.168.1.10,nas.local`. Nötig in einem Container, der die Adresse seines Hosts nicht kennt. |
| `GEMINI_API_KEY` | Nein | Google-Gemini-API-Key für TDS-Extraktion |
| `ANTHROPIC_API_KEY` | Nein | Anthropic-Claude-API-Key für TDS-Extraktion |
| `OPENAI_API_KEY` | Nein | OpenAI-API-Key für TDS-Extraktion |
| `ALLOWED_ORIGINS` | Nein | Komma-separierte vollständige Origins (z. B. `https://dash.example.com,http://10.0.0.5:8123`), deren Browser-Seiten `/api/*` cross-origin aufrufen dürfen. Funktioniert auch in Produktion. Siehe [Die API von einem anderen Web-Origin aufrufen (CORS)](#die-api-von-einem-anderen-web-origin-aufrufen-cors). |
| `ALLOWED_DEV_ORIGINS` | Nein | Komma-separierte Hostnamen, die auf den **Dev**-Server zugreifen dürfen (z. B. `myhost.local`). Nur für Dev und kein CORS: dafür `ALLOWED_ORIGINS` verwenden. |

### Eine netzwerkexponierte Instanz absichern

Das Vertrauensmodell von Filament DB ist **localhost / Einzelnutzer**: Der HTTP-Port hat **keine Authentifizierung**. Das passt, solange der Port an Loopback (`127.0.0.1:`) gebunden ist oder du die Desktop-App verwendest, und es passt nicht mehr, sobald er in ein Netzwerk veröffentlicht wird (ein bloßes `-p 3456:3000` oder ein Dienst, der an `0.0.0.0` bindet): Jedes Gerät, das ihn erreicht, kann alles lesen und ändern.

Um Filament DB von anderen Geräten aus zu erreichen, lass den HTTP-Port, wo er ist, und schalte das **sichere Gateway** ein: einen zweiten Port, der HTTPS spricht und einen API-Schlüssel verlangt.

| Port | Spricht | Für | Schlüssel |
|------|---------|-----|-----------|
| HTTP (`PORT`; `3000` im Container) | einfaches HTTP | diese Maschine: der Browser darauf, ein Slicer darauf | keiner |
| HTTPS (`FILAMENTDB_HTTPS_PORT`) | TLS | jedes andere Gerät: Smartphones, andere Computer, Skripte | erforderlich |

Ein Port kann nicht beides leisten. Der Server kann eine lokale Anfrage nicht verlässlich von einer entfernten unterscheiden (jeden Header, der das aussagen könnte, kann der Client selbst setzen), deshalb braucht „für mich offen, für alle anderen gesperrt“ zwei Ports.

#### Einschalten

```bash
docker run \
  -p 127.0.0.1:3456:3000 \
  -p 3443:3443 \
  -v filamentdb-data:/data \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  -e FILAMENTDB_HTTPS_PORT=3443 \
  -e FILAMENTDB_TLS_HOSTS="192.168.1.10,nas.local" \
  ghcr.io/hyiger/filament-db
```

- `-p 127.0.0.1:3456:3000` hält den offenen HTTP-Port auf dieser Maschine. `-p 3443:3443` veröffentlicht den sicheren Port ins Netzwerk.
- `-v filamentdb-data:/data` bewahrt den API-Schlüssel und die Zertifikate auf. **Ohne Volume werden bei jedem Neuerstellen des Containers ein neuer Schlüssel und eine neue Zertifizierungsstelle erzeugt**, und jedes Gerät muss erneut eingerichtet werden.
- `FILAMENTDB_TLS_HOSTS` nennt die Namen und Adressen, die andere Geräte eintippen. Ein Container kennt die Adresse seines Hosts nicht; das erzeugte Zertifikat würde sonst nur Adressen nennen, die außerhalb des Containers niemand nutzen kann.

Für einen mit `npm start` oder systemd gestarteten Dienst setzt du dieselben Variablen in dessen Umgebung und bindest den HTTP-Port mit `HOSTNAME=127.0.0.1` an Loopback.

> **Solange das Gateway läuft, braucht der HTTP-Port keinen Schlüssel, auch wenn `FILAMENTDB_API_KEY` gesetzt ist.** Lass diesen Port an Loopback, oder veröffentliche ihn auf einer Maschine, an der niemand surft, gar nicht. Der Server schreibt bei jedem Start eine Erinnerung ins Log. Kann das Gateway nicht starten (Port belegt, Zertifikat nicht lesbar), schreibt der Server den Grund ins Log, **Einstellungen → Netzwerk** zeigt ihn an, und ein von dir gesetzter `FILAMENTDB_API_KEY` sichert weiterhin den HTTP-Port.

Der Server muss nach `/data` schreiben können. Ein benanntes Volume wie oben funktioniert ohne Weiteres. Ein per Bind-Mount eingebundenes Host-Verzeichnis muss für die uid `1001` beschreibbar sein, unter der der Container läuft.

#### Der API-Schlüssel

Beim ersten Start erzeugt der Server einen zufälligen 256-Bit-Schlüssel und legt ihn in `/data/secure/api-key` ab, lesbar nur für den Benutzer des Servers.

- **Ansehen:** Öffne Filament DB auf dem Server selbst (`http://localhost:3456`) und gehe zu **Einstellungen → Netzwerk**, oder führe `docker exec <container> cat /data/secure/api-key` aus.
- **Erneuern:** **Einstellungen → Netzwerk → Schlüssel erneuern …** ersetzt ihn durch einen neuen zufälligen Schlüssel. Die Änderung gilt sofort und ohne Neustart: Der alte Schlüssel funktioniert nicht mehr, und jeder damit angemeldete Browser wird abgemeldet.
- **Selbst festlegen:** Setze `FILAMENTDB_API_KEY` auf mindestens 32 Zeichen (`openssl rand -hex 32`). Dieser Schlüssel lässt sich nicht in der App erneuern; ändere die Variable und starte neu. Ein kürzerer Schlüssel wird abgelehnt, und das Gateway startet nicht: Ein Client, der immer weiter rät, wird nicht ausgesperrt; der Schutz ist die Länge des Schlüssels.

Nach zehn falschen Schlüsseln innerhalb einer Minute von einer Adresse werden weitere falsche Schlüssel von dort für den Rest dieser Minute mit `429` beantwortet. Der richtige Schlüssel wird nie abgewiesen; ein Gerät, das einen alten Schlüssel wiederholt, kann also die anderen hinter derselben Adresse nicht aussperren.

#### Verbinden

- **Skripte, die mobile App, jeder API-Client** senden den Schlüssel mit jeder Anfrage:

  ```bash
  curl --cacert filament-db-ca.crt \
    -H "Authorization: Bearer <key>" \
    https://192.168.1.10:3443/api/filaments
  ```

- **Ein Browser**, der `https://192.168.1.10:3443` öffnet, erhält eine Anmeldeseite, die einmalig nach dem Schlüssel fragt. Die Sitzung gilt 30 Tage oder bis der Schlüssel erneuert wird. **Einstellungen → Netzwerk → In diesem Browser abmelden** beendet sie.

#### Das Zertifikat

Wenn du keines bereitstellst, erzeugt der Server eine **lokale Zertifizierungsstelle (CA)** und ein von ihr signiertes Serverzertifikat. Ein Gerät zeigt eine Zertifikatswarnung, bis es dieser CA vertraut:

1. Lade das CA-Zertifikat herunter: **Einstellungen → Netzwerk → Zertifizierungsstelle herunterladen**, oder von einem anderen Gerät aus `http://192.168.1.10:3443/__filamentdb/ca.crt`. (Der sichere Port beantwortet einfaches HTTP für genau zwei Dinge: diesen Download und die Weiterleitung einer versehentlich mit `http://` eingegebenen Adresse auf `https://`. Die App selbst liefert er nie über einfaches HTTP aus.)
2. Prüfe, ob der SHA-256-Fingerabdruck mit dem unter **Einstellungen → Netzwerk** übereinstimmt. Ein Zertifikat ist öffentlich; der Download über einfaches HTTP ist unbedenklich, solange der Fingerabdruck stimmt.
3. Installiere es. **macOS:** Datei öffnen, zur Schlüsselbundverwaltung hinzufügen und auf *Immer vertrauen* stellen. **Windows:** in *Vertrauenswürdige Stammzertifizierungsstellen* installieren. **iOS:** Profil installieren, dann unter *Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen* einschalten. **Android:** *Einstellungen → Sicherheit → Zertifikat installieren → CA-Zertifikat*.

Die CA ist zehn Jahre gültig. Das Serverzertifikat wird automatisch neu ausgestellt, vor Ablauf und immer dann, wenn sich die Adresse der Maschine ändert, ohne dass Geräte etwas davon merken.

> **Die mobile Filament-DB-App** akzeptiert das erzeugte Zertifikat, sobald die CA auf dem Telefon installiert ist, unter iOS und unter Android. Kann sie keine Verbindung herstellen, weil dem Zertifikat nicht vertraut wird, sagt ihr Bildschirm **Server connection** das und öffnet den oben genannten Download. Android-Apps vertrauen einer selbst installierten CA nur, wenn die App das ausdrücklich zulässt: Die App tut das, eine Version von vor dem sicheren Gateway jedoch nicht. Aktualisiere die App oder gib dem Server ein Zertifikat einer öffentlichen CA (siehe unten).

**Dein eigenes Zertifikat.** Binde die PEM-Dateien ein und benenne sie mit absolutem Pfad:

```bash
  -v /srv/filament-db/certs:/certs:ro \
  -e FILAMENTDB_TLS_CERT=/certs/fullchain.pem \
  -e FILAMENTDB_TLS_KEY=/certs/privkey.pem \
```

Ein Zertifikat einer öffentlichen CA (Let's Encrypt, `tailscale cert` von Tailscale) braucht keine Einrichtung auf den anderen Geräten. Eine erneuerte Datei wird innerhalb von zehn Minuten übernommen, ohne Neustart. Die Schlüsseldatei darf nicht mit einer Passphrase geschützt sein, und beide Dateien müssen für die uid `1001` lesbar sein.

> **Let's Encrypt:** Die Dateien unter `/etc/letsencrypt/live/<domain>/` sind Symlinks nach `../../archive`, und `privkey.pem` ist nur für root lesbar. Bindest du nur das Verzeichnis `live/<domain>` ein, erhält der Container ins Leere zeigende Links. Kopiere `fullchain.pem` und `privkey.pem` über einen Erneuerungs-Hook (`--deploy-hook`) in ein eigenes Verzeichnis, mache sie für die uid `1001` lesbar und binde dieses Verzeichnis ein.

#### Ohne Gateway: der Schlüssel am HTTP-Port

`FILAMENTDB_API_KEY` **ohne** `FILAMENTDB_HTTPS_PORT` behält die ältere Anordnung bei: Jede `/api/*`-Anfrage am HTTP-Port muss `Authorization: Bearer <key>` senden.

> **Dieses Gate gilt ganz oder gar nicht und deaktiviert die hauseigene Browser-Web-UI.** Die Web-UI stellt einfache Same-Origin-Anfragen und hängt den Schlüssel nicht an; die UI lädt, aber jeder Aufruf liefert `401`. Außerdem wird der Schlüssel unverschlüsselt übertragen. Verwende es nur für Nicht-Browser-Clients in einem Netzwerk, dem du vertraust; nimm sonst das sichere Gateway.

#### Hinter deinem eigenen Reverse-Proxy

Wenn du bereits nginx, Caddy oder Authelia betreibst, kannst du stattdessen dort TLS terminieren und authentifizieren. **Binde Filament DB selbst an Loopback** (`-p 127.0.0.1:3456:3000` bei Docker, `HOSTNAME=127.0.0.1` beim systemd-Dienst) oder sperre den Port per Firewall; sonst bleibt die App unter `http://<host>:3456` erreichbar, und Nutzer umgehen den Proxy. Der Proxy muss der einzige Weg hinein sein.

> **Konfiguriere den Proxy so, dass er den ursprünglichen `Host`-Header (mit Port) erhält.** Der CSRF-Schutz der App vergleicht das `Origin` einer Anfrage mit ihrem `Host`. Ein Proxy, der `Host` auf die Upstream-Adresse umschreibt (z. B. das bloße `proxy_pass` von nginx, das `Host: 127.0.0.1:3000` sendet), lässt Browser-Anfragen wie Cross-Origin aussehen; sie werden mit `403` abgelehnt. **Das betrifft normale Änderungen in modernen Browsern** (Anlegen/Bearbeiten/Löschen), nicht nur Randfälle. Verwende bei nginx `proxy_set_header Host $http_host;` (**`$http_host`, nicht `$host`**: `$host` lässt den Port weg) und zusätzlich `proxy_set_header X-Forwarded-Proto $scheme;`. `reverse_proxy` von Caddy erhält den vollständigen `Host` standardmäßig.

### Die API von einem anderen Web-Origin aufrufen (CORS)

Eine Webseite, die von einem anderen Origin ausgeliefert wird (ein Dashboard, ein Hausautomations-Panel), kann die API von Filament DB nur lesen, wenn der Server mit CORS-Headern antwortet, und standardmäßig tut er das nicht: Browser blockieren diese Lesezugriffe, und der CSRF-Schutz der App weist Cross-Origin-Änderungen mit `403` ab. Um bestimmte Origins zuzulassen, setze `ALLOWED_ORIGINS` auf eine komma-separierte Liste **vollständiger Origins**: Schema, Host und Port, wenn er nicht der Standard ist.

```bash
docker run -p 3456:3000 \
  -e MONGODB_URI="..." \
  -e ALLOWED_ORIGINS="https://dash.example.com,http://10.0.0.5:8123" \
  ghcr.io/hyiger/filament-db
```

Für einen gelisteten Origin beantwortet `/api/*` Preflight-Anfragen (`OPTIONS`) und setzt `Access-Control-Allow-Origin` auf jede Antwort, und der CSRF-Schutz akzeptiert seine Änderungen. Die Seite darf die Request-Header `Authorization` und `Content-Type` senden; Credentials (Cookies) werden nicht verwendet.

> **Ein gelisteter Origin wird wie die eigene UI der App vertraut.** Am offenen HTTP-Port kann jede von ihm ausgelieferte Seite alles lesen und ändern, einschließlich Löschen oder Wiederherstellen der Datenbank. Liste nur Origins, die du kontrollierst. Um zusätzlich einen Schlüssel zu verlangen, lass die Seite die `https://`-Adresse des sicheren Gateways aufrufen (oder setze ohne Gateway `FILAMENTDB_API_KEY`) und `Authorization: Bearer <key>` senden.

`*` und reine Hostnamen (`dash.example.com`) werden mit einer Warnung im Server-Log ignoriert. Ein Wildcard würde die nicht authentifizierte API für jede besuchte Webseite öffnen. Der Etikettendruck (`POST /api/labels/print`) bleibt für Cross-Origin-Seiten gesperrt: sein Druck-Token-Header steht nicht auf der erlaubten Liste. `ALLOWED_DEV_ORIGINS` hat damit nichts zu tun: es lässt nur einen anderen Hostnamen den Next.js-Dev-Server laden.

### Aus Quellen bauen

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
docker build -t filament-db .
docker run -p 127.0.0.1:3456:3000 -e MONGODB_URI="mongodb+srv://..." filament-db
```

---

## Option 3: Aus Quellen ausführen

### Voraussetzungen

- **Node.js** v22.13 oder neuer innerhalb von Version 22, oder v24 oder neuer. Node 20 wird nicht mehr unterstützt, und Node 23 wird von den Test- und Lint-Werkzeugen nicht unterstützt.
- **npm** (bei Node.js enthalten)
- **Git**
- Eine **MongoDB**-Datenbank (Atlas Free Tier oder lokale MongoDB)

### Node.js installieren

#### macOS

Mit Homebrew (empfohlen):

```bash
brew install node
```

Oder lade den Installer von https://nodejs.org/

#### Linux (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### Linux (Fedora/RHEL)

```bash
sudo dnf install nodejs
```

#### Windows

Lade den Installer von https://nodejs.org/ herunter und führe ihn aus (LTS-Version empfohlen).

Oder mit winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

Oder mit Chocolatey:

```powershell
choco install nodejs-lts
```

Nach der Installation auf jeder Plattform prüfen:

```bash
node --version
npm --version
```

### Klonen und installieren

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
```

### Umgebung konfigurieren (nur Web-App)

Wenn du als Web-App (nicht als Desktop) läufst, lege eine `.env.local` an:

#### macOS / Linux

```bash
cp .env.example .env.local
```

#### Windows (PowerShell)

```powershell
Copy-Item .env.example .env.local
```

Bearbeite `.env.local` dann mit deiner MongoDB-Verbindungszeichenfolge und optional einem AI-API-Key für die TDS-Extraktion:

```
MONGODB_URI=mongodb+srv://youruser:yourpassword@yourcluster.mongodb.net/filament-db?appName=Filaments

# Optional: AI-Provider für TDS-Extraktion (eine wählen)
GEMINI_API_KEY=your-gemini-key
# ANTHROPIC_API_KEY=your-claude-key
# OPENAI_API_KEY=your-openai-key
```

Der AI-API-Key aktiviert die Funktion „Aus TDS importieren", die mit AI Filamenteigenschaften aus Technical Data Sheets extrahiert. Du kannst das stattdessen auch in der Einstellungen-Seite konfigurieren.

Wenn du den Dev-Server von einem anderen Gerät im Netzwerk aufrufst (z. B. ein Raspberry Pi unter `myhost.local`), trage den Hostnamen für Cross-Origin-Dev-Anfragen ein:

```
ALLOWED_DEV_ORIGINS=myhost.local
```

Mehrere Hostnamen werden mit Komma getrennt (z. B. `myhost.local,other.local`).

> **Hinweis:** Wenn dein Passwort Sonderzeichen enthält (`@`, `#`, `%` usw.), musst du sie URL-codieren. Aus `p@ssword` wird zum Beispiel `p%40ssword`.

> **Hinweis:** Die Desktop-App verwendet **nicht** `.env.local` — sie fragt beim ersten Start nach der Verbindungszeichenfolge und speichert sie in einer lokal persistierten Konfigurationsdatei (siehe [Desktop-App](desktop.md) für die Speicherorte). Im Offline- und Hybrid-Modus startet die Desktop-App automatisch eine eingebettete lokale MongoDB-Instanz.

### Ausführen

#### Web-App

```bash
npm run dev                   # Entwicklung unter http://localhost:3456
npm run build && npm start    # Produktion unter http://localhost:3000 (setze PORT=3456 für gleichen Port wie dev)
```

`npm start` führt zuerst `start:prep` aus (kopiert `.next/static` und `public/` in die Standalone-Ausgabe) und startet dann den Standalone-Server-Eintrittspunkt (`node .next/standalone/server.js`) — `next start` ist nicht mit dem `output: "standalone"`-Build-Modus kompatibel, den das Projekt für Docker- und Electron-Paketierung verwendet.

#### Desktop-App (aus Quellen)

```bash
npm run electron:dev          # Entwicklungsmodus
npm run electron:build        # Installer für deine Plattform bauen
```

> **Port:** `npm run dev` und die Desktop-App laufen auf Port **3456**. Docker bindet intern auf Port 3000 und wird per `-p 3456:3000` auf 3456 auf dem Host gemappt. `npm start` (Produktion) verwendet standardmäßig Port **3000**, sofern `PORT=3456` nicht gesetzt ist. Die Desktop-App respektiert ebenfalls die `PORT`-Umgebungsvariable. [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) erwartet standardmäßig `http://localhost:3456`.

---

## Als Linux-Dienst betreiben

Du kannst Filament DB als systemd-Dienst betreiben, sodass er automatisch beim Boot startet. Das ist nützlich für Headless-Server oder einen Raspberry Pi, der als dedizierte Filamentdatenbank in deinem Netzwerk dient.

Diese Anleitung geht davon aus, dass du das `.deb`-Paket von [GitHub Releases](https://github.com/hyiger/filament-db/releases) installiert hast. Wenn du aus Quellen läufst, passe die Pfade entsprechend an (`WorkingDirectory` auf das `.next/standalone/` deines Repos und `ExecStart` auf `node server.js`).

### 1. Umgebung konfigurieren

Lege `/opt/Filament DB/.env` mit deiner MongoDB-Verbindungszeichenfolge an oder bearbeite sie:

```bash
sudo tee "/opt/Filament DB/.env" > /dev/null <<'EOF'
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db?appName=Filaments
PORT=3456
HOSTNAME=0.0.0.0
EOF
sudo chmod 600 "/opt/Filament DB/.env"
```

`HOSTNAME=0.0.0.0` sorgt dafür, dass der Server auf allen Netzwerkschnittstellen lauscht, sodass andere Geräte im Netz ihn erreichen können.

> **Sicherheit:** Das Binden an `0.0.0.0` gibt den **nicht authentifizierten** HTTP-Port für alle im Netz frei. Um den Dienst von anderen Geräten aus zu erreichen, setze hier `HOSTNAME=127.0.0.1` und füge stattdessen das sichere Gateway hinzu (`FILAMENTDB_HTTPS_PORT` sowie ein absolutes `FILAMENTDB_SECURE_DIR`, in das der Dienstbenutzer schreiben darf): siehe [Eine netzwerkexponierte Instanz absichern](#eine-netzwerkexponierte-instanz-absichern). Derselbe Abschnitt behandelt auch den Betrieb hinter einem eigenen Reverse-Proxy.

> **Hinweis:** Wenn du statt eines headless Dienstes die Desktop-App verwendest, musst du nichts davon von Hand setzen: Aktiviere in den Einstellungen den Schalter **„Im lokalen Netzwerk freigeben“** (electron-store-Schlüssel `exposeToLan`, standardmäßig aus), und die App startet das sichere Gateway für dich, mit einem erzeugten API-Schlüssel. Zusammen mit der mDNS-Erkennung findet die mobile Begleit-App deine Instanz im Netzwerk, ohne dass du eine URL eintippen musst.

### 2. Dienst anlegen

```bash
sudo tee /etc/systemd/system/filament-db.service > /dev/null <<'EOF'
[Unit]
Description=Filament DB
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/opt/Filament DB/resources/app/standalone
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/Filament DB/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Ersetze `your-username` durch deinen Linux-Benutzernamen.

### 3. Aktivieren und starten

```bash
sudo systemctl daemon-reload
sudo systemctl enable filament-db
sudo systemctl start filament-db
```

Die Web-App ist nun unter `http://<hostname>:3456` erreichbar und startet automatisch beim Boot.

### Nützliche Befehle

```bash
sudo systemctl status filament-db      # Dienststatus prüfen
sudo systemctl restart filament-db      # Nach Upgrade neu starten
sudo systemctl stop filament-db         # Dienst stoppen
journalctl -u filament-db -f            # Logs verfolgen
```

### NFC neben dem Dienst nutzen

Die Desktop-App enthält NFC-Tag-Lese/Schreibe-Unterstützung (OpenPrintTag, Bambu und OpenTag3D), die direkten USB-Zugriff auf einen NFC-Reader erfordert. Da sowohl der Web-Dienst als auch die Desktop-App einen Next.js-Server starten, betreibe die Desktop-App auf einem anderen Port, damit der Web-Dienst weiterhin für PrusaSlicer und andere Netzwerkclients verfügbar bleibt:

```bash
PORT=3457 "/opt/Filament DB/filament-db"
```

Oder lege ein praktisches Skript an:

```bash
cat > ~/nfc.sh <<'SCRIPT'
#!/bin/bash
echo "Starte Filament DB Desktop für NFC (Port 3457)..."
echo "Web-Dienst läuft weiter auf Port 3456."
PORT=3457 "/opt/Filament DB/filament-db"
SCRIPT
chmod +x ~/nfc.sh
```

Führe dann `~/nfc.sh` aus, wann immer du NFC brauchst. Der Web-Dienst bleibt auf Port 3456 ununterbrochen erreichbar.

### Upgrade

Nach Installation einer neuen `.deb`-Version starte den Dienst neu, damit er die Änderungen übernimmt:

```bash
sudo dpkg -i FilamentDB-x.x.x-linux-arm64.deb
sudo systemctl restart filament-db
```

---

## Verbindungsmodi (Desktop-App)

Die Desktop-App unterstützt drei Verbindungsmodi:

### Atlas (Cloud)

- Alle Daten werden in MongoDB Atlas gespeichert
- Erfordert dauerhafte Internetverbindung
- Ist Atlas beim Start nicht erreichbar, weicht die App automatisch auf eine lokale Datenbank aus und synchronisiert, sobald die Verbindung wiederhergestellt ist

### Hybrid (Lokal + Cloud-Sync)

- Daten lokal in einer eingebetteten MongoDB-Instanz gespeichert
- Automatische bidirektionale Synchronisation mit Atlas, sobald verbunden
- Funktioniert vollständig offline — synchronisiert automatisch, sobald wieder Internet verfügbar ist
- Sync verwendet Last-Write-Wins-Konfliktauflösung anhand von Zeitstempeln
- Manueller **Jetzt synchronisieren**-Button in der Statusanzeige verfügbar
- Sync läuft alle 5 Minuten, wenn Atlas erreichbar ist
- **Was synchronisiert wird**: nozzles, printers, locations, bedtypes, filaments (mit eingebetteten Spulen), printhistories, sharedcatalogs — alle mit Cross-DB-Ref-Remap, damit Kalibrierungen, AMS-Slots und Spulen-/Filamentreferenzen auf beiden Seiten konsistent bleiben. Soft-Deletes (`_deletedAt`) propagieren so, dass ein Löschen auf einem Peer nicht vom anderen wiederauferstanden wird.
- **Spool-Subdokument-Einschränkung**: Spulen-IDs innerhalb von Filament haben keine stabilen Cross-Side-Identifier, daher werden `printer.amsSlots[].spoolId` und `printhistory.usage[].spoolId` beim Cross-Side-Remap geleert. Pro-Filament-Gramm-Summen stimmen weiterhin; die Zuordnung *welche Spule* geladen/verbraucht wurde, geht verloren.

### Nur lokal (Offline)

- Alle Daten lokal gespeichert, keine Cloud-Verbindung
- Kein MongoDB-Atlas-Konto nötig
- Kann später unter **Einstellungen → Netzwerkeinstellungen → Verbindungsmodus** in den Hybrid- oder Atlas-Modus umgestellt werden, ohne Zurücksetzen (siehe [Fehlerbehebung](troubleshooting.md#desktop-app-verbindungsmodus-wechseln))

---

## MongoDB Atlas einrichten (kostenlose Stufe)

1. Gehe zu https://www.mongodb.com/cloud/atlas/register und erstelle ein kostenloses Konto.

2. **Cluster erstellen:**
   - Klicke auf **„Build a Database"**
   - Wähle die **M0 Free**-Stufe
   - Wähle einen Cloud-Provider und eine Region in deiner Nähe
   - Benenne deinen Cluster (z. B. `Filaments`)
   - Klicke auf **„Create Deployment"**

3. **Datenbankbenutzer anlegen:**
   - Trage im Wizard einen Benutzernamen und ein Passwort ein
   - **Eingebaute Rolle**: wähle `Read and write to any database` (oder grenze auf deine spezifische Datenbank ein). Die App benötigt `readWrite` auf der Zieldatenbank — bei einem Read-Only-Benutzer zeigt die Desktop-App einen klaren Sync-Fehler, der dich zurück zu Einstellungen → Verbindung führt (anstatt den rohen Treibertext `user is not allowed to do action [update]` durchzureichen).
   - Klicke auf **„Create Database User"**
   - Speichere diese Zugangsdaten — du brauchst sie für die Verbindungszeichenfolge

4. **Netzwerkzugriff konfigurieren:**
   - Klicke im Wizard (oder unter **Security > Network Access**) auf **„Add IP Address"**
   - Für die Entwicklung: **„Allow Access from Anywhere"** (fügt `0.0.0.0/0` hinzu)
   - Für die Produktion: trage nur die IP-Adresse deines Servers ein
   - Klicke auf **„Confirm"**

5. **Verbindungszeichenfolge holen:**
   - Klicke auf **„Connect"** in deinem Cluster
   - Wähle **„Drivers"**
   - Kopiere die Verbindungszeichenfolge. Sie sieht so aus:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?appName=<appName>
     ```
   - Ersetze `<username>` und `<password>` durch die Zugangsdaten aus Schritt 3
   - Füge vor dem `?` `/filament-db` ein, um den Datenbanknamen anzugeben:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/filament-db?appName=Filaments
     ```
