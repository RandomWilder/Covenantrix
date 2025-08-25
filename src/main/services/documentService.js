const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');
const VectorService = require('./vectorService');
const OCRService = require('./ocrService');

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
    
    // Initialize Phase 2 services
    this.vectorService = new VectorService();
    this.ocrService = new OCRService();
    
    // Initialize vector service
    this.initializeServices();
    
    console.log('📄 DocumentService initialized with Phase 2 capabilities');
    console.log('📁 Documents stored at:', this.documentsPath);
  }

  async initializeServices() {
    try {
      await this.vectorService.initialize();
      await this.ocrService.initialize();
      console.log('✅ Phase 2 services initialized');
    } catch (error) {
      console.error('⚠️ Error initializing Phase 2 services:', error);
    }
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
        extractedText = await this.extractTextFromPDF(buffer, filePath, fileName);
      } else if (this.ocrService.isImageFile(fileName)) {
        // Process image files with enhanced multi-language OCR
        const ocrResult = await this.ocrService.extractTextFromImage(filePath);
        extractedText = this.ocrService.cleanContractText(ocrResult.text, ocrResult.detectedLanguage);
        
        // Store OCR metadata including language detection
        metadata.ocrConfidence = ocrResult.confidence;
        metadata.wordCount = ocrResult.wordCount;
        metadata.detectedLanguage = ocrResult.detectedLanguage;
        metadata.hasHebrew = ocrResult.hasHebrew;
        metadata.hasArabic = ocrResult.hasArabic;
      } else {
        throw new Error(`Unsupported file type: ${fileExt}`);
      }

      // Enhanced contract-aware chunking
      const chunks = this.contractAwareChunking(extractedText, {
        chunkSize: 512,
        overlap: 50,
        documentType: this.detectDocumentType(extractedText)
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

      // Add to vector database for semantic search
      try {
        await this.vectorService.addDocument(documentId, chunks);
        metadata.vectorized = true;
      } catch (error) {
        console.warn('⚠️ Could not add to vector database:', error.message);
        metadata.vectorized = false;
      }

      console.log(`✅ Document processed successfully: ${fileName}`);
      console.log(`📊 Extracted ${extractedText.length} characters, created ${chunks.length} chunks`);
      console.log(`🧠 Vector database: ${metadata.vectorized ? 'Added' : 'Skipped'}`);

      return {
        success: true,
        document: metadata,
        chunksCount: chunks.length,
        textLength: extractedText.length,
        vectorized: metadata.vectorized
      };

    } catch (error) {
      console.error('❌ Error processing document:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractTextFromPDF(buffer, filePath, fileName) {
    try {
      // First, try standard PDF text extraction
      const data = await pdfParse(buffer);
      const extractedText = data.text;
      
      console.log(`📄 PDF pages: ${data.numpages}, Text length: ${extractedText.length}`);
      
      // Check if this is likely a scanned PDF (very little text per page)
      const avgCharsPerPage = extractedText.length / data.numpages;
      const isLikelyScanned = avgCharsPerPage < 100; // Less than 100 characters per page suggests scanned PDF
      
      if (isLikelyScanned && extractedText.length < 200) {
        console.log(`🔍 Detected scanned PDF (${avgCharsPerPage.toFixed(1)} chars/page). Attempting OCR...`);
        
        try {
          // For scanned PDFs, we need to convert to images and OCR
          // Since we don't have pdf-to-image converter yet, let's provide better error message
          console.log('⚠️ Scanned PDF detected but PDF-to-image conversion not yet implemented');
          console.log('💡 To process this Hebrew document, please convert it to images (PNG/JPG) and re-upload');
          
          return extractedText + '\n\n[NOTE: This appears to be a scanned PDF. For better text extraction, please convert to image format and re-upload.]';
        } catch (ocrError) {
          console.error('❌ OCR fallback failed:', ocrError);
          return extractedText;
        }
      }
      
      return extractedText;
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  detectDocumentType(text) {
    const legalTerms = [
      'whereas', 'party', 'parties', 'agreement', 'contract', 'shall', 'herein',
      'liability', 'clause', 'provision', 'terms', 'conditions', 'jurisdiction',
      'breach', 'terminate', 'indemnify', 'covenant', 'consideration'
    ];
    
    const textLower = text.toLowerCase();
    const legalTermCount = legalTerms.filter(term => textLower.includes(term)).length;
    
    if (legalTermCount >= 5) {
      return 'legal_contract';
    } else if (textLower.includes('assignment') && textLower.includes('manager')) {
      return 'assignment';
    } else {
      return 'general';
    }
  }

  contractAwareChunking(text, options = {}) {
    const { chunkSize = 512, overlap = 50, documentType = 'general' } = options;
    const chunks = [];
    
    if (documentType === 'legal_contract') {
      return this.legalContractChunking(text, chunkSize, overlap);
    } else {
      return this.semanticChunking(text, chunkSize, overlap);
    }
  }

  legalContractChunking(text, chunkSize, overlap) {
    const chunks = [];
    
    // Split by common legal document structure
    const sections = text.split(/(?=\b(?:WHEREAS|THEREFORE|NOW THEREFORE|ARTICLE|SECTION|\d+\.)\b)/i);
    
    let chunkId = 0;
    
    for (let section of sections) {
      section = section.trim();
      if (section.length === 0) continue;
      
      if (section.length <= chunkSize) {
        // Small section - use as single chunk
        chunks.push({
          id: chunkId++,
          text: section,
          length: section.length,
          type: 'legal_section',
          metadata: this.extractLegalMetadata(section)
        });
      } else {
        // Large section - split further
        const subChunks = this.semanticChunking(section, chunkSize, overlap);
        subChunks.forEach(chunk => {
          chunks.push({
            ...chunk,
            id: chunkId++,
            type: 'legal_subsection',
            metadata: this.extractLegalMetadata(chunk.text)
          });
        });
      }
    }
    
    return chunks;
  }

  extractLegalMetadata(text) {
    const metadata = {};
    const textLower = text.toLowerCase();
    
    // Detect parties
    const partyMatches = text.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)*(?:,? (?:Inc|LLC|Corp|Company|Ltd))?)(?= shall| agrees?| hereby)/g);
    if (partyMatches) {
      metadata.parties = [...new Set(partyMatches)];
    }
    
    // Detect clause types
    if (textLower.includes('termination') || textLower.includes('terminate')) {
      metadata.clauseType = 'termination';
    } else if (textLower.includes('payment') || textLower.includes('compensation')) {
      metadata.clauseType = 'payment';
    } else if (textLower.includes('liability') || textLower.includes('indemnif')) {
      metadata.clauseType = 'liability';
    } else if (textLower.includes('confidential') || textLower.includes('non-disclosure')) {
      metadata.clauseType = 'confidentiality';
    }
    
    // Detect dates
    const dateMatches = text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g);
    if (dateMatches) {
      metadata.dates = dateMatches;
    }
    
    return metadata;
  }

  semanticChunking(text, chunkSize, overlap) {
    const chunks = [];
    
    // Handle very short text (less than minimum chunk size)
    if (text.trim().length < 50) {
      if (text.trim().length > 0) {
        chunks.push({
          id: 0,
          text: text.trim(),
          length: text.trim().length,
          sentenceStart: 0,
          sentenceEnd: 0,
          type: 'short_text'
        });
      }
      return chunks;
    }
    
    // Split by sentences with Hebrew and English punctuation support
    const sentences = text.split(/[.!?؟։។]|\.|\?|\!/).filter(s => s.trim().length > 0);
    let currentChunk = '';
    let chunkId = 0;
    
    console.log(`📝 Chunking: ${sentences.length} sentences found`);

    // If no sentences detected, create chunks by word count or character limit
    if (sentences.length === 0 || (sentences.length === 1 && sentences[0].trim().length === 0)) {
      const words = text.split(/\s+/).filter(w => w.trim().length > 0);
      if (words.length > 0) {
        chunks.push({
          id: 0,
          text: text.trim(),
          length: text.trim().length,
          sentenceStart: 0,
          sentenceEnd: 0,
          type: 'no_sentences_detected'
        });
      }
      return chunks;
    }

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
          sentenceEnd: i - 1,
          type: 'semantic'
        });

        // Start new chunk with overlap
        const overlapSentences = Math.floor(overlap / 50);
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
        sentenceEnd: sentences.length - 1,
        type: 'semantic'
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

  // Enhanced search functionality for Phase 2
  async searchDocuments(query, searchType = 'hybrid') {
    try {
      if (searchType === 'semantic') {
        return await this.semanticSearch(query);
      } else if (searchType === 'keyword') {
        return this.keywordSearch(query);
      } else {
        return await this.hybridSearch(query);
      }
    } catch (error) {
      console.error('❌ Error in searchDocuments:', error);
      // Fallback to keyword search
      return this.keywordSearch(query);
    }
  }

  keywordSearch(query) {
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
          chunks: matchingChunks.slice(0, 3),
          searchType: 'keyword'
        });
      }
    });

    return results.sort((a, b) => b.matches - a.matches);
  }

  async semanticSearch(query) {
    try {
      const vectorResults = await this.vectorService.semanticSearch(query, 10);
      const documents = this.getAllDocuments();
      const results = [];

      // Group results by document
      const docGroups = {};
      vectorResults.forEach(result => {
        if (!docGroups[result.document_id]) {
          docGroups[result.document_id] = {
            chunks: [],
            totalSimilarity: 0
          };
        }
        docGroups[result.document_id].chunks.push({
          text: result.text,
          similarity: result.similarity,
          metadata: result.metadata
        });
        docGroups[result.document_id].totalSimilarity += result.similarity;
      });

      // Format results
      Object.entries(docGroups).forEach(([docId, group]) => {
        const document = documents.find(doc => doc.id === docId);
        if (document) {
          results.push({
            document,
            matches: group.chunks.length,
            chunks: group.chunks.slice(0, 3),
            avgSimilarity: group.totalSimilarity / group.chunks.length,
            searchType: 'semantic'
          });
        }
      });

      return results.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
    } catch (error) {
      console.error('❌ Semantic search failed:', error);
      return this.keywordSearch(query);
    }
  }

  async hybridSearch(query) {
    try {
      // Get both semantic and keyword results
      const [semanticResults, keywordResults] = await Promise.all([
        this.semanticSearch(query),
        this.keywordSearch(query)
      ]);

      // Combine and deduplicate results
      const combinedResults = new Map();

      // Add semantic results with higher weight
      semanticResults.forEach(result => {
        combinedResults.set(result.document.id, {
          ...result,
          score: (result.avgSimilarity || 0) * 0.7,
          searchType: 'hybrid'
        });
      });

      // Add keyword results with lower weight, merge if exists
      keywordResults.forEach(result => {
        const existing = combinedResults.get(result.document.id);
        if (existing) {
          existing.score += (result.matches / 10) * 0.3;
          existing.chunks = [...existing.chunks, ...result.chunks].slice(0, 3);
        } else {
          combinedResults.set(result.document.id, {
            ...result,
            score: (result.matches / 10) * 0.3,
            searchType: 'hybrid'
          });
        }
      });

      return Array.from(combinedResults.values()).sort((a, b) => b.score - a.score);
    } catch (error) {
      console.error('❌ Hybrid search failed:', error);
      return this.keywordSearch(query);
    }
  }

  // API key management methods
  async setOpenAIApiKey(apiKey) {
    return await this.vectorService.setupOpenAI(apiKey);
  }

  getStoredApiKey() {
    return this.vectorService.getStoredApiKey();
  }

  clearApiKey() {
    this.vectorService.clearApiKey();
  }

  async getVectorStats() {
    return await this.vectorService.getStats();
  }
}

module.exports = DocumentService;
