const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');

class DocumentService {
  constructor() {
    // Initialize secure storage for documents metadata
    this.store = new Store({
      name: 'documents',
      encryptionKey: 'covenantrix-docs-key-v1'
    });
    
    // Get user data path for document storage
    const { app } = require('electron');
    this.documentsPath = path.join(app.getPath('userData'), 'documents');
    this.ensureDirectoryExists(this.documentsPath);
    
    console.log('📄 DocumentService initialized');
    console.log('📁 Documents stored at:', this.documentsPath);
  }

  ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  async processDocument(filePath, fileName) {
    try {
      console.log(`🔄 Processing document: ${fileName}`);
      
      const documentId = uuidv4();
      const fileExt = path.extname(fileName).toLowerCase();
      
      // Read file buffer
      const buffer = fs.readFileSync(filePath);
      
      let extractedText = '';
      let metadata = {
        id: documentId,
        originalName: fileName,
        fileSize: buffer.length,
        uploadedAt: new Date().toISOString(),
        fileType: fileExt,
        status: 'processing'
      };

      // Extract text based on file type
      if (fileExt === '.pdf') {
        extractedText = await this.extractTextFromPDF(buffer);
      } else {
        throw new Error(`Unsupported file type: ${fileExt}`);
      }

      // Basic text chunking
      const chunks = this.chunkText(extractedText, {
        chunkSize: 512,
        overlap: 50
      });

      // Save extracted text and chunks
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      
      fs.writeFileSync(textFilePath, extractedText, 'utf-8');
      fs.writeFileSync(chunksFilePath, JSON.stringify(chunks, null, 2), 'utf-8');

      // Update metadata
      metadata.status = 'ready';
      metadata.textLength = extractedText.length;
      metadata.chunksCount = chunks.length;
      metadata.processingCompletedAt = new Date().toISOString();

      // Store metadata
      this.saveDocumentMetadata(documentId, metadata);

      console.log(`✅ Document processed successfully: ${fileName}`);
      console.log(`📊 Extracted ${extractedText.length} characters, created ${chunks.length} chunks`);

      return {
        success: true,
        document: metadata,
        chunksCount: chunks.length,
        textLength: extractedText.length
      };

    } catch (error) {
      console.error('❌ Error processing document:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractTextFromPDF(buffer) {
    try {
      const data = await pdfParse(buffer);
      return data.text;
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  chunkText(text, options = {}) {
    const { chunkSize = 512, overlap = 50 } = options;
    const chunks = [];
    
    // Simple sentence-aware chunking
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    let currentChunk = '';
    let chunkId = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim() + '.';
      
      // If adding this sentence would exceed chunk size
      if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          id: chunkId++,
          text: currentChunk.trim(),
          length: currentChunk.length,
          sentenceStart: Math.max(0, i - Math.floor(currentChunk.split('.').length / 2)),
          sentenceEnd: i - 1
        });

        // Start new chunk with overlap
        const overlapSentences = Math.floor(overlap / 50); // Rough estimate
        const startIndex = Math.max(0, i - overlapSentences);
        currentChunk = sentences.slice(startIndex, i + 1).join('. ') + '.';
      } else {
        // Add sentence to current chunk
        currentChunk += (currentChunk.length > 0 ? ' ' : '') + sentence;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim().length > 0) {
      chunks.push({
        id: chunkId++,
        text: currentChunk.trim(),
        length: currentChunk.length,
        sentenceStart: Math.max(0, sentences.length - Math.floor(currentChunk.split('.').length)),
        sentenceEnd: sentences.length - 1
      });
    }

    return chunks;
  }

  saveDocumentMetadata(documentId, metadata) {
    const documents = this.store.get('documents', []);
    const existingIndex = documents.findIndex(doc => doc.id === documentId);
    
    if (existingIndex >= 0) {
      documents[existingIndex] = metadata;
    } else {
      documents.push(metadata);
    }
    
    this.store.set('documents', documents);
  }

  getAllDocuments() {
    return this.store.get('documents', []);
  }

  getDocument(documentId) {
    const documents = this.getAllDocuments();
    return documents.find(doc => doc.id === documentId);
  }

  getDocumentText(documentId) {
    try {
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      return fs.readFileSync(textFilePath, 'utf-8');
    } catch (error) {
      console.error(`Error reading document text: ${error.message}`);
      return null;
    }
  }

  getDocumentChunks(documentId) {
    try {
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      const chunksData = fs.readFileSync(chunksFilePath, 'utf-8');
      return JSON.parse(chunksData);
    } catch (error) {
      console.error(`Error reading document chunks: ${error.message}`);
      return [];
    }
  }

  deleteDocument(documentId) {
    try {
      // Remove files
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      
      if (fs.existsSync(textFilePath)) fs.unlinkSync(textFilePath);
      if (fs.existsSync(chunksFilePath)) fs.unlinkSync(chunksFilePath);

      // Remove from metadata
      const documents = this.getAllDocuments();
      const updatedDocuments = documents.filter(doc => doc.id !== documentId);
      this.store.set('documents', updatedDocuments);

      return true;
    } catch (error) {
      console.error(`Error deleting document: ${error.message}`);
      return false;
    }
  }

  // Basic search functionality for Phase 1
  searchDocuments(query) {
    const documents = this.getAllDocuments();
    const results = [];

    documents.forEach(doc => {
      if (doc.status !== 'ready') return;

      const chunks = this.getDocumentChunks(doc.id);
      const matchingChunks = chunks.filter(chunk => 
        chunk.text.toLowerCase().includes(query.toLowerCase())
      );

      if (matchingChunks.length > 0) {
        results.push({
          document: doc,
          matches: matchingChunks.length,
          chunks: matchingChunks.slice(0, 3) // Top 3 matches
        });
      }
    });

    return results.sort((a, b) => b.matches - a.matches);
  }
}

module.exports = DocumentService;
