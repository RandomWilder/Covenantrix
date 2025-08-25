const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  
  // File operations
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  
  // Document operations
  processDocuments: (filePaths) => ipcRenderer.invoke('process-documents', filePaths),
  getDocuments: () => ipcRenderer.invoke('get-documents'),
  searchDocuments: (query, searchType) => ipcRenderer.invoke('search-documents', query, searchType),
  deleteDocument: (documentId) => ipcRenderer.invoke('delete-document', documentId),
  
  // Phase 2: API Key Management
  setOpenAIKey: (apiKey) => ipcRenderer.invoke('set-openai-key', apiKey),
  getStoredApiKey: () => ipcRenderer.invoke('get-stored-api-key'),
  clearApiKey: () => ipcRenderer.invoke('clear-api-key'),
  
  // Phase 2: Vector Database
  getVectorStats: () => ipcRenderer.invoke('get-vector-stats'),
  getSupportedTypes: () => ipcRenderer.invoke('get-supported-types'),
  
  // Phase 2: Language Support
  getLanguageSupport: () => ipcRenderer.invoke('get-language-support'),
  addLanguageSupport: (languageCode) => ipcRenderer.invoke('add-language-support', languageCode),
  
  // Processing status listener
  onProcessingStatus: (callback) => ipcRenderer.on('processing-status', callback),
  
  // Update operations
  restartApp: () => ipcRenderer.invoke('restart-app'),
  
  // Update listeners
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  onTriggerUpload: (callback) => ipcRenderer.on('trigger-upload', callback),
  
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});