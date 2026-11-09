# Tank-App

Mobile Web-App zum Erfassen von Tankvorgängen (Diesel & AdBlue) für Maschinen und Autos.
Die Daten liegen als **CSV-Dateien in einem privaten GitHub-Repository**. Benutzer melden sich mit
**Benutzername und Passwort** an – einen eigenen GitHub-Token braucht niemand außer dem Admin.

Live: https://bennihager46-lab.github.io/tank-app/ · Ausprobieren ohne GitHub: `…/tank-app/?demo`

## Rollen

| | Nutzer | Admin |
|---|---|---|
| Tanken | nur unter eigenem Namen | für jede Person |
| Eigene Tankvorgänge bearbeiten/löschen | ✓ | alle |
| Maschinen | ansehen | anlegen, bearbeiten, löschen |
| Benutzer | – | anlegen, Passwort zurücksetzen, Rolle ändern, löschen |
| Statistik | ✓ | ✓ |

## Wie die Anmeldung funktioniert

GitHub Pages hat keinen Server. Deshalb liegt in `accounts.json` (in diesem öffentlichen Repo) pro Benutzer ein
**verschlüsselter** Zugang zum Daten-Repo:

- Das Passwort wird mit PBKDF2 (600.000 Runden) zu einem Schlüssel; damit wird ein zufälliger Benutzerschlüssel entschlüsselt.
- Mit dem Benutzerschlüssel wird der Team-Token entschlüsselt (AES-256-GCM). Admins bekommen zusätzlich den Admin-Token.
- Admins können über einen eigenen Admin-Schlüssel Passwörter zurücksetzen und Tokens für alle erneuern, ohne die Passwörter zu kennen.

**Grenzen:** Wer angemeldet ist, hat technisch den Team-Token im Browser. „Nur unter eigenem Namen tanken“ setzt die
App durch – ein technisch versierter Nutzer könnte die CSV trotzdem direkt ändern (GitHub protokolliert jede Änderung).
Passwörter sollten mindestens 10 Zeichen haben (die App erzwingt das), da `accounts.json` öffentlich lesbar ist.

## CSV-Dateien (im Daten-Repo, Ordner `data/`)

- `tankvorgaenge.csv` – `id;zeitstempel;maschine_id;maschine;person_id;person;diesel_liter;adblue_liter;notiz`
- `maschinen.csv` – `id;name;typ;kennzeichen;notiz;erstellt`
- `nutzer.csv` – `id;name;erstellt`

Trennzeichen `;`, Dezimalkomma, UTF-8 mit BOM → öffnet sich direkt in deutschem Excel. Dateien werden bei jeder
Änderung überschrieben; GitHub hebt jede Version in der Historie auf. Gleichzeitige Änderungen werden automatisch zusammengeführt.

## Einrichtung (einmalig, durch den Admin)

1. Zwei **Fine-grained Tokens** erstellen (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens):
   - **Team-Token:** Repository access → *Only select repositories* → **nur `tank-daten`**, Permissions → **Contents: Read and write**.
   - **Admin-Token:** *Only select repositories* → **nur `tank-app`**, Permissions → **Contents: Read and write**.
2. https://bennihager46-lab.github.io/tank-app/ öffnen → **Ersteinrichtung**: Name, Benutzername, Passwort und beide Tokens eintragen.
   Die App prüft, dass der Team-Token *nicht* ins App-Repo schreiben kann.
3. Unter **Maschinen** Fahrzeuge anlegen, unter **Benutzer** die Personen mit Passwort anlegen und die Zugangsdaten weitergeben.

**Benutzer gelöscht oder Token abgelaufen?** Neuen Team-Token erstellen, unter **Konto → Team-Zugang** eintragen
(wird automatisch für alle Benutzer übernommen) und den alten Token auf GitHub löschen.

## Lokal testen

```bash
python3 -m http.server 8765 -d Tank_WebApp
```

Dann `http://localhost:8765/?demo` öffnen (Demo-Modus, alles bleibt im Browser).
