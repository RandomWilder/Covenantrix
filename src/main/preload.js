const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  
  // File operations
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectGoogleServiceAccountFile: () => ipcRenderer.invoke('select-google-service-account-file'),
  
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

  // Phase 3: RAG Chat functionality
  ragQuery: (query, conversationId, options) => ipcRenderer.invoke('rag-query', query, conversationId, options),
  getConversationHistory: (conversationId) => ipcRenderer.invoke('get-conversation-history', conversationId),
  getAllConversations: () => ipcRenderer.invoke('get-all-conversations'),
  deleteConversation: (conversationId) => ipcRenderer.invoke('delete-conversation', conversationId),
  clearAllConversations: () => ipcRenderer.invoke('clear-all-conversations'),
  generateConversationId: () => ipcRenderer.invoke('generate-conversation-id'),

  // Phase 3: Google Vision OCR Configuration (Simplified)
  setGoogleVisionServiceAccount: (serviceAccountPath) => ipcRenderer.invoke('set-google-vision-service-account', serviceAccountPath),
  getGoogleVisionInfo: () => ipcRenderer.invoke('get-google-vision-info'),
  clearGoogleVisionServiceAccount: () => ipcRenderer.invoke('clear-google-vision-service-account'),

  isOCRReady: () => ipcRenderer.invoke('is-ocr-ready'),
  getOCRSettings: () => ipcRenderer.invoke('get-ocr-settings'),
  updateOCRSettings: (settings) => ipcRenderer.invoke('update-ocr-settings', settings),
  testOCRConnection: () => ipcRenderer.invoke('test-ocr-connection'),
  getLanguageSupport: () => ipcRenderer.invoke('get-language-support'),
  
  // Processing status listeners
  onProcessingStatus: (callback) => ipcRenderer.on('processing-status', callback),
  onDocumentProgress: (callback) => ipcRenderer.on('document-progress', callback),
  
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