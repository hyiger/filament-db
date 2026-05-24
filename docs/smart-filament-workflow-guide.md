# The Smart Filament Workflow

A complete, step-by-step setup guide for managing your 3D printing filament with NFC
smart tags — from an empty database to a calibrated, tap-to-load print workflow, using
**OpenPrintTag**, **Filament DB**, and **PrusaSlicer Filament Edition**.

> A print-ready **[PDF version of this guide](smart-filament-workflow-guide.pdf)** is also
> in this folder. Every screenshot below is a real capture from MongoDB Atlas, GitHub, the
> ACS site, and a working install of Filament DB v1.25.1 and PrusaSlicer 2.9.5 Filament
> Edition. Version numbers and exact labels will drift as these fast-moving projects
> update — trust the current app when something differs.

## Contents

1. [Overview — how the three pieces fit together](#1-overview--how-the-three-pieces-fit-together)
2. [What you'll need](#2-what-youll-need)
3. [Setup — database, apps, and reader](#3-setup--database-apps-and-reader)
4. [Populate your filament library](#4-populate-your-filament-library)
5. [Calibrate your filaments](#5-calibrate-your-filaments)
6. [The everyday workflow](#6-the-everyday-workflow)
7. [Troubleshooting](#7-troubleshooting)
8. [Quick reference](#8-quick-reference)

---

## 1. Overview — how the three pieces fit together

This guide connects three open-source tools into one tidy loop: your filament spools carry
their own data on a cheap NFC sticker, that data lives in a searchable database, and your
slicer pulls the right calibrated settings automatically every time you print.

**OpenPrintTag** — an open NFC standard created by Prusa Research. A small, rewritable NFC
sticker on a spool stores the filament's type, color, temperatures, remaining length and
print parameters, with no cloud lookup required. Any compatible app or printer can read it.

**Filament DB** — a free desktop (and web) app, by community developer *hyiger*, that
manages your whole filament collection: profiles, temperatures, densities, costs,
per-nozzle calibrations and individual spool tracking. Data is stored in MongoDB (the free
cloud tier or fully local), and the app can read and write OpenPrintTag NFC tags using a
USB reader.

**PrusaSlicer Filament Edition** — a community fork of PrusaSlicer 2.9.5 (also by *hyiger*).
It adds a **Calibration** menu with eight built-in test generators, and a built-in
connection to Filament DB so your calibrated filament presets load automatically when the
slicer starts.

### The closed loop

Put together, the tools form a continuous cycle. You only ever calibrate a filament once;
after that, the correct settings follow you across spools, nozzles, printers and computers.

**Calibrate** → **Store** → **Sync** → **Print** → *(new spool, new nozzle, or another
computer — the loop repeats)*

1. **Calibrate** — run the slicer's calibration tests.
2. **Store** — save the results in Filament DB.
3. **Sync** — presets flow into PrusaSlicer on startup.
4. **Print** — the calibrated settings are applied automatically.

OpenPrintTag NFC tags carry the filament data on and off each physical spool.

> **Note —** Filament DB and the PrusaSlicer fork are actively developed community
> projects (only OpenPrintTag itself is the Prusa-backed open standard). Always download
> the latest version of both — they are designed to be updated together.

---

## 2. What you'll need

The hardware items are one-time purchases; the software and the cloud database are free.

**Hardware**

- A computer running macOS (Intel or Apple Silicon), Windows, or Linux (x64 or arm64).
- An **ACS ACR1552U USB NFC reader/writer** — the external reader Filament DB officially
  supports for reading *and* writing OpenPrintTag tags.
- **Blank NFC tags** — Prusa's "Blank OpenPrintTag" stickers, or generic NXP ICODE SLIX2
  tags (ISO 15693 / NFC-V, 320 bytes).
- A 3D printer and some filament to calibrate and tag.

**Software & accounts (all free)**

- A **MongoDB Atlas** account — the free tier, no credit card required.
- The **ACS PC/SC driver** for the ACR1552U reader.
- **Filament DB** — the desktop app (latest release).
- **PrusaSlicer Filament Edition** — the calibration fork (latest release).
- *(Optional)* Your existing PrusaSlicer config bundle, to import current filament profiles.

> **Tip —** Plan about 45–60 minutes for the full setup in Section 3, most of which is
> waiting on downloads. Calibrating each filament (Section 5) is separate.

---

## 3. Setup — database, apps, and reader

Work through the four parts in order. Part A creates the cloud database that everything
else connects to, so do it first.

### Part A · Create the cloud database (MongoDB Atlas)

Filament DB stores its data in MongoDB. The free Atlas tier hosts that database in the
cloud, so your filament library is reachable from any computer and can be shared. (If you
would rather keep everything offline, see the note at the end of this part.)

**Step 1 — Create an Atlas account.** Go to [mongodb.com/atlas](https://www.mongodb.com/atlas)
and sign up with a Google account or an email address. No payment details are needed.

![The MongoDB Atlas sign-up page](images/sfw-atlas-signup.png)

**Step 2 — Create a free cluster.** After signing in, Atlas prompts you to deploy a
database. Choose the **Free** tier (512 MB, shared), pick the cloud provider and region
closest to you, then click **Create Deployment**. Provisioning takes about a minute.

![Creating the cluster — the Free tier selected](images/sfw-atlas-cluster.png)

**Step 3 — Create a database user.** Atlas's Connect dialog walks you through securing the
cluster: it adds your current IP to the access list and creates the first database user.
Note the username and **copy the password** — you'll need it for the connection string.
Avoid the characters `@ : / ?` in the password; they have special meaning inside a
connection string.

![Atlas Connect — set up connection security and create a database user](images/sfw-atlas-security-setup.png)

**Step 4 — Allow network access.** Atlas blocks all connections by default. Under
**Network Access → IP Access List**, confirm an entry exists for your machine (the Connect
flow adds one automatically), or click **Add IP Address → Allow Access from Anywhere**
(`0.0.0.0/0`) if you print from changing networks. Access is still protected by the
username and password.

![The Atlas IP Access List](images/sfw-atlas-network-access.png)

**Step 5 — Copy your connection string.** Go to **Database → Connect → Drivers** and copy
the connection string. It looks like:

```
mongodb+srv://filament_db_user:<db_password>@cluster0.xxxxx.mongodb.net/?appName=Cluster0
```

Replace `<db_password>` with the password from Step 3 and keep this string safe — you'll
paste it into Filament DB in Step 8.

![The Connect → Drivers panel with the connection string](images/sfw-atlas-connection-string.png)

> **Tip —** This connection string is the key to sharing. Anyone you give it to sees the
> same filament library, so it works for a partner or a print farm.

> **Note — Prefer to stay offline?** The Filament DB desktop app can run fully local, or
> in a hybrid mode that syncs when online. If you choose local-only, skip Part A.

### Part B · Install Filament DB

**Step 6 — Download Filament DB.** Open the releases page at
[github.com/hyiger/filament-db/releases](https://github.com/hyiger/filament-db/releases)
and download the newest release for your OS — the `.dmg` for macOS (separate Intel and
Apple Silicon builds), the `.exe` for Windows, or the `.AppImage` / `.deb` for Linux.

![The GitHub Releases page for Filament DB](images/sfw-github-filament-db.png)

**Step 7 — Install and open the app.** Run the installer. Because these are community
builds, your OS may warn that the app is from an unidentified developer — on macOS,
right-click the app and choose **Open** the first time; on Windows, choose **More info →
Run anyway**.

![The Filament DB desktop app — the filament library](images/sfw-filamentdb-library.png)

**Step 8 — Connect Filament DB to your database.** Open **Settings** in Filament DB and
scroll to **Connection Mode**. Choose **Atlas (Cloud)** and paste in the connection string
from Step 5 (with the real password filled in). The three modes are Atlas (Cloud), Hybrid
(Local + Cloud), and Offline (Local Only).

![Filament DB Settings → Connection Mode](images/sfw-filamentdb-connection-mode.png)

> **Tip — Quick test:** On the main screen choose **Import / Export → Import from Atlas**
> and paste the developer's public read-only sample database string (from the project's
> forum post) to explore a populated library before adding your own.

> **Note — Docker alternative:** You can run Filament DB as a container instead:
> `docker run -p 3456:3000 -e MONGODB_URI="mongodb+srv://..." ghcr.io/hyiger/filament-db`.
> Maps host port `3456` (matching the desktop app) to container port `3000`, so PrusaSlicer's `http://localhost:3456` works for both.
> The Docker/web version cannot use the USB NFC reader — tag reading and writing needs the
> **desktop** app.

### Part C · Set up the external NFC reader

**Step 9 — Install the ACS PC/SC driver.** Go to the ACS product page for the ACR1552U
([acs.com.hk](https://www.acs.com.hk)) and download the **PC/SC Driver Installer** for your
OS. On Linux, install `pcscd` and `libccid` and ensure the `pcscd` service is running.

![The ACS Drivers & Utilities page for the ACR1552U](images/sfw-acs-driver-page.png)

**Step 10 — Connect the reader and verify it.** Plug the ACR1552U into a USB port. In
Filament DB, the header status pill changes from "No NFC reader" to **"Ready — place
tag"** once the reader is detected.

![Filament DB header showing the reader ready](images/sfw-filamentdb-reader-ready.png)

### Part D · Install PrusaSlicer Filament Edition

**Step 11 — Download the PrusaSlicer fork.** Open
[github.com/hyiger/PrusaSlicer/releases](https://github.com/hyiger/PrusaSlicer/releases)
and download the latest release for your OS. It is a complete fork of PrusaSlicer 2.9.5 and
installs alongside any standard PrusaSlicer you already have.

![The GitHub Releases page for the PrusaSlicer Filament Edition fork](images/sfw-github-prusaslicer-fork.png)

**Step 12 — Install and run first-time setup.** Install it like any application and run the
Configuration Assistant, adding your printer(s) and nozzle(s). The only additions over
standard PrusaSlicer are the **Calibration** menu and the Filament DB connection.

![PrusaSlicer Filament Edition with the Calibration menu open](images/sfw-prusaslicer-calibration-menu.png)

**Step 13 — Point PrusaSlicer at Filament DB.** Open **Preferences** (macOS: *PrusaSlicer →
Preferences*; Windows: *File → Preferences*), go to the **Other** tab, and enter the
address Filament DB is serving on in the **Filament DB URL** field. For the current desktop
app that is `http://localhost:3456`; older builds and the Docker container use port `3000`.
Save and restart PrusaSlicer.

![PrusaSlicer Preferences → Other, with the Filament DB URL field](images/sfw-prusaslicer-preferences.png)

> **Warning —** Make sure the URL goes into the field labelled exactly **Filament DB URL**.
> Putting it in another field is the most common setup mistake — it looks like the address
> "won't be accepted."

---

## 4. Populate your filament library

**Step 14 — Export a config bundle from PrusaSlicer.** In PrusaSlicer choose **File →
Export → Export Config Bundle** and save the `.ini` file. It contains every filament
profile with its full settings.

![PrusaSlicer File → Export menu](images/sfw-prusaslicer-export-menu.png)

**Step 15 — Import the bundle into Filament DB.** In Filament DB open **Import / Export**
and choose the PrusaSlicer INI import. Every profile is brought in with its temperatures,
retraction, pressure advance, fan settings and other parameters intact. The same menu can
also import from a Prusament QR code, the Atlas filament database, a CSV of spools, or
browse the OpenPrintTag DB.

![The Filament DB Import / Export menu](images/sfw-filamentdb-library.png)

**Step 16 — Read an OpenPrintTag spool.** Place a tagged spool's tag on the ACR1552U.
Filament DB reads it and shows a **"Found in Database"** dialog with every property stored
on the tag — material, brand, color, temperatures, weights and the Instance ID.

![Filament DB's Found in Database dialog after reading a tag](images/sfw-filamentdb-tag-read.png)

---

## 5. Calibrate your filaments

Calibration is what makes this system worth the trouble: dial a filament in once, store the
numbers, and never re-tune it again.

**Step 17 — Run a calibration test.** In PrusaSlicer Filament Edition open the
**Calibration** menu. It offers eight test generators, in the recommended order to run them:

| Test | What it finds |
|------|---------------|
| 1. Temperature | Optimal printing temperature (overhangs, holes, bridges) |
| 2. Flow Rate | Extrusion multiplier via spiral top layers |
| 3. Pressure Advance | Best PA value, via a per-layer chevron pattern |
| 4. Retraction | Retraction distance, via a dual-tower test |
| 5. Max Flow Rate | Your hotend's volumetric flow limit |
| 6. Extrusion Multiplier | Fine-tuning EM with a simple cube |
| 7. Fan Speed | Cooling, via a tower at varying fan percentages |
| 8. Dimensional Accuracy | Shrinkage, via an XYZ cross gauge measured with calipers |

Each test builds the model, places it on the plate, configures the print settings and
injects the per-layer G-code automatically. You just slice, print, and read the result.

![The Calibration menu's test generators](images/sfw-prusaslicer-calibration-menu.png)

**Step 18 — Record the results in Filament DB.** Open the filament you tested in Filament
DB's editor and enter your measured values — temperatures, retraction, fan, and other
dialled-in parameters. The side panel has sections for Compatible Nozzles and Presets, so
the same filament can hold different values for each printer, nozzle and bed combination.

![The Filament DB filament editor](images/sfw-filamentdb-filament-editor.png)

> **Tip —** Define your printers, nozzles and bed types on the Filament DB **Settings**
> page first, so every calibration links to the exact setup it was measured on.

---

## 6. The everyday workflow

With setup, library and calibration done, daily use is the easy part — this is the payoff.

**Step 19 — Sync.** Make sure Filament DB is running, then start PrusaSlicer Filament
Edition. It contacts the Filament DB URL from Step 13 and loads your filament presets —
with the calibrated values already applied. A brief notification confirms the sync.

![The PrusaSlicer filament dropdown with synced presets](images/sfw-prusaslicer-filament-dropdown.png)

**Step 20 — Print.** Choose your filament from the PrusaSlicer dropdown as usual. Because
the preset came from Filament DB, the calibrated profile is already in place. Switch the
nozzle or printer and the matching calibration values follow automatically — no INI
editing, no hunting through notes.

![A filament's detail page in Filament DB](images/sfw-filamentdb-filament-detail.png)

**Step 21 — Write an NFC tag for a spool.** To make a physical spool "smart", open that
filament's detail page in Filament DB, place a blank NFC-V tag on the ACR1552U, and use
**Export OPT** (OpenPrintTag) to encode the filament's properties to the tag. Peel the tag
and stick it on the spool — from then on any OpenPrintTag-compatible app or printer can
read it instantly. The Spool Tracker on the same page records weight and remaining
percentage; re-weigh a spool any time to keep it current.

**Step 22 — Use the tag and close the loop.** The tag travels with the spool. Tap it on the
reader (or a compatible printer) and the filament is identified instantly. When a spool
runs out, the tag is rewritable — update its data and move it to a refill. That completes
the loop: calibrate once, store it, sync it, print — and let the tag carry the data on and
off every physical spool.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| PrusaSlicer "won't accept" the Filament DB address | The URL must go in the field named exactly **Filament DB URL** under Preferences → Other. If that field isn't present, update the fork. |
| PrusaSlicer connects to nothing / no presets sync | Filament DB must be running when PrusaSlicer starts. Open the desktop app (or start the container) first. Confirm it is reachable at `http://localhost:3456` in a browser (same URL for desktop and the recommended Docker port mapping below). |
| Docker container runs but PrusaSlicer can't reach it | The container must publish the port: include `-p 3456:3000` in the `docker run` command so the host's port 3456 (the desktop default that PrusaSlicer expects) maps to the container's port 3000. |
| Filament DB can't connect to MongoDB Atlas | Check that Network Access allows your IP (or `0.0.0.0/0`), that the password has no unescaped `@ : / ?` characters, and that `<db_password>` was actually replaced with the real password. |
| The ACR1552U reader is not detected | Install the ACS PC/SC driver and reconnect the reader. NFC works only in the **desktop** app, not the web/Docker version. |
| A tag won't write | Use NFC-V / ISO 15693 tags (NXP ICODE SLIX2, 320 bytes) or a genuine blank OpenPrintTag. Centre the tag on the reader and keep it still. |
| A Bambu spool shows as "read-only" | Expected — Bambu tags are cryptographically signed, so they can be read but not rewritten. |
| Things behave oddly after an update | Filament DB and the PrusaSlicer fork evolve quickly and are meant to be updated together. Update both to matching recent releases. |

---

## 8. Quick reference

**The workflow at a glance**

| Stage | Tool | What happens |
|-------|------|--------------|
| Calibrate | PrusaSlicer Filament Edition | Run a Calibration-menu test, print it, read the result |
| Store | Filament DB | Save the values per printer + nozzle + bed type |
| Sync | Filament DB → PrusaSlicer | Presets load on startup with calibrated values applied |
| Print | PrusaSlicer Filament Edition | Pick the filament; correct settings follow the nozzle/printer |
| Tag | Filament DB + ACR1552U | Write an OpenPrintTag NFC tag; stick it on the spool |

**Key settings**

| Setting | Value |
|---------|-------|
| Atlas cluster tier | Free (512 MB, shared) |
| Atlas network access | `0.0.0.0/0` (allow anywhere) or your IP |
| PrusaSlicer → Preferences → Other | Filament DB URL = `http://localhost:3456` (both desktop and Docker with the recommended port mapping) |
| Docker port mapping | `-p 3456:3000` |
| NFC tag type | NFC-V / ISO 15693 — NXP ICODE SLIX2 (320 bytes) |
| NFC reader | ACS ACR1552U (desktop app only) |

**Links**

| Resource | Address |
|----------|---------|
| OpenPrintTag — standard & info | [openprinttag.org](https://openprinttag.org) |
| Filament DB — releases | [github.com/hyiger/filament-db/releases](https://github.com/hyiger/filament-db/releases) |
| PrusaSlicer Filament Edition — releases | [github.com/hyiger/PrusaSlicer/releases](https://github.com/hyiger/PrusaSlicer/releases) |
| MongoDB Atlas | [mongodb.com/atlas](https://www.mongodb.com/atlas) |
| ACR1552U reader & driver | [acs.com.hk](https://www.acs.com.hk) — ACR1552U USB NFC Reader IV |

---

*Filament DB and PrusaSlicer Filament Edition are independent, community-developed projects;
OpenPrintTag is the Prusa-backed open standard. Menu names, button labels and version
numbers will change over time — when something doesn't match this guide, trust the current
app.*
