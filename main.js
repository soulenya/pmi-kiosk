/* ============================================================
   PMI VACTOR — Electron Main Process
   Fullscreen borderless kiosk app.
   Press ESC 3× fast to quit (safety exit).
   Contacts saved to leads.csv in app folder.
   Optimised for Raspberry Pi Zero 2 W & Pi 5.
   ============================================================ */
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

/* ── Pi device detection (applied before app.ready) ──────── */
function detectPiMode() {
  const model = (os.cpus()[0] || {}).model || '';
  if (model.includes('Cortex-A53')) return 'zero'; // Pi Zero 2 W
  if (model.includes('Cortex-A72')) return 'pi4';  // Pi 4
  if (model.includes('Cortex-A76')) return 'pi5';  // Pi 5
  if (process.arch === 'arm' || process.arch === 'arm64') return 'pi4'; // safe default for unknown Pi
  return 'desktop';
}
const PI_MODE = detectPiMode();

// All Pi models run without sandbox; Pi Zero also disables GPU (512 MB RAM)
if (PI_MODE === 'zero') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}
if (PI_MODE !== 'desktop') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('touch-events', 'enabled'); // USB-C HID touchscreens
}

let win;

function createWindow() {
  win = new BrowserWindow({
    fullscreen:       true,
    frame:            false,
    kiosk:            true,
    backgroundColor:  '#0D0D0D',
    icon:             path.join(__dirname, 'assets', 'android-chrome-512x512.png'),
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false, // needed for local GLB + CDN model-viewer
    },
  });

  win.loadFile('kiosk.html');

  // Hide cursor after 4 s of no mouse movement; restore on move
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      let _hideCursor;
      document.addEventListener('mousemove', () => {
        document.body.style.cursor = '';
        clearTimeout(_hideCursor);
        _hideCursor = setTimeout(() => { document.body.style.cursor = 'none'; }, 4000);
      });
    `);
  });
}

/* ── Odoo XML-RPC helpers ───────────────────────────────── */
const ODOO_BASE = 'https://precisian-medical-instruments.odoo.com';
const ODOO_DB   = 'precisian-medical-instruments';

function escapeXml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function toXml(val) {
  if (val === null || val === undefined) return '<value><nil/></value>';
  if (typeof val === 'boolean')          return `<value><boolean>${val ? 1 : 0}</boolean></value>`;
  if (typeof val === 'number')           return `<value><int>${val}</int></value>`;
  if (Array.isArray(val))                return `<value><array><data>${val.map(toXml).join('')}</data></array></value>`;
  if (typeof val === 'object') {
    const members = Object.entries(val)
      .map(([k, v]) => `<member><name>${escapeXml(k)}</name>${toXml(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(val))}</string></value>`;
}

function buildRpc(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map(p => `<param>${toXml(p)}</param>`).join('')
  }</params></methodCall>`;
}

async function xmlrpc(urlPath, method, params) {
  const { net } = require('electron');
  const body = buildRpc(method, params);
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'POST', url: `${ODOO_BASE}${urlPath}` });
    req.setHeader('Content-Type', 'text/xml');
    let data = '';
    req.on('response', res => {
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseIntResult(xml) {
  const m = xml.match(/<(?:int|i4|i8)>(\d+)<\/(?:int|i4|i8)>/);
  return m ? Number(m[1]) : null;
}

async function pushToOdoo(name, org, role, email, phone) {
  const cfgPath = path.join(__dirname, 'odoo-config.json');
  if (!fs.existsSync(cfgPath)) { console.warn('[odoo] No odoo-config.json found.'); return; }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { console.error('[odoo] Bad config:', e.message); return; }

  const login  = cfg.login;
  const apiKey = cfg.api_key;
  if (!login || login.startsWith('YOUR_') || !apiKey || apiKey.startsWith('YOUR_')) {
    console.warn('[odoo] odoo-config.json has placeholder values — fill in your credentials.');
    return;
  }

  try {
    const authXml = await xmlrpc('/xmlrpc/2/common', 'authenticate', [ODOO_DB, login, apiKey, {}]);
    const uid = parseIntResult(authXml);
    if (!uid) { console.error('[odoo] Auth failed — check credentials in odoo-config.json.'); return; }

    const phone_field = phone ? { mobile: phone } : {};
    await xmlrpc('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, apiKey, 'crm.lead', 'create', [{
        name:         `Kiosk Lead — ${name}`,
        contact_name: name,
        email_from:   email,
        partner_name: org,
        function:     role,
        description:  `Captured via PMI kiosk on ${new Date().toLocaleString()}`,
        ...phone_field,
      }],
    ]);
    console.log('[odoo] Lead created successfully.');
  } catch (err) {
    console.error('[odoo] Error pushing to CRM:', err.message);
  }
}

/* ── IPC: Pi mode — synchronous so preload can read before page runs ── */
ipcMain.on('get-pi-mode-sync', (event) => { event.returnValue = PI_MODE; });

/* ── IPC: save lead to CSV + Odoo CRM ──────────────────── */
ipcMain.handle('save-contact', async (_event, data) => {
  const { name = '', org = '', role = '', email = '', phone = '' } = data;

  // 1. Always write to local CSV backup
  const csvPath = path.join(__dirname, 'leads.csv');
  const clean = v => '"' + ((v || '').toString()
    .replace(/"/g, '""')
    .replace(/^[=+\-@\t\r]/, "'$&")) + '"';
  const row = [name, org, role, email, phone, new Date().toISOString()]
    .map(clean).join(',') + '\n';
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'Name,Organization,Role,Email,Phone,Timestamp\n', 'utf8');
  }
  fs.appendFileSync(csvPath, row, 'utf8');

  // 2. Push to Odoo CRM (non-blocking — don't make user wait)
  pushToOdoo(name, org, role, email, phone).catch(e => console.error('[odoo]', e.message));

  return { ok: true };
});

/* ── IPC: generate QR code data URL ────────────────────── */
ipcMain.handle('get-qr', async () => {
  const QRCode = require('qrcode');
  return QRCode.toDataURL('https://precisianmedical.com/#contact', {
    width:  400,
    margin: 2,
    color:  { dark: '#FFFFFF', light: '#131313' },
  });
});

app.whenReady().then(() => {
  createWindow();

  // ESC × 3 within 1.5 s = quit
  let escCount = 0, escTimer;
  globalShortcut.register('Escape', () => {
    escCount++;
    clearTimeout(escTimer);
    if (escCount >= 3) { app.quit(); return; }
    escTimer = setTimeout(() => { escCount = 0; }, 1500);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit',          () => globalShortcut.unregisterAll());
