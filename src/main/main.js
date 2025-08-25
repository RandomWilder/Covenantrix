const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const DocumentService = require('./services/documentService');
const RAGService = require('./services/ragService');

let mainWindow;
let documentService;
let ragService;

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

app.whenReady().then(async () => {
  // Initialize services
  documentService = new DocumentService();
  ragService = new RAGService();
  
  // Initialize services
  await ragService.initialize();
  
  setupIPCHandlers();
  createWindow();
});

// IPC handlers for document operations
function setupIPCHandlers() {
  // Handle file upload dialog with Phase 2 support
  ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'] },
        { name: 'All Supported', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    return { success: true, filePaths: result.filePaths };
  });

  // Handle Google Service Account JSON file selection
  ipcMain.handle('select-google-service-account-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      title: 'Select Google Vision Service Account JSON File'
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    return { success: true, filePath: result.filePaths[0] };
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

  // Enhanced search with different modes
  ipcMain.handle('search-documents', async (event, query, searchType = 'hybrid') => {
    return documentService.searchDocuments(query, searchType);
  });

  // Delete document (now removes from vector database too)
  ipcMain.handle('delete-document', async (event, documentId) => {
    return await documentService.deleteDocument(documentId);
  });

  // API Key Management
  ipcMain.handle('set-openai-key', async (event, apiKey) => {
    return await documentService.setOpenAIApiKey(apiKey);
  });

  ipcMain.handle('get-stored-api-key', async () => {
    return documentService.getStoredApiKey();
  });

  ipcMain.handle('clear-api-key', async () => {
    documentService.clearApiKey();
    return true;
  });

  // Vector database stats
  ipcMain.handle('get-vector-stats', async () => {
    return await documentService.getVectorStats();
  });

  // Get supported file types
  ipcMain.handle('get-supported-types', async () => {
    return {
      pdf: ['pdf'],
      images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'],
      all: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp']
    };
  });

  // Get OCR info (simplified for clean OCR service)
  ipcMain.handle('get-ocr-info', async () => {
    return documentService.getOCRInfo();
  });

  // Check if OCR is ready
  ipcMain.handle('is-ocr-ready', async () => {
    return documentService.isOCRReady();
  });

  // Language support (simplified - Google Vision supports these by default)
  ipcMain.handle('get-language-support', async () => {
    return {
      supportedLanguages: ['hebrew', 'arabic', 'english'],
      defaultLanguages: ['he', 'ar', 'en'],
      isMultiLanguage: true
    };
  });

  // Phase 3: RAG Chat functionality
  ipcMain.handle('rag-query', async (event, query, conversationId, options) => {
    try {
      return await ragService.queryDocuments(query, conversationId, options);
    } catch (error) {
      console.error('RAG query error:', error);
      return {
        response: 'Sorry, I encountered an error processing your question. Please try again.',
        sources: [],
        conversationId: conversationId || ragService.generateConversationId(),
        error: error.message
      };
    }
  });

  // Get conversation history
  ipcMain.handle('get-conversation-history', async (event, conversationId) => {
    return ragService.getConversationHistory(conversationId);
  });

  // Get all conversations
  ipcMain.handle('get-all-conversations', async () => {
    return ragService.getAllConversations();
  });

  // Delete conversation
  ipcMain.handle('delete-conversation', async (event, conversationId) => {
    return ragService.deleteConversation(conversationId);
  });

  // Clear all conversations
  ipcMain.handle('clear-all-conversations', async () => {
    return ragService.clearAllConversations();
  });

  // Generate new conversation ID
  ipcMain.handle('generate-conversation-id', async () => {
    return ragService.generateConversationId();
  });

  // Phase 3: Google Vision OCR Configuration (Simplified)
  ipcMain.handle('set-google-vision-service-account', async (event, serviceAccountPath) => {
    try {
      const result = await documentService.setGoogleVisionServiceAccount(serviceAccountPath);
      
      // Get project info for UI feedback
      const ocrInfo = documentService.getOCRInfo();
      
      return { 
        success: true, 
        projectId: ocrInfo.projectId || 'unknown',
        isInitialized: ocrInfo.isInitialized 
      };
    } catch (error) {
      console.error('Error setting Google Vision service account:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-google-vision-info', async () => {
    return documentService.getOCRInfo();
  });

  ipcMain.handle('clear-google-vision-service-account', async () => {
    try {
      documentService.clearGoogleVisionServiceAccount();
      return { success: true };
    } catch (error) {
      console.error('Error clearing Google Vision service account:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-ocr-settings', async () => {
    return {
      primaryEngine: 'google_vision',
      enableFallback: false,
      isReady: documentService.isOCRReady(),
      supportedLanguages: ['hebrew', 'arabic', 'english']
    };
  });

  ipcMain.handle('update-ocr-settings', async (event, settings) => {
    // For simplified OCR service, just acknowledge the update
    console.log('⚙️ OCR settings updated (simplified):', settings);
    return { success: true };
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