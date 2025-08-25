const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');

class FolderService {
  constructor() {
    // Secure storage for folder data
    this.store = new Store({
      name: 'folders',
      encryptionKey: 'covenantrix-folders-key-v1'
    });
    
    console.log('📁 FolderService initialized');
    this.initializeDefaultFolders();
  }

  initializeDefaultFolders() {
    const folders = this.store.get('folders', []);
    
    // Create default "All Documents" folder if no folders exist
    if (folders.length === 0) {
      const defaultFolder = {
        id: 'all-documents',
        name: 'All Documents',
        description: 'Default folder containing all documents',
        color: '#6366f1', // Default blue color
        createdAt: new Date().toISOString(),
        isDefault: true,
        documentCount: 0
      };
      
      this.store.set('folders', [defaultFolder]);
      console.log('📁 Created default folder: All Documents');
    }
  }

  // Get all folders
  getAllFolders() {
    const folders = this.store.get('folders', []);
    return folders.sort((a, b) => {
      // Default folder first, then alphabetically
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Get folder by ID
  getFolder(folderId) {
    const folders = this.getAllFolders();
    return folders.find(folder => folder.id === folderId);
  }

  // Create new folder
  createFolder(name, options = {}) {
    try {
      if (!name || name.trim().length === 0) {
        throw new Error('Folder name is required');
      }

      const folders = this.getAllFolders();
      
      // Check if folder name already exists
      if (folders.some(folder => folder.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Folder name already exists');
      }

      const newFolder = {
        id: uuidv4(),
        name: name.trim(),
        description: options.description || '',
        color: options.color || '#6366f1',
        createdAt: new Date().toISOString(),
        isDefault: false,
        documentCount: 0
      };

      folders.push(newFolder);
      this.store.set('folders', folders);
      
      console.log(`✅ Created folder: ${newFolder.name} (ID: ${newFolder.id})`);
      return { success: true, folder: newFolder };
    } catch (error) {
      console.error('❌ Error creating folder:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Update folder
  updateFolder(folderId, updates) {
    try {
      const folders = this.getAllFolders();
      const folderIndex = folders.findIndex(folder => folder.id === folderId);
      
      if (folderIndex === -1) {
        throw new Error('Folder not found');
      }

      const folder = folders[folderIndex];
      
      // Prevent updating default folder name or ID
      if (folder.isDefault && (updates.name || updates.id)) {
        throw new Error('Cannot modify default folder name or ID');
      }

      // Check for name conflicts if name is being updated
      if (updates.name && updates.name !== folder.name) {
        if (folders.some(f => f.id !== folderId && f.name.toLowerCase() === updates.name.toLowerCase())) {
          throw new Error('Folder name already exists');
        }
      }

      // Apply updates
      const updatedFolder = {
        ...folder,
        ...updates,
        id: folder.id, // Ensure ID doesn't change
        isDefault: folder.isDefault, // Ensure default status doesn't change
        updatedAt: new Date().toISOString()
      };

      folders[folderIndex] = updatedFolder;
      this.store.set('folders', folders);
      
      console.log(`✅ Updated folder: ${updatedFolder.name}`);
      return { success: true, folder: updatedFolder };
    } catch (error) {
      console.error('❌ Error updating folder:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Delete folder
  deleteFolder(folderId, targetFolderId = 'all-documents') {
    try {
      const folders = this.getAllFolders();
      const folder = folders.find(f => f.id === folderId);
      
      if (!folder) {
        throw new Error('Folder not found');
      }

      if (folder.isDefault) {
        throw new Error('Cannot delete default folder');
      }

      // Move documents to target folder (handled by DocumentService)
      const DocumentService = require('./documentService');
      const docService = new DocumentService();
      const moveResult = docService.moveDocumentsToFolder(folderId, targetFolderId);
      
      if (!moveResult.success) {
        throw new Error(`Failed to move documents: ${moveResult.error}`);
      }

      // Remove folder
      const updatedFolders = folders.filter(f => f.id !== folderId);
      this.store.set('folders', updatedFolders);
      
      console.log(`✅ Deleted folder: ${folder.name} (moved ${moveResult.movedCount} documents)`);
      return { 
        success: true, 
        deletedFolder: folder.name,
        movedDocuments: moveResult.movedCount 
      };
    } catch (error) {
      console.error('❌ Error deleting folder:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Update document count for folder
  updateFolderDocumentCount(folderId, count) {
    try {
      const folders = this.getAllFolders();
      const folderIndex = folders.findIndex(folder => folder.id === folderId);
      
      if (folderIndex >= 0) {
        folders[folderIndex].documentCount = count;
        folders[folderIndex].updatedAt = new Date().toISOString();
        this.store.set('folders', folders);
      }
    } catch (error) {
      console.error('❌ Error updating folder document count:', error);
    }
  }

  // Get folder statistics
  getFolderStats() {
    try {
      const folders = this.getAllFolders();
      const DocumentService = require('./documentService');
      const docService = new DocumentService();
      const allDocs = docService.getAllDocuments();
      
      // Update document counts
      folders.forEach(folder => {
        const docsInFolder = allDocs.filter(doc => 
          (doc.folderId || 'all-documents') === folder.id
        );
        folder.documentCount = docsInFolder.length;
      });
      
      // Save updated counts
      this.store.set('folders', folders);
      
      return {
        totalFolders: folders.length,
        totalDocuments: allDocs.length,
        folders: folders.map(folder => ({
          id: folder.id,
          name: folder.name,
          documentCount: folder.documentCount,
          isDefault: folder.isDefault
        }))
      };
    } catch (error) {
      console.error('❌ Error getting folder stats:', error);
      return { totalFolders: 0, totalDocuments: 0, folders: [] };
    }
  }

  // Validate folder exists
  validateFolder(folderId) {
    if (!folderId) return false;
    const folders = this.getAllFolders();
    return folders.some(folder => folder.id === folderId);
  }

  // Get default folder ID
  getDefaultFolderId() {
    return 'all-documents';
  }
}

module.exports = FolderService;
