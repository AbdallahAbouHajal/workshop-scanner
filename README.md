# Workshop scanner

Door scanner for workshop passes. Staff open it from the link the organiser's Google Sheet shows (Workshop > Open scanner).
The page holds no attendee data: it sends each scan to the Google Apps Script web app named in that link.

- Camera reading: the phone's own BarcodeDetector where available, otherwise barcode-detector 3.2.3 (MIT) with
  zxing-wasm 3.1.6 (MIT), both served from `vendor/`.
- Scans made without a connection are kept on the phone with their time and sent when it returns.

## Two Sheets on one phone (build 9, 5 Nov 2026)

A staff link can name a second Sheet: `#api=<campus Sheet>&key=<its key>&api2=<graduates' Sheet>&key2=<its key>`. In the campus
Sheet, Workshop > Admin > Pair with the graduates' Sheet takes the graduates' Sheet's own scanner link once, and Open scanner then
gives the two-Sheet link. The phone loads the workshop's guest list from both Sheets, sends each scan to the Sheet whose list has
the code, and sends a code neither list has to the campus Sheet first; if that Sheet does not know it, the scan is passed on to the
graduates' Sheet. Walk-ins go to the campus Sheet. Each Sheet has its own queue on the phone, and the counts are both added up.
The rules are in route.js (tests: tests/scanner-route.test.js in the project folder).
