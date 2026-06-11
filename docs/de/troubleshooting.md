> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../troubleshooting.md) maßgeblich.

# Fehlerbehebung

[< Zurück zur README](../../README.md)

## „MongoServerError: bad auth" beim Ausführen des Seed-Skripts

Dein MongoDB-Atlas-Benutzername oder -Passwort ist falsch. Überprüfe die Zugangsdaten in `.env.local`. Wenn dein Passwort Sonderzeichen enthält (`@`, `#`, `%` usw.), kodiere sie als URL. Aus `p@ssword` wird zum Beispiel `p%40ssword`.

## „MongoNetworkError: connection timed out"

Deine IP-Adresse ist nicht in MongoDB Atlas freigegeben. Gehe in der Atlas-Konsole zu **Security > Network Access** und füge deine aktuelle IP-Adresse hinzu.

## Das Seed-Skript meldet „0 filament profiles parsed"

Die INI-Datei enthält möglicherweise keine benutzerdefinierten Filamentprofile, oder der Dateipfad ist falsch. Prüfe in einem Texteditor, ob die Datei `[filament:...]`-Abschnitte enthält.

## Port 3456 wird bereits verwendet

Ein anderer Prozess belegt Port 3456. Stoppe diesen Prozess oder verwende einen anderen Port:

```bash
npm run dev -- -p 3001
```

## Tests schlagen mit „MongoMemoryServer"-Fehler fehl

Beim ersten Ausführen muss möglicherweise die MongoDB-Binärdatei heruntergeladen werden. Stelle eine Internetverbindung sicher und versuche es erneut. In CI wird die Binärdatei nach dem ersten Lauf zwischengespeichert.

## Desktop-App: Offline-/Hybrid-Modus schlägt beim ersten Start ohne Internet fehl

Die eingebettete lokale Datenbank (`mongodb-memory-server-core`) lädt die `mongod`-Binärdatei beim ersten Gebrauch herunter. Dieser einmalige Download benötigt eine Internetverbindung. Nach dem ersten erfolgreichen Start ist die Binärdatei zwischengespeichert und für den Offline-Modus ist kein Internet mehr nötig. Wenn dein erster Start in einer komplett offline Umgebung erfolgen muss, starte die App einmal mit Internet, um den Cache zu füllen, und trenne danach die Verbindung.

## „MONGODB_URI environment variable is not set" beim Ausführen des Seed-Skripts

Das Seed-Skript benötigt eine gesetzte `MONGODB_URI`. Du hast zwei Möglichkeiten:

1. Lege eine `.env.local`-Datei an (siehe [Einrichtungsanleitung](setup.md))
2. Übergib die Variable inline:
   ```bash
   MONGODB_URI="mongodb+srv://..." npx tsx scripts/seed.ts
   ```

## Die Filament-Detailseite zeigt dauerhaft „Loading..." an

Prüfe die Browserkonsole auf Fehler. Häufige Ursachen:
- MongoDB-Atlas-Verbindung ist ausgefallen oder die Zugangsdaten sind falsch
- Der Netzwerkzugriff in MongoDB Atlas ist eingeschränkt

Wenn die Filament-ID in der URL nicht existiert, zeigt die Seite „Filament nicht gefunden" an, statt unbegrenzt zu laden.

## Im INI-Export fehlen einige Filamente

Jedes Filament wird unabhängig von seinen Kalibrierungen als einzelner `[filament:Name]`-Abschnitt exportiert. Kalibrierungswerte (EM, Pressure Advance, max. Volumetric Speed, Retraction) werden **nicht** in die INI eingebrannt — sie werden zur Druckzeit dynamisch über den Endpunkt `/api/filaments/{id}/calibration` angewandt (verwendet von PrusaSlicer Filament Edition). Wenn ein Filament im Export fehlt, prüfe, ob es einen Namen hat und nicht soft-gelöscht ist.

## „Blocked cross-origin request" im Dev-Modus

Wenn du den Dev-Server unter einem anderen Hostnamen als `localhost` aufrufst (z. B. `http://myhost.local:3456`), blockiert Next.js die Hot-Reload-WebSocket-Verbindung. Trage deinen Hostnamen in `ALLOWED_DEV_ORIGINS` in `.env.local` ein:

```
ALLOWED_DEV_ORIGINS=myhost.local
```

Mehrere Hostnamen werden mit Komma getrennt. Starte den Dev-Server nach Änderungen neu. Das betrifft nur die Entwicklung — Produktions-Builds sind nicht betroffen.

## Desktop-App: macOS-App hängt oder lässt sich nach der Installation nicht öffnen

macOS Gatekeeper blockiert die App, weil sie nicht mit einer Apple-Developer-ID notarisiert ist. Entferne das Quarantäne-Flag im Terminal:

```bash
xattr -cr "/Applications/Filament DB.app"
```

Das musst du nur einmal nach Installation oder Update tun.

## Desktop-App: Der Einrichtungs-Assistent erscheint immer wieder

Möglicherweise wird die MongoDB-Verbindungszeichenfolge nicht gespeichert. Prüfe, ob das Konfigurationsverzeichnis beschreibbar ist:
- **macOS**: `~/Library/Application Support/filament-db/`
- **Windows**: `%APPDATA%/filament-db/`
- **Linux**: `~/.config/filament-db/`

## Desktop-App: Leerer Bildschirm nach der Einrichtung

Der interne Next.js-Server wurde eventuell nicht gestartet. Versuche Folgendes:

