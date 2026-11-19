# BatteryLab · Odoo Stock Count

Reconcile an Odoo **stock.quant** export against a physical count done with a QR / barcode scanner.
Runs entirely in the browser: no server, no database, no install.

## Run it

| Option | How | Camera scanning |
|---|---|---|
| **Double-click** `start.command` (macOS) or `start.bat` (Windows) | Opens http://localhost:8080 | ✅ |
| Open `index.html` directly | Works with a USB/Bluetooth scanner gun | ❌ (browsers block the camera on `file://`) |

Sign in as the inventory admin (`odooadmin`).

## Workflow

1. **Upload**: In Odoo go to *Inventory → Physical Inventory*, export to Excel with the
   `Location`, `Product` and `Lot/Serial Number` columns, and drop the file in.
   Untick any location you are not counting today.
2. **Scan**: Scan every label. A scanner gun works like a keyboard (it types the code and presses Enter).
   Each scan shows one of these results straight away, with a sound:
   - **Matched**: serial is on the report (green)
   - **Already scanned**: duplicate, not counted twice (amber)
   - **Other location**: on the report, but in a location you unticked (blue)
   - **Not in stock report**: an exception (red)

   Scans can be removed one by one or with *Undo last scan*. You can paste many serials at once (one per line).
3. **Report**: Found / Missing for every item, a summary by product, and the exceptions.
   **Export Excel** creates a workbook with these sheets: Summary, Full Report (✔ FOUND / ✘ MISSING), Missing, Found,
   By Product, Exceptions and the complete Scan Log. **Print / PDF** gives a clean printable version.

## Data & storage

- The Odoo file is read in the browser and never uploaded anywhere.
- The count in progress (report + every scan) is saved in the browser's local storage, so a refresh,
  a closed tab or signing out does **not** lose scans. *New count* clears it.
- Data lives only on the computer and browser used for the count. Export the Excel report to keep a record.

## Matching rules

- Case and spaces are ignored (`bl-pr-ecu-004 ` matches `BL-PR-ECU-004`).
- If a QR code holds more than the serial (a URL, `serial|name`, `key=value` …), the app finds the serial inside it.
- Duplicate serials in the uploaded file are merged; rows with no serial are skipped (you'll see a warning).

## Security note

The login is a front-door check for a local tool. The credentials are stored as a SHA-256 hash, but because the
app runs entirely in the browser, it is not a substitute for server-side authentication. Don't host it on
the public internet.

## Files

```
index.html          app shell
css/styles.css      styling (brand colours from the BatteryLab logo)
js/app.js           all logic: login, parsing, matching, report, export
assets/             logo (dark + white variants)
vendor/             SheetJS 0.18.5 (Excel read/write), html5-qrcode 2.3.8 (camera), bundled for offline use
start.command/.bat  local launcher (needed for camera scanning)
```
