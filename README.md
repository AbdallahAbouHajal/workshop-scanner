# Workshop scanner

Door scanner for workshop passes. Staff open it from the link the organiser's Google Sheet shows (Workshop > Open scanner).
The page holds no attendee data: it sends each scan to the Google Apps Script web app named in that link.

- Camera reading: the phone's own BarcodeDetector where available, otherwise barcode-detector 3.2.3 (MIT) with
  zxing-wasm 3.1.6 (MIT), both served from `vendor/`.
- Scans made without a connection are kept on the phone with their time and sent when it returns.
