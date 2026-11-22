/**
 * Album z imprezy – router subdomen (Cloudflare Worker)
 *
 * Każda subdomena = osobna impreza:
 *   https://30paulina.abuk.ovh            -> album
 *   https://30paulina.abuk.ovh/?view=pokaz -> pokaz slajdów na TV
 *
 * Nowa impreza = nowa linijka w IMPREZY + nowa domena w Workerze
 * (Settings -> Domains & Routes -> Add -> Custom domain).
 */
const IMPREZY = {
  // subdomena: adres wdrożenia Apps Script (kończy się na /exec)
  '30paulina': 'https://script.google.com/macros/s/WKLEJ_ID_WDROZENIA/exec',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const sub = url.hostname.split('.')[0].toLowerCase();
    const app = IMPREZY[sub];

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    if (!app) {
      return html(`<h1>Nie ma takiej imprezy</h1><p>Sprawdź adres z kodu QR.</p>`, 404, 'Album z imprezy');
    }

    // ?view=pokaz i inne parametry przechodzą dalej do albumu
    const src = app + url.search;
    return html(
      `<iframe src="${esc(src)}" allow="autoplay; fullscreen; clipboard-write" allowfullscreen></iframe>`,
      200,
      'Album z imprezy'
    );
  },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function html(body, status, title) {
  return new Response(`<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f0d13">
<title>${esc(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f0d13; color: #f7f2ea; font-family: system-ui, sans-serif; }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  h1, p { text-align: center; } h1 { margin-top: 30vh; }
</style>
</head>
<body>${body}</body>
</html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
