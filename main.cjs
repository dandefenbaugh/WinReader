const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, unlink, writeFile } = require('node:fs/promises');

ipcMain.handle('subscriptions:read', () => readFile(path.join(__dirname, 'subscriptions.opml'), 'utf8'));
ipcMain.handle('app:version', () => app.getVersion());

const maxFeedBytes = 8 * 1024 * 1024;

function cachePath(address) {
  const key = createHash('sha256').update(address).digest('hex');
  return path.join(app.getPath('userData'), 'feeds-v1', key + '.json');
}

ipcMain.handle('feed:cache-read', async (_event, address) => {
  try {
    return JSON.parse(await readFile(cachePath(address), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('feed:cache-write', async (_event, address, data) => {
  const file = cachePath(address);
  const temporary = file + '.' + randomUUID() + '.tmp';
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(data));
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
});

ipcMain.handle('feed:fetch', async (_event, address, validators) => {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported feed address.');
  const headers = {};
  if (validators?.etag) headers['If-None-Match'] = validators.etag;
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  const signal = AbortSignal.timeout(15000);
  try {
    return await downloadFeed(url, headers, signal);
  } catch (error) {
    if (signal.aborted) throw new Error('Connection timed out.');
    if (error instanceof TypeError) throw new Error('Could not connect to the feed.');
    throw error;
  }
});

async function downloadFeed(url, headers, signal) {
  const response = await fetch(url, { headers, signal });
  if (response.status === 304 && Object.keys(headers).length) return { unchanged: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxFeedBytes) throw new Error('Feed exceeds 8 MB.');
    body += decoder.decode(chunk, { stream: true });
  }
  return {
    unchanged: false,
    body: body + decoder.decode(),
    url: response.url,
    validators: {
      etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || ''
    }
  };
}

ipcMain.handle('article:open', (_event, address) => {
  const url = new URL(address);
  if (['http:', 'https:'].includes(url.protocol)) return shell.openExternal(url.href);
});

ipcMain.on('window:command', (event, command) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (command === 'minimize') window.minimize();
  if (command === 'maximize') {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }
  if (command === 'close') window.close();
});

function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 440,
    frame: false,
    roundedCorners: false,
    backgroundColor: '#c0c0c0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  for (const event of ['maximize', 'unmaximize', 'focus', 'blur']) {
    window.on(event, () => window.webContents.send('window:state', window.isMaximized(), window.isFocused()));
  }
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === 'darwin'
    ? [{ role: 'appMenu' }, { role: 'editMenu' }]
    : []));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
