/* ============================================================
   PMI Kiosk — preload.js
   Exposes safe IPC bridges from Node ↔ renderer.
   Runs in isolated context; no full Node access in renderer.
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

// Resolve Pi mode synchronously so the renderer can apply CSS classes
// before any frame is painted — avoids flash of wrong styles.
const PI_MODE = ipcRenderer.sendSync('get-pi-mode-sync');

contextBridge.exposeInMainWorld('kiosk', {
  saveContact: (data) => ipcRenderer.invoke('save-contact', data),
  getQR:       ()     => ipcRenderer.invoke('get-qr'),
  piMode:      PI_MODE,   // 'zero' | 'pi5' | 'desktop'
});