1. Beende die App und öffne sie erneut
2. Prüfe, dass die MongoDB-Atlas-IP-Freigabeliste deine aktuelle IP enthält
3. Starte die App aus einem Terminal heraus, um die Fehlerausgabe zu sehen:
   - **macOS**: `"/Applications/Filament DB.app/Contents/MacOS/Filament DB"`
   - **Linux**: Starte die AppImage direkt aus dem Terminal
   - **Windows**: Starte aus der Eingabeaufforderung
4. Bei „Cannot find module"-Fehlern ist der Build möglicherweise unvollständig — lade die neueste Version herunter

## Desktop-App: „electron:dev" schlägt unter Windows fehl

Stelle sicher, dass `concurrently` und `wait-on` installiert sind. Führe `npm install` aus, um alle Entwicklungsabhängigkeiten zu installieren. Wenn `wait-on` hängt, starte `npm run dev` und `npx electron .` in getrennten Terminals.

## Desktop-App: Wie man die gespeicherte Verbindungszeichenfolge zurücksetzt

Lösche die Konfigurationsdatei an den oben genannten Pfaden, oder öffne die Entwicklerkonsole im Electron-Fenster (View > Toggle Developer Tools) und führe `window.electronAPI.resetConfig()` aus.

## Desktop-App: Statusanzeige zeigt „Offline" trotz Internetverbindung

Im **Atlas-Modus** pingt die Statusanzeige Atlas direkt alle 60 Sekunden, sie spiegelt also die tatsächliche Atlas-Erreichbarkeit wider. Im **Hybrid-Modus** verfolgt die Anzeige Synchronisationszyklen. In der **Web-App** fällt sie auf die Browser-API `navigator.onLine` zurück, die gelegentlich falsche negative Ergebnisse liefern kann (z. B. in Captive-Portal-Netzwerken). Klicke im Hybrid-Modus auf die Status-Pille und teste die Atlas-Verbindung manuell mit **Jetzt synchronisieren**.

## Desktop-App: Sync-Konflikte — falsche Version hat gewonnen

Die Synchronisation nutzt **Last-Write-Wins** basierend auf dem `updatedAt`-Zeitstempel. Wenn du dasselbe Filament auf zwei Geräten bearbeitet hast, gewinnt die zuletzt gespeicherte Version. Es gibt kein feldweises Merge — das gesamte Dokument wird ersetzt. Um Konflikte zu vermeiden, bearbeite ein Filament möglichst nur auf einem Gerät gleichzeitig.

## Desktop-App: „Offline — using local data" im Atlas-Modus

Atlas war beim Start nicht erreichbar, daher ist die App automatisch auf eine eingebettete lokale Datenbank ausgewichen. Deine Daten sind lokal sicher. Sobald Atlas wieder erreichbar ist, synchronisiert die App automatisch. Du kannst auch auf die Status-Pille klicken und mit **Jetzt synchronisieren** eine manuelle Synchronisation auslösen.

## Desktop-App: Verbindungsmodus wechseln

Öffne **Einstellungen → Verbindungsmodus**. Wähle den gewünschten Modus (Atlas / Hybrid / Offline), trage bei Bedarf die Verbindungszeichenfolge ein und klicke auf **Wechseln zu …** (oder **Verbinden & Wechseln**). Die App verbindet sich direkt neu — kein Assistent, kein Neustart.

Falls die App nicht weit genug startet, um die Einstellungen zu erreichen, nutze als Notlösung die Entwicklerkonsole: Führe `window.electronAPI.resetConfig()` aus (View > Toggle Developer Tools), um die gespeicherte Konfiguration zu löschen und zum Einrichtungs-Assistenten zurückzukehren.

## Sync-Fehler: „user is not allowed to do action [update]" / „lacks readWrite on …"

Der Atlas-Benutzer in deiner Verbindungszeichenfolge hat nur Leserechte auf die Zieldatenbank, daher wird der Sync-Push abgewiesen. Behebung in der Atlas-Konsole:

1. **Security > Database Access**
2. Bearbeite den Benutzer, der für die Verbindungszeichenfolge genutzt wird
3. Ändere die eingebaute Rolle auf `Read and write to any database` (oder vergib `readWrite@<dbname>` gezielt für die Zieldatenbank)
4. Klicke auf **Update User** und dann in der Desktop-App auf **Jetzt synchronisieren** in der Status-Pille

Alternativ: Erzeuge eine frische Verbindungszeichenfolge von einem Benutzer mit `readWrite` und füge sie über das Panel **Einstellungen → Verbindung** der Desktop-App neu ein.

## TDS-Extraktion schlägt mit „URL resolves to a private/internal address" oder „too many redirects" fehl

Der TDS-Extraktor wendet bei jedem Redirect-Sprung einen SSRF-Schutz an. TDS-URLs, die per 30x in private IP-Bereiche umleiten (RFC1918, Loopback, Link-Local, Cloud-Metadaten-IPs) oder mehr als 5 Redirects verketten, werden bewusst abgelehnt — nicht jeder Link-Shortener oder Vendor-CDN funktioniert. Workarounds:

- Verwende die direkte PDF-URL des Anbieters, nicht eine Tracker-/Shortener-URL.
- Wenn die ursprüngliche URL die Datei ohne Redirects ausliefert, greift dieser Schutz nie.
- Für lokale Tests: Speichere das PDF und nutze den **Datei-Upload**-Modus von `POST /api/tds` statt des URL-Modus (der URL-Schutz gilt nicht für hochgeladene Dateien).
