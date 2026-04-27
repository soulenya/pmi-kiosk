/* ============================================================
   android-polyfill.js
   Provides window.kiosk API when running outside Electron —
   i.e. on Android (Capacitor) or a plain browser.

   Load order in kiosk.html:
     1. assets/js/qrcode.min.js  (qrcode-generator library)
     2. android-polyfill.js      (this file)
     3. Existing Pi-mode script  (reads window.kiosk.piMode)

   In Electron, preload.js runs before the page and already sets
   window.kiosk, so this file exits immediately on the guard below.
   ============================================================ */
(function () {
  'use strict';
  if (window.kiosk) return; // Already set by Electron preload — do nothing.

  /* ── Constants (mirror main.js) ───────────────────────── */
  const ODOO_BASE = 'https://precisian-medical-instruments.odoo.com';
  const ODOO_DB   = 'precisian-medical-instruments';

  /* ── XML-RPC helpers ──────────────────────────────────── */
  function escapeXml(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  function toXml(val) {
    if (val === null || val === undefined) return '<value><nil/></value>';
    if (typeof val === 'boolean')
      return `<value><boolean>${val ? 1 : 0}</boolean></value>`;
    if (typeof val === 'number')
      return `<value><int>${val}</int></value>`;
    if (Array.isArray(val))
      return `<value><array><data>${val.map(toXml).join('')}</data></array></value>`;
    if (typeof val === 'object') {
      const members = Object.entries(val)
        .map(([k, v]) => `<member><name>${escapeXml(k)}</name>${toXml(v)}</member>`)
        .join('');
      return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${escapeXml(String(val))}</string></value>`;
  }

  function buildRpc(method, params) {
    return (
      `<?xml version="1.0"?><methodCall>` +
      `<methodName>${method}</methodName><params>` +
      params.map(p => `<param>${toXml(p)}</param>`).join('') +
      `</params></methodCall>`
    );
  }

  function parseIntResult(xml) {
    const m = xml.match(/<(?:int|i4|i8)>(\d+)<\/(?:int|i4|i8)>/);
    return m ? Number(m[1]) : null;
  }

  // Capacitor 5 patches fetch() natively on Android so CORS is bypassed.
  // Falls back to normal fetch for browser testing.
  async function xmlrpcFetch(urlPath, method, params) {
    const r = await fetch(ODOO_BASE + urlPath, {
      method:  'POST',
      headers: { 'Content-Type': 'text/xml' },
      body:    buildRpc(method, params),
    });
    return r.text();
  }

  /* ── Lazy-load Odoo credentials from bundled config ────── */
  let _cfgCache;
  async function loadConfig() {
    if (_cfgCache !== undefined) return _cfgCache;
    try {
      const r = await fetch('./odoo-config.json');
      _cfgCache = r.ok ? await r.json() : {};
    } catch (_) {
      _cfgCache = {};
    }
    return _cfgCache;
  }

  /* ── QR code — canvas-rendered via qrcode-generator ────── */
  async function generateQR() {
    try {
      /* qrcode-generator exposes a global qrcode() function */
      const qr = qrcode(0, 'M'); // type=0 (auto), error correction M
      qr.addData('https://precisianmedical.com/#contact');
      qr.make();

      const mod    = qr.getModuleCount();
      const size   = 400;
      const cell   = size / mod;
      const canvas = document.createElement('canvas');
      canvas.width  = size;
      canvas.height = size;

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#131313';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#FFFFFF';
      for (let row = 0; row < mod; row++) {
        for (let col = 0; col < mod; col++) {
          if (qr.isDark(row, col)) {
            ctx.fillRect(col * cell, row * cell, cell, cell);
          }
        }
      }
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[android-kiosk] QR generation failed:', e);
      return null;
    }
  }

  /* ── Exposed window.kiosk API ─────────────────────────── */
  window.kiosk = {
    piMode: 'android',

    saveContact: async ({ name = '', org = '', role = '', email = '', phone = '' } = {}) => {
      try {
        const cfg = await loadConfig();
        if (!cfg.login || !cfg.api_key) {
          console.warn('[android-kiosk] No Odoo credentials — lead logged locally only.');
          return { ok: true };
        }

        const authXml = await xmlrpcFetch(
          '/xmlrpc/2/common', 'authenticate',
          [ODOO_DB, cfg.login, cfg.api_key, {}]
        );
        const uid = parseIntResult(authXml);
        if (!uid) { console.error('[android-kiosk] Odoo auth failed.'); return { ok: true }; }

        await xmlrpcFetch('/xmlrpc/2/object', 'execute_kw', [
          ODOO_DB, uid, cfg.api_key, 'crm.lead', 'create', [{
            name:         `Kiosk Lead — ${name}`,
            contact_name: name,
            email_from:   email,
            partner_name: org,
            function:     role,
            description:  `Captured via PMI kiosk on ${new Date().toLocaleString()}`,
            ...(phone ? { mobile: phone } : {}),
          }],
        ]);
        console.log('[android-kiosk] Lead created in Odoo.');
      } catch (e) {
        console.error('[android-kiosk] saveContact failed:', e);
      }
      return { ok: true };
    },

    getQR: generateQR,
  };
})();
