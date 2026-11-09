# Tank-App

Mobile Web-App zum Erfassen von Tankvorgängen (Diesel & AdBlue) für Maschinen und Autos.
Die Daten liegen als **CSV-Dateien in einem GitHub-Repository** – jeder mit Zugriff kann sie lesen und bearbeiten.

## Funktionen

| Reiter | Inhalt |
|---|---|
| **Tanken** | Maschine, Diesel (L), AdBlue (L), tankende Person, optionale Notiz. Zeitstempel wird automatisch gesetzt. Liste der letzten Tankvorgänge (bearbeiten/löschen). |
| **Maschinen** | Maschinen & Autos anlegen, bearbeiten, löschen (Typ, Kennzeichen, Notiz). |
| **Nutzer** | Personen anlegen, umbenennen, löschen. |
| **Statistik** | Zeitraum-Filter, Summen, Verbrauch nach Person, nach Maschine, pro Monat, Tabelle. |
| **Einstellungen** | Speicherort (lokal oder GitHub), Export als CSV oder Excel (.xlsx mit Reitern). |

## CSV-Dateien

Im eingestellten Ordner (Standard `data/`) werden drei Dateien angelegt und bei jeder Änderung **automatisch überschrieben**
(GitHub speichert ohnehin jede Version in der Historie – manuelle Backups sind nicht nötig):

- `tankvorgaenge.csv` – `id;zeitstempel;maschine_id;maschine;person_id;person;diesel_liter;adblue_liter;notiz`
- `maschinen.csv` – `id;name;typ;kennzeichen;notiz;erstellt`
- `nutzer.csv` – `id;name;erstellt`

Trennzeichen ist `;` mit Dezimalkomma und UTF-8-BOM, damit die Dateien in deutschem Excel direkt richtig aufgehen.
Speichern zwei Personen gleichzeitig, lädt die App die neueste Version nach und wendet die Änderung erneut an – es geht nichts verloren.

## Einrichtung (einmalig)

1. **Repo für die App** anlegen (öffentlich, z. B. `tank-app`) und die Dateien `index.html`, `app.js`, `style.css` hochladen.
   Unter *Settings → Pages* „Deploy from a branch“ → `main` / `root` wählen. Die App läuft dann unter
   `https://<benutzer>.github.io/tank-app/`.
2. **Repo für die Daten** anlegen – am besten **privat** (z. B. `tank-daten`), damit die Verbrauchsdaten nicht öffentlich sind.
   Andere Personen unter *Settings → Collaborators* einladen.
3. Jede Person erstellt sich einen **Fine-grained Token**: GitHub → *Settings → Developer settings → Personal access tokens →
   Fine-grained tokens* → nur das Daten-Repo auswählen → Berechtigung **Contents: Read and write**.
4. In der App unter **Einstellungen** „GitHub-Repository“ wählen, Besitzer, Repo (`tank-daten`), Branch (`main`), Ordner (`data`)
   und Token eintragen → **Speichern & verbinden**. Die CSV-Dateien werden beim ersten Eintrag automatisch erstellt.

Tipp: Auf dem Handy die Seite über „Zum Home-Bildschirm“ hinzufügen – dann verhält sie sich wie eine App.

## Lokal testen

```bash
python3 -m http.server 8765 -d Tank_WebApp
```

Dann `http://localhost:8765` öffnen. Im Modus „Nur dieses Gerät“ werden die CSVs im Browser gespeichert.
