const { app, BrowserWindow, shell, session, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// Performance & privacy hardening
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'TranslateUI,VizDisplayCompositor,HardwareMediaKeyHandling,MediaSessionService');
app.commandLine.appendSwitch('renderer-process-limit', '4'); // Allow enough renderers for selector + main + popups
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512'); // 256MB too low for AudioWorklet + WebView

// Register custom protocol to serve AudioWorklet files (file:// is blocked in worklets)
protocol.registerSchemesAsPrivileged([
  // corsEnabled: la web (https) carga el worklet en modo CORS; sin esto Chromium lo bloquea.
  { scheme: 'anr', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow = null;

// Noise reduction state — persisted to disk so preference survives restarts
const NOISE_STATE_PATH = path.join(app.getPath('userData'), 'noise-reduction.json');

function loadNoiseState() {
  try {
    const raw = fs.readFileSync(NOISE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch {
    return false;
  }
}

function saveNoiseState(enabled) {
  try {
    fs.writeFileSync(NOISE_STATE_PATH, JSON.stringify({ enabled: !!enabled }), 'utf8');
  } catch (e) {
    console.warn('[A.N.O.T.H.E.R.] Failed to persist noise reduction state:', e.message);
  }
}

let noiseReductionEnabled = loadNoiseState();

ipcMain.handle('get-noise-reduction', () => noiseReductionEnabled);
ipcMain.handle('set-noise-reduction', (_event, enabled) => {
  noiseReductionEnabled = !!enabled;
  saveNoiseState(noiseReductionEnabled);
  return noiseReductionEnabled;
});

// Script injected into the app webview to intercept getUserMedia
// and apply the AudioWorklet noise reduction processor
const NOISE_INJECTION_SCRIPT = `
(function() {
  if (navigator.mediaDevices.__anrWrapped) return;
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  // Un grafo de audio por cada captura: así una captura nueva no deja muda a la anterior
  // y parar las pistas procesadas también apaga el micrófono real.
  const graphs = new Set();

  async function getNoiseState() {
    try { return await window.anotherAPI.getNoiseReductionState(); } catch { return false; }
  }

  async function buildGraph(stream) {
    const rawAudio = stream.getAudioTracks();
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 48000 });
    } catch (ctxErr) {
      console.warn('[A.N.O.T.H.E.R.] AudioContext creation failed:', ctxErr);
      return stream;
    }
    const graph = { closed: false, rawAudio, processed: [] };
    graph.close = () => {
      if (graph.closed) return;
      graph.closed = true;
      graphs.delete(graph);
      try { ctx.close().catch(() => {}); } catch {}
    };
    // Parar todo: pistas procesadas, micrófono real y contexto.
    graph.stopAll = () => {
      graph.processed.forEach(t => { try { t.__anrStop(); } catch {} });
      rawAudio.forEach(t => { try { t.stop(); } catch {} });
      graph.close();
    };
    graphs.add(graph);
    try {
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch {}
      }
      await ctx.audioWorklet.addModule('anr://noise-reduction-processor.js');
      const source = ctx.createMediaStreamSource(new MediaStream(rawAudio));
      const node = new AudioWorkletNode(ctx, 'noise-reduction-processor', {
        processorOptions: { sampleRate: ctx.sampleRate, bufferSize: 128 }
      });
      // Enable processor and calibrate noise profile on each new stream acquisition
      node.port.postMessage({ type: 'set-enabled', value: true });
      node.port.postMessage({ type: 'calibrate' });
      const destination = ctx.createMediaStreamDestination();
      source.connect(node).connect(destination);

      graph.processed = destination.stream.getAudioTracks();
      let live = graph.processed.length;
      for (const t of graph.processed) {
        const nativeStop = t.stop.bind(t);
        t.__anrStop = nativeStop;
        // Cuando la web para la última pista procesada, se apaga el micro real y el grafo.
        t.stop = function() {
          if (t.readyState !== 'ended') { nativeStop(); live--; }
          if (live <= 0) graph.stopAll();
        };
      }
      // Si el micro real se acaba (desconectado), la pista procesada también.
      rawAudio.forEach(r => r.addEventListener('ended', () => {
        if (rawAudio.every(x => x.readyState === 'ended')) graph.stopAll();
      }));

      return new MediaStream([...graph.processed, ...stream.getVideoTracks()]);
    } catch (e) {
      console.warn('[A.N.O.T.H.E.R.] Noise reduction unavailable, using raw stream:', e);
      graph.close();
      return stream;
    }
  }

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await originalGetUserMedia(constraints);
    // Only process audio streams when noise reduction is enabled
    if (!constraints || !constraints.audio || stream.getAudioTracks().length === 0) return stream;
    if (!await getNoiseState()) return stream;
    return buildGraph(stream);
  };
  navigator.mediaDevices.__anrWrapped = true;

  // Expose cleanup for graceful shutdown
  window.__anotherCleanupAudio = () => { [...graphs].forEach(g => g.stopAll()); };
})();
`;

// El entorno de desarrollo (una URL efímera de Replit) solo existe sin empaquetar o con
// --dev. En una build instalada no se ofrece, no es el valor por defecto y su origen no
// recibe permisos de micrófono, pantalla ni portapapeles.
const DEV_ENABLED = !app.isPackaged || process.argv.includes('--dev');
const ENVIRONMENTS = {
  prod: 'https://another-private.replit.app/app',
  ...(DEV_ENABLED ? { dev: 'https://ce21a311-d966-4f44-8ddd-2ba432555a74-00-3g8n538es1obp.picard.replit.dev/app' } : {})
};

// Validate environment URLs at startup to prevent open-redirect via config tampering
for (const [key, url] of Object.entries(ENVIRONMENTS)) {
  try {
    const parsed = new URL(url);
    if (!['https:'].includes(parsed.protocol)) {
      console.error(`[SECURITY] Environment "${key}" uses insecure protocol: ${parsed.protocol}`);
    }
  } catch (e) {
    console.error(`[SECURITY] Environment "${key}" has invalid URL: ${url}`);
  }
}

function createWindow(targetUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#051525',
    autoHideMenuBar: true,
    transparent: false,          // Avoid extra GPU compositing layer
    frame: true,                 // Native frame is cheaper than custom chrome
    paintWhenInitiallyHidden: false, // Don't render until window is shown
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Privacy & performance hardening
      disableBlinkFeatures: 'AutomationControlled',
      partition: 'persist:another-private',
      spellcheck: false,
      enableWebSQL: false,
      allowRunningInsecureContent: false,
      imageAnimationPolicy: 'noAnimation', // Disable GIF/APNG to save CPU/GPU
      backgroundThrottling: true,           // Throttle hidden frames to save resources
      autoplayPolicy: 'user-gesture-required' // Prevent auto-playing media
    }
  });

  // Grant media permissions automatically for Discord-like experience
  // Security: scope permissions to trusted origins only to prevent malicious redirects
  const trustedOrigins = new Set(Object.values(ENVIRONMENTS).map(u => new URL(u).origin));
  const allowedPermissions = new Set([
    'media',
    'mediaKeySystem',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'display-capture'
  ]);
  session.fromPartition('persist:another-private').setPermissionRequestHandler((webContents, permission, callback) => {
    if (!allowedPermissions.has(permission)) return callback(false);
    try {
      const origin = new URL(webContents.getURL()).origin;
      callback(trustedOrigins.has(origin));
    } catch {
      callback(false);
    }
  });

  // Enable getDisplayMedia (screen sharing) — Electron requires an explicit
  // handler that resolves to a DesktopCapturerSource from desktopCapturer.
  const { desktopCapturer } = require('electron');
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.videoRequested) return callback({});
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (!sources || sources.length === 0) return callback({});
      // Prefer the first full-screen source; fall back to any available source.
      const selected = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      callback({ video: selected });
    }).catch(() => callback({}));
  });

  // Open external links in default browser (privacy + requirement #2)
  // Security: validate URL to prevent open-redirect and protocol handler attacks
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      // Only allow http(s) to external browser; block javascript:, data:, file:, etc.
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      }
      // Non-http protocols are silently blocked (not opened externally)
    } catch {
      // Invalid URLs are silently blocked
    }
    return { action: 'deny' };
  });

  // Restrict top-level navigation to trusted origins only (prevent open-redirect via JS)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const origin = new URL(url).origin;
      if (!trustedOrigins.has(origin)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Inject noise reduction interceptor + floating toggle after page loads (single call)
  // Security: only inject on trusted origins to prevent script injection on unexpected pages
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      const currentOrigin = new URL(mainWindow.webContents.getURL()).origin;
      if (!trustedOrigins.has(currentOrigin)) return;
    } catch { return; }
    mainWindow.webContents.executeJavaScript(NOISE_INJECTION_SCRIPT + `
(function(){
  if(document.getElementById('anr-noise-toggle'))return;
  var b=document.createElement('div');b.id='anr-noise-toggle';
  b.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg><span id="anr-nr-label">NR OFF</span>';
  var s=b.style;s.cssText='position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:20px;cursor:pointer;background:rgba(5,21,37,.85);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);font:700 11px/1 "Segoe UI",sans-serif;letter-spacing:.5px;user-select:none;transition:all .2s';
  document.body.appendChild(b);
  var l=document.getElementById('anr-nr-label');
  async function y(){try{if(!window.anotherAPI)return;var o=await anotherAPI.getNoiseReductionState();if(l)l.textContent=o?'NR ON':'NR OFF';s.color=o?'#6dd5fa':'rgba(255,255,255,.6)';s.borderColor=o?'rgba(109,213,250,.5)':'rgba(255,255,255,.15)';s.boxShadow=o?'0 0 12px rgba(109,213,250,.3)':'none'}catch(e){}}
  b.onclick=async()=>{try{if(!window.anotherAPI)return;var cur=await anotherAPI.getNoiseReductionState();var next=await anotherAPI.setNoiseReduction(!cur);if(l)l.textContent=next?'NR ON':'NR OFF';s.color=next?'#6dd5fa':'rgba(255,255,255,.6)';s.borderColor=next?'rgba(109,213,250,.5)':'rgba(255,255,255,.15)';s.boxShadow=next?'0 0 12px rgba(109,213,250,.3)':'none'}catch(e){}};
  b.onmouseenter=()=>{s.background='rgba(10,37,64,.95)'};
  b.onmouseleave=()=>{s.background='rgba(5,21,37,.85)'};
  y();
})();`, true);
  });

  // Load the target URL with retry on transient failures
  const MAX_LOAD_RETRIES = 3;
  async function loadWithRetry(url, attempt = 0) {
    try {
      await mainWindow.loadURL(url);
    } catch (err) {
      if (attempt < MAX_LOAD_RETRIES && !mainWindow.isDestroyed()) {
        console.warn(`[A.N.O.T.H.E.R.] Load failed (attempt ${attempt + 1}/${MAX_LOAD_RETRIES}):`, err.message);
        setTimeout(() => loadWithRetry(url, attempt + 1), 2000 * (attempt + 1));
      } else {
        console.error('[A.N.O.T.H.E.R.] Load failed permanently:', err.message);
      }
    }
  }
  loadWithRetry(targetUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showEnvironmentSelector() {
  const selector = new BrowserWindow({
    width: 700,
    height: 500,
    resizable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#051525',
    autoHideMenuBar: true,
    transparent: false,
    paintWhenInitiallyHidden: false,
    webPreferences: {
      preload: path.join(__dirname, 'selector-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,               // Harden selector window too
      spellcheck: false,
      enableWebSQL: false,
      imageAnimationPolicy: 'noAnimation',
      backgroundThrottling: true
    }
  });

  selector.loadFile(path.join(__dirname, 'selector.html'));

  // Use a named handler so we can remove it on close without consuming it permanently.
  // ipcMain.once would break re-opening the selector after the first selection (e.g. macOS activate).
  const onSelectEnv = (_event, env) => {
    selector.close();
    const known = typeof env === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENTS, env);
    if (!known) {
      console.warn(`[SECURITY] Unknown or unavailable environment "${env}" requested, falling back to prod`);
    }
    const url = known ? ENVIRONMENTS[env] : ENVIRONMENTS.prod;
    createWindow(url);
  };
  ipcMain.on('select-environment', onSelectEnv);
  selector.on('closed', () => {
    ipcMain.removeListener('select-environment', onSelectEnv);
  });
}

app.whenReady().then(() => {
  // Register custom protocol handler for AudioWorklet files (async read)
  // Security: whitelist only known processor files to prevent path traversal
  const ALLOWED_ANR_FILES = new Set(['noise-reduction-processor.js']);
  const anrHandler = async (request) => {
    // Al ser un esquema «standard», anr://noise-reduction-processor.js llega como
    // anr://noise-reduction-processor.js/ : el nombre del archivo es el host.
    let requestedFile = '';
    try {
      const u = new URL(request.url);
      requestedFile = u.pathname === '/' || u.pathname === '' ? u.hostname : u.hostname + u.pathname;
    } catch { /* URL inválida: se rechaza abajo */ }
    if (!ALLOWED_ANR_FILES.has(requestedFile)) {
      return new Response('Forbidden', { status: 403 });
    }
    const filePath = path.join(__dirname, requestedFile);
    // Verify resolved path is still within __dirname (defense in depth)
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname))) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store',
          // Archivo estático y público de la app; la web lo pide desde su propio origen.
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch {
      return new Response('', { status: 404 });
    }
  };
  // protocol.handle solo cubre la sesión por defecto; la app vive en la partición
  // persist:another-private, así que sin este segundo registro el worklet nunca cargaba
  // y la reducción de ruido devolvía siempre el audio sin procesar.
  protocol.handle('anr', anrHandler);
  session.fromPartition('persist:another-private').protocol.handle('anr', anrHandler);

  // Show selector immediately — don't block startup on cleanup
  showEnvironmentSelector();

  // Privacy: wipe session data asynchronously after UI is visible
  setImmediate(async () => {
    try {
      const ses = session.fromPartition('persist:another-private');
      await Promise.all([
        ses.clearCache(),
        ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql']
        }),
        ses.clearHostResolverCache(),
        ses.clearAuthCache(),
        // Unregister any service workers that might retain session data
        ...((await ses.serviceWorker.getAllRunning()).map(sw =>
          ses.serviceWorker.unregister(sw.scope).catch(() => {})
        ))
      ]);
    } catch { /* best-effort cleanup */ }
  });
});

// Graceful shutdown: close AudioContext and worklet nodes before quit
app.on('before-quit', () => {
  // Signal renderer to clean up audio resources via exposed cleanup function
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.executeJavaScript(
        `(function(){ try { if(window.__anotherCleanupAudio) window.__anotherCleanupAudio(); } catch(e){} })();`,
        true
      ).catch(() => {});
    } catch {}
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    showEnvironmentSelector();
  }
});