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
  searchDocuments: (query) => ipcRenderer.invoke('search-documents', query),
  deleteDocument: (documentId) => ipcRenderer.invoke('delete-document', documentId),
  
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