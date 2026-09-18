const { app, BrowserWindow, Tray, Menu, ipcMain, screen, session,
        desktopCapturer, globalShortcut, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

let win, tray, mode = 'setup'
const icon = name => nativeImage.createFromPath(path.join(__dirname, 'assets', name))

// Overlay geometry and opacity survive restarts. An overlay you have to
// re-place every launch gets turned off by the second day.
const DEFAULTS = { size: 1, opacity: 1, x: null, y: null }
let ui = { ...DEFAULTS }
const statePath = () => path.join(app.getPath('userData'), 'overlay.json')
const loadState = () => { try { Object.assign(ui, JSON.parse(fs.readFileSync(statePath(), 'utf8'))) } catch {} }
const saveState = () => { try { fs.writeFileSync(statePath(), JSON.stringify(ui)) } catch {} }

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => setMode('setup'))

// One window. It is the overlay in both states, so nothing ever opens a second
// window: setup is the same surface made focusable and a little taller.
const DIMS = { setup: [760, 560], cue: [760, 210] }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function createWindow () {
  win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.loadFile('overlay.html')

  // 'screen-saver' is what keeps it above a fullscreen Teams or Zoom window.
  // Plain alwaysOnTop: true does not clear fullscreen apps.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setOpacity(ui.opacity)

  win.once('ready-to-show', () => setMode('setup'))
}

function applyBounds () {
  const { workArea } = screen.getPrimaryDisplay()
  const [bw, bh] = DIMS[mode]
  const width = Math.round(Math.min(bw * ui.size, workArea.width - 40))
  const height = Math.round(bh * ui.size)
  const x = ui.x ?? Math.round(workArea.x + (workArea.width - width) / 2)
  const y = ui.y ?? Math.round(workArea.y + workArea.height - height - 48)

  win.setBounds({
    width,
    height,
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height)
  })
  win.webContents.send('scale', ui.size)
}

function setMode (next) {
  mode = next
  const setup = next === 'setup'
  // Click-through only in cue mode. You cannot type into a click-through window.
  win.setIgnoreMouseEvents(!setup, { forward: true })
  win.setFocusable(setup)
  applyBounds()
  win.webContents.send('mode', next)
  if (setup) { win.show(); win.focus() } else win.showInactive()
}

// ------------------------------------------------------------------ shortcuts
const nudge = (dx, dy) => {
  const b = win.getBounds()
  ui.x = b.x + dx * ui.size
  ui.y = b.y + dy * ui.size
  applyBounds(); saveState()
}
const opacity = d => {
  ui.opacity = Math.round(clamp(ui.opacity + d, 0.2, 1) * 100) / 100
  win.setOpacity(ui.opacity); saveState()
  win.webContents.send('toast', `opacity ${Math.round(ui.opacity * 100)}%`)
}
const resize = d => {
  ui.size = Math.round(clamp(ui.size + d, 0.7, 1.8) * 100) / 100
  applyBounds(); saveState()
  win.webContents.send('toast', `size ${Math.round(ui.size * 100)}%`)
}

const SHORTCUTS = {
  'Control+Alt+S': () => setMode(mode === 'setup' ? 'cue' : 'setup'),
  'Control+Alt+H': () => win.isVisible() ? win.hide() : win.showInactive(),
  'Control+Alt+]': () => opacity(+0.1),
  'Control+Alt+[': () => opacity(-0.1),
  'Control+Alt+PageUp': () => resize(+0.1),
  'Control+Alt+PageDown': () => resize(-0.1),
  'Control+Alt+Up': () => nudge(0, -40),
  'Control+Alt+Down': () => nudge(0, 40),
  'Control+Alt+Left': () => nudge(-40, 0),
  'Control+Alt+Right': () => nudge(40, 0),
  'Control+Alt+0': () => { ui = { ...DEFAULTS }; win.setOpacity(1); applyBounds(); saveState() }
}

function registerShortcuts () {
  const failed = Object.entries(SHORTCUTS)
    .filter(([accel, fn]) => !globalShortcut.register(accel, fn))
    .map(([accel]) => accel)
  // Another app already owns the combination. Say so instead of leaving a
  // dead key the user keeps pressing.
  if (failed.length) console.warn('shortcuts taken by another app:', failed.join(', '))
}

// ---------------------------------------------------------------------- tray
function buildTray () {
  tray = new Tray(icon('tray-idle.png'))
  tray.setToolTip('CueLine: idle')
  refreshMenu(false)
  tray.on('click', () => setMode('setup'))
}

function refreshMenu (live) {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: live ? 'Live' : 'Idle', enabled: false },
    { type: 'separator' },
    { label: 'Setup\tCtrl+Alt+S', click: () => setMode('setup') },
    { label: 'Hide overlay\tCtrl+Alt+H', click: () => win.isVisible() ? win.hide() : win.showInactive() },
    { label: 'Reset position and size\tCtrl+Alt+0', click: SHORTCUTS['Control+Alt+0'] },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { type: 'separator' },
    { label: 'Quit CueLine', click: () => { app.isQuitting = true; app.quit() } }
  ]))
}

// ---------------------------------------------------------------------- boot
app.whenReady().then(() => {
  loadState()

  // System loopback capture. Documented as Windows only, which is our target.
  // 'loopbackWithMute' would silence the agent's own speakers, so never that one.
  // video must be a real DesktopCapturerSource. Electron rejects anything else,
  // and getDisplayMedia refuses to run audio-only, so we take a screen source
  // and the renderer stops the video track immediately.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const [screenSource] = await desktopCapturer.getSources({ types: ['screen'] })
      callback({ video: screenSource, audio: 'loopback' })
    } catch (err) {
      console.error('loopback capture refused', err)
      callback({}) // fail closed, the renderer reports the missing permission
    }
  }, { useSystemPicker: false })

  // The renderer loads from file://, so grant capture to our own page only.
  // 'display-capture' is a separate permission from 'media'. Granting only
  // 'media' blocks getDisplayMedia before the loopback handler ever runs.
  const ours = url => url.startsWith('file://')
  const allowed = p => p === 'media' || p === 'display-capture'
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(allowed(permission) && ours(wc.getURL())))
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    allowed(permission) && ours(wc?.getURL() || ''))

  createWindow()
  buildTray()
  registerShortcuts()
})

ipcMain.on('mode', (_e, next) => setMode(next))

ipcMain.on('status', (_e, live) => {
  tray.setImage(icon(live ? 'tray-live.png' : 'tray-idle.png'))
  tray.setToolTip(`CueLine: ${live ? 'live' : 'idle'}`)
  refreshMenu(live)
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {}) // tray app, closing a window is not a quit
