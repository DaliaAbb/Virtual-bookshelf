const { app, BrowserWindow } = require('electron');
const path = require('path');

const ICON = path.join(__dirname, 'assets', 'icons', 'icon_app_large.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 500,
    height: 700,
    frame: false,
    transparent: false,
    fullscreenable: false,
    resizable: false,
    icon: ICON // window icon on Windows and Linux
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // `npm run start` runs plain Electron, so set the Dock icon by hand on macOS. The packaged app
  // already has the icon built in (assets/icons/icon_app.icns).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(ICON);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window quits the whole app (on macOS it would otherwise keep running).
// The books are stored in the app's local storage on disk, so nothing is lost.
app.on('window-all-closed', () => {
  app.quit();
});
