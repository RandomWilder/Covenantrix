const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const DocumentService = require('./services/documentService');

let mainWindow;
let documentService;

// Configure auto-updater (only in production)
if (!app.isPackaged) {
  console.log('Development mode - auto-updater disabled');
} else {
  // Check for updates every hour
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 60 * 60 * 1000);
}

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Version ${info.version} is available!`,
      detail: 'The update will be downloaded in the background.',
      buttons: ['OK']
    });
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available');
});

autoUpdater.on('error', (err) => {
  console.log('Error in auto-updater:', err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let logMessage = `Download speed: ${progressObj.bytesPerSecond}`;
  logMessage += ` - Downloaded ${progressObj.percent}%`;
  logMessage += ` (${progressObj.transferred}/${progressObj.total})`;
  console.log(logMessage);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);
  
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded!`,
      detail: 'The application will restart to apply the update.',
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  // Load the HTML file directly
  mainWindow.loadFile(path.join(__dirname, '../renderer/app.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Check for updates on startup (production only)
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify();
      }, 3000);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Initialize document service
  documentService = new DocumentService();
  setupIPCHandlers();
  createWindow();
});

// IPC handlers for document operations
function setupIPCHandlers() {
  // Handle file upload dialog
  ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    return { success: true, filePaths: result.filePaths };
  });

  // Process uploaded documents
  ipcMain.handle('process-documents', async (event, filePaths) => {
    const results = [];
    
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      try {
        event.sender.send('processing-status', { fileName, status: 'processing' });
        const result = await documentService.processDocument(filePath, fileName);
        results.push({ fileName, ...result });
        event.sender.send('processing-status', { fileName, status: result.success ? 'completed' : 'error', result });
      } catch (error) {
        results.push({ fileName, success: false, error: error.message });
        event.sender.send('processing-status', { fileName, status: 'error', error: error.message });
      }
    }
    
    return results;
  });

  // Get all documents
  ipcMain.handle('get-documents', async () => {
    return documentService.getAllDocuments();
  });

  // Search documents
  ipcMain.handle('search-documents', async (event, query) => {
    return documentService.searchDocuments(query);
  });

  // Delete document
  ipcMain.handle('delete-document', async (event, documentId) => {
    return documentService.deleteDocument(documentId);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});