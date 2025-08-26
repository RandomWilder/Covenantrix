const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');
const VectorService = require('./vectorService');
const OCRService = require('./ocrService');
const FolderService = require('./folderService');

class DocumentService {
  constructor(vectorService = null, ocrService = null, folderService = null) {
    // Initialize secure storage for documents metadata
    this.store = new Store({
      name: 'documents',
      encryptionKey: 'covenantrix-docs-key-v1'
    });
    
    // Get user data path for document storage
    const { app } = require('electron');
    this.documentsPath = path.join(app.getPath('userData'), 'documents');
    this.ensureDirectoryExists(this.documentsPath);
    
    // Use injected services or create new ones (backward compatibility)
    this.vectorService = vectorService || new VectorService();
    this.ocrService = ocrService || new OCRService();
    this.folderService = folderService || new FolderService();
    
    // Initialize vector service
    this.initializeServices();
    
    const injectionStatus = vectorService && ocrService ? '(injected)' : '(self-created)';
    console.log(`📄 DocumentService initialized with Phase 3 Hybrid OCR capabilities ${injectionStatus}`);
    console.log('📁 Documents stored at:', this.documentsPath);
  }

  async initializeServices() {
    try {
      await this.vectorService.initialize();
      await this.ocrService.autoInitialize();
      console.log('✅ Phase 3 services initialized (Google Vision OCR)');
    } catch (error) {
      console.error('⚠️ Error initializing Phase 3 services:', error);
    }
  }

  ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  async processDocument(filePath, fileName, progressCallback = null, folderId = null) {
    const documentId = uuidv4();
    console.log(`🔄 Processing document: ${fileName} (ID: ${documentId})`);
    
    // Validate folder or use default
    const targetFolderId = folderId && this.folderService.validateFolder(folderId) 
      ? folderId 
      : this.folderService.getDefaultFolderId();
    
    // Progress tracking setup
    const startTime = Date.now();
    const progressSteps = {
      'initializing': { progress: 5, message: 'Initializing document processing...' },
      'file_validation': { progress: 10, message: 'Validating file and preparing...' },
      'text_extraction': { progress: 40, message: 'Extracting text from document...' },
      'ocr_processing': { progress: 70, message: 'Processing with OCR (this may take a moment)...' },
      'document_analysis': { progress: 80, message: 'Analyzing document structure...' },
      'chunking': { progress: 85, message: 'Creating text chunks...' },
      'saving': { progress: 90, message: 'Saving processed document...' },
      'vectorizing': { progress: 95, message: 'Adding to semantic search database...' },
      'completed': { progress: 100, message: 'Document processing completed!' }
    };

    const reportProgress = (step, additionalInfo = {}) => {
      if (progressCallback) {
        const stepInfo = progressSteps[step];
        const elapsed = Date.now() - startTime;
        const estimatedTotal = stepInfo.progress > 0 ? (elapsed / stepInfo.progress) * 100 : elapsed * 2;
        const eta = Math.max(0, estimatedTotal - elapsed);
        
        progressCallback({
          documentId,
          fileName,
          step,
          progress: stepInfo.progress,
          message: stepInfo.message,
          elapsed,
          eta: eta > 1000 ? Math.round(eta / 1000) : 0, // ETA in seconds
          ...additionalInfo
        });
      }
    };

    reportProgress('initializing');
    
    // Handle Hebrew/Unicode filenames by copying to safe ASCII path
    let workingFilePath = filePath;
    let tempFilePath = null;
    
    try {
      const fileExt = path.extname(fileName).toLowerCase();
      console.log(`📄 File type: ${fileExt}, Size: ${fs.statSync(filePath).size} bytes`);
      
      reportProgress('file_validation', { fileSize: fs.statSync(filePath).size });

      // Check if filename contains non-ASCII characters that might cause issues
      const hasUnicodeChars = /[^\x00-\x7F]/.test(filePath);
      if (hasUnicodeChars) {
        console.log(`🔤 Unicode characters detected in file path, creating safe copy...`);
        tempFilePath = this.createSafeFilePath(filePath, documentId);
        await this.copyToSafePath(filePath, tempFilePath);
        workingFilePath = tempFilePath;
        console.log(`📁 Working with safe file path: ${path.basename(tempFilePath)}`);
      }
      
      // Read file buffer
      const buffer = fs.readFileSync(workingFilePath);
      
      let extractedText = '';
      let metadata = {
        id: documentId,
        originalName: fileName,
        fileSize: buffer.length,
        uploadedAt: new Date().toISOString(),
        fileType: fileExt,
        status: 'processing',
        processingSteps: [],
        hasUnicodeFilename: hasUnicodeChars,
        folderId: targetFolderId,
        folderName: this.folderService.getFolder(targetFolderId)?.name || 'All Documents'
      };

      // Extract text based on file type
      if (fileExt === '.pdf') {
        console.log(`📄 Starting PDF processing for ${fileName}...`);
        reportProgress('text_extraction', { stage: 'pdf_analysis' });
        metadata.processingSteps.push({ step: 'pdf_extraction_started', timestamp: new Date().toISOString() });
        
        const pdfResult = await this.extractTextFromPDF(buffer, workingFilePath, fileName, (ocrProgress) => {
          if (ocrProgress.isOCR) {
            reportProgress('ocr_processing', { 
              stage: 'ocr_active',
              pagesProcessed: ocrProgress.pagesProcessed || 0,
              totalPages: ocrProgress.totalPages || 1,
              currentPage: ocrProgress.currentPage || 1
            });
          }
        });
        metadata.processingSteps.push({ step: 'pdf_extraction_completed', timestamp: new Date().toISOString() });
        
        // Check if the result is an OCR result object or just text
        if (typeof pdfResult === 'object' && pdfResult.text) {
          // This is a scanned PDF that was processed with OCR
          extractedText = pdfResult.text;
          
          // Store comprehensive OCR metadata for scanned PDFs
          metadata.ocrConfidence = pdfResult.confidence;
          metadata.wordCount = pdfResult.wordCount;
          metadata.detectedLanguage = pdfResult.language;
          metadata.hasHebrew = pdfResult.language === 'hebrew';
          metadata.hasArabic = pdfResult.language === 'arabic';
          metadata.ocrEngine = pdfResult.engine;
          metadata.processingTime = pdfResult.processingTime;
          metadata.pagesProcessed = pdfResult.pagesProcessed;
          metadata.totalPages = pdfResult.totalPages;
          metadata.isScannedPDF = true;
          metadata.conversionTime = pdfResult.conversionTime;
          metadata.ocrTime = pdfResult.ocrTime;
          
          if (pdfResult.pageResults) {
            metadata.pageResults = pdfResult.pageResults.map(pr => ({
              pageNum: pr.pageNum,
              hasError: !!pr.error,
              error: pr.error,
              textLength: pr.result?.text?.length || 0,
              confidence: pr.result?.confidence || 0
            }));
          }
          
          console.log(`✅ Scanned PDF OCR processing completed for ${fileName}`);
          console.log(`📊 Engine: ${pdfResult.engine}, Confidence: ${pdfResult.confidence.toFixed(1)}%, Language: ${pdfResult.language}`);
          console.log(`⏱️ Processing: ${pdfResult.processingTime}ms total (${pdfResult.conversionTime}ms convert + ${pdfResult.ocrTime}ms OCR)`);
          console.log(`📄 Pages: ${pdfResult.pagesProcessed}/${pdfResult.totalPages} processed successfully`);
          
          if (pdfResult.language === 'hebrew') {
            console.log(`🔤 Hebrew text detected - enhanced processing enabled`);
          }
          
        } else if (typeof pdfResult === 'string') {
          // Regular PDF with embedded text
          extractedText = pdfResult;
          metadata.isScannedPDF = false;
          console.log(`📄 Standard PDF text extraction: ${extractedText.length} characters`);
        } else {
          throw new Error('Invalid PDF processing result');
        }
        
      } else if (this.isImageFile(fileName)) {
        // Process image files with Google Vision OCR
        console.log(`🖼️ Starting image OCR processing: ${fileName}`);
        reportProgress('ocr_processing', { stage: 'image_ocr' });
        metadata.processingSteps.push({ step: 'image_ocr_started', timestamp: new Date().toISOString() });
        
        try {
          const ocrResult = await this.ocrService.extractFromImage(workingFilePath);
          extractedText = ocrResult.text;
          metadata.processingSteps.push({ step: 'image_ocr_completed', timestamp: new Date().toISOString() });
          
          // Store comprehensive OCR metadata
          metadata.ocrConfidence = ocrResult.confidence;
          metadata.wordCount = ocrResult.wordCount;
          metadata.detectedLanguage = ocrResult.language;
          metadata.hasHebrew = ocrResult.language === 'hebrew';
          metadata.hasArabic = ocrResult.language === 'arabic';
          metadata.ocrEngine = ocrResult.engine;
          metadata.processingTime = ocrResult.processingTime;
          
          console.log(`✅ Image OCR processing completed for ${fileName}`);
          console.log(`📊 Engine: ${ocrResult.engine}, Confidence: ${ocrResult.confidence.toFixed(1)}%, Language: ${ocrResult.language}`);
          console.log(`📄 Extracted ${ocrResult.text.length} characters, ${ocrResult.wordCount} words`);
          
          if (ocrResult.language === 'hebrew') {
            console.log(`🔤 Hebrew text detected - enhanced processing enabled`);
          }
          
        } catch (ocrError) {
          console.error(`❌ OCR processing failed for ${fileName}:`, ocrError.message);
          metadata.processingSteps.push({ 
            step: 'image_ocr_failed', 
            timestamp: new Date().toISOString(), 
            error: ocrError.message 
          });
          
          // Fail fast instead of creating broken documents
          throw new Error(`Image OCR failed: ${ocrError.message}. Please ensure the image is clear and contains readable text.`);
        }
      } else {
        throw new Error(`Unsupported file type: ${fileExt}. Supported formats: PDF, PNG, JPG, JPEG, GIF, BMP, WEBP`);
      }

      // Validate extracted text
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text could be extracted from the document. The document may be empty or contain only images/graphics.');
      }

      console.log(`📝 Text extraction successful: ${extractedText.length} characters extracted`);

      // Document type detection and chunking
      reportProgress('document_analysis', { textLength: extractedText.length });
      console.log(`🔍 Analyzing document structure and preparing chunks...`);
      metadata.processingSteps.push({ step: 'chunking_started', timestamp: new Date().toISOString() });
      
      const documentType = this.detectDocumentType(extractedText);
      console.log(`📋 Document type detected: ${documentType}`);
      
      reportProgress('chunking', { documentType });
      const chunks = this.contractAwareChunking(extractedText, {
        chunkSize: 512,
        overlap: 50,
        documentType: documentType
      });
      
      metadata.processingSteps.push({ 
        step: 'chunking_completed', 
        timestamp: new Date().toISOString(),
        chunksCreated: chunks.length,
        documentType: documentType
      });

      console.log(`📝 Created ${chunks.length} chunks using ${documentType} strategy`);

      // Save extracted text and chunks
      reportProgress('saving', { chunksCount: chunks.length });
      console.log(`💾 Saving document data...`);
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      
      fs.writeFileSync(textFilePath, extractedText, 'utf-8');
      fs.writeFileSync(chunksFilePath, JSON.stringify(chunks, null, 2), 'utf-8');

      // Update metadata with final processing info
      metadata.status = 'ready';
      metadata.textLength = extractedText.length;
      metadata.chunksCount = chunks.length;
      metadata.documentType = documentType;
      metadata.processingCompletedAt = new Date().toISOString();

      // Store metadata before vector processing (in case vector processing fails)
      this.saveDocumentMetadata(documentId, metadata);
      metadata.processingSteps.push({ step: 'metadata_saved', timestamp: new Date().toISOString() });

      // Add to vector database for semantic search
      reportProgress('vectorizing', { chunksCount: chunks.length });
      console.log(`🧠 Adding to vector database...`);
      metadata.processingSteps.push({ step: 'vectorization_started', timestamp: new Date().toISOString() });
      
      try {
        await this.vectorService.addDocument(documentId, chunks, (vectorProgress) => {
          reportProgress('vectorizing', { 
            chunksProcessed: vectorProgress.processed || 0,
            totalChunks: vectorProgress.total || chunks.length,
            currentChunk: vectorProgress.current || 0
          });
        });
        metadata.vectorized = true;
        metadata.processingSteps.push({ step: 'vectorization_completed', timestamp: new Date().toISOString() });
        console.log(`✅ Added ${chunks.length} chunks to vector database`);
      } catch (vectorError) {
        console.warn('⚠️ Could not add to vector database:', vectorError.message);
        metadata.vectorized = false;
        metadata.vectorizationError = vectorError.message;
        metadata.processingSteps.push({ 
          step: 'vectorization_failed', 
          timestamp: new Date().toISOString(),
          error: vectorError.message
        });
      }

      // Update metadata with final vectorization status
      this.saveDocumentMetadata(documentId, metadata);

      console.log(`\n✅ Document processed successfully: ${fileName}`);
      console.log(`📊 Summary: ${extractedText.length} characters → ${chunks.length} chunks`);
      console.log(`🔤 Language: ${metadata.detectedLanguage || 'unknown'} | Type: ${documentType}`);
      console.log(`🧠 Vector database: ${metadata.vectorized ? '✅ Added' : '❌ Skipped'}`);
      
      if (metadata.hasHebrew) {
        console.log(`🔤 Hebrew processing: Successfully handled Hebrew content`);
      }

      // Report final completion
      reportProgress('completed', { 
        success: true,
        chunksCount: chunks.length,
        textLength: extractedText.length,
        documentType: documentType,
        language: metadata.detectedLanguage,
        vectorized: metadata.vectorized,
        processingTime: Date.now() - startTime
      });

      // Clean up temporary file if created
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          console.log(`🧹 Cleaned up temporary file: ${path.basename(tempFilePath)}`);
        } catch (cleanupError) {
          console.warn(`⚠️ Could not clean up temp file: ${cleanupError.message}`);
        }
      }

      return {
        success: true,
        document: metadata,
        chunksCount: chunks.length,
        textLength: extractedText.length,
        vectorized: metadata.vectorized,
        documentType: documentType,
        language: metadata.detectedLanguage
      };

    } catch (error) {
      console.error(`\n❌ Error processing document ${fileName}:`, error.message);
      console.error(`📄 Document ID: ${documentId}`);
      console.error(`🔍 Error details:`, error);
      
      // Try to save error metadata if possible
      try {
        const errorMetadata = {
          id: documentId,
          originalName: fileName,
          fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
          uploadedAt: new Date().toISOString(),
          fileType: path.extname(fileName).toLowerCase(),
          status: 'error',
          error: error.message,
          errorTimestamp: new Date().toISOString(),
          processingSteps: metadata?.processingSteps || []
        };
        
        // Add final error step
        errorMetadata.processingSteps.push({
          step: 'processing_failed',
          timestamp: new Date().toISOString(),
          error: error.message
        });
        
        this.saveDocumentMetadata(documentId, errorMetadata);
        console.log(`💾 Error metadata saved for debugging`);
      } catch (metadataError) {
        console.error(`⚠️ Could not save error metadata:`, metadataError.message);
      }

      // Clean up temporary file if created (even on error)
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          console.log(`🧹 Cleaned up temporary file after error: ${path.basename(tempFilePath)}`);
        } catch (cleanupError) {
          console.warn(`⚠️ Could not clean up temp file after error: ${cleanupError.message}`);
        }
      }
      
      return {
        success: false,
        error: error.message,
        documentId: documentId,
        fileName: fileName
      };
    }
  }

  async extractTextFromPDF(buffer, filePath, fileName, progressCallback = null) {
    try {
      // First, try standard PDF text extraction
      const data = await pdfParse(buffer);
      const extractedText = data.text.trim();
      
      console.log(`📄 PDF pages: ${data.numpages}, Text length: ${extractedText.length}`);
      
      // Smart OCR detection: Check if this is likely a scanned PDF
      const avgCharsPerPage = extractedText.length / data.numpages;
      const hasMinimalText = avgCharsPerPage < 150; // Increased threshold for Hebrew/Arabic
      const isLikelyScanned = hasMinimalText || this.containsGarbledText(extractedText);
      
      console.log(`📊 PDF Analysis: ${avgCharsPerPage.toFixed(1)} chars/page, scanned: ${isLikelyScanned}`);
      
      if (isLikelyScanned) {
        console.log(`🔍 Detected scanned PDF. Attempting Google Vision OCR...`);
        
        try {
          // Use Google Vision OCR for scanned PDFs
          const ocrResult = await this.ocrService.extractFromPDF(filePath, progressCallback);
          
          if (ocrResult && ocrResult.success && ocrResult.text && ocrResult.text.trim().length > 0) {
            console.log(`✅ PDF OCR successful: ${ocrResult.text.length} characters extracted`);
            console.log(`📊 OCR confidence: ${ocrResult.confidence.toFixed(1)}%, language: ${ocrResult.language}`);
            
            // Always prefer OCR results for scanned PDFs, even if shorter than original
            // (original might contain garbled extraction artifacts)
            return ocrResult; // Return the full OCR result object
          } else {
            console.warn('⚠️ PDF OCR returned no text, checking if original extraction has content');
            
            // If OCR failed but we have some original text, use it with a warning
            if (extractedText.length > 10) {
              console.log('📄 Using standard extraction with OCR failure notice');
              return extractedText + '\n\n[NOTE: This appears to be a scanned PDF. OCR processing failed but some text was extracted. Quality may be limited.]';
            } else {
              throw new Error('Both standard extraction and OCR failed to extract meaningful text');
            }
          }
        } catch (ocrError) {
          console.error('❌ PDF OCR failed:', ocrError.message);
          
          // If we have some standard text, use it; otherwise, fail
          if (extractedText.length > 10) {
            return extractedText + '\n\n[NOTE: This appears to be a scanned PDF. OCR processing failed. For better text extraction, try converting to high-quality images (PNG/JPG) and re-upload.]';
          } else {
            throw new Error(`PDF OCR failed and no standard text available: ${ocrError.message}`);
          }
        }
      }
      
      // Document has good standard text extraction
      console.log('✅ Using standard PDF text extraction');
      return extractedText;
      
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  // Helper method to detect garbled text that suggests scanning artifacts
  containsGarbledText(text) {
    if (!text || text.length < 20) return false;
    
    // Check for common PDF extraction artifacts
    const garbledPatterns = [
      /[�]{2,}/g, // Replacement characters
      /(.)\1{10,}/g, // Repeated single characters
      /^[\s\n\r]*$/g, // Only whitespace
      /[^\x00-\x7F\u0590-\u05FF\u0600-\u06FF\u0020-\u007E]{20,}/g // Long sequences of non-printable chars (excluding Hebrew/Arabic)
    ];
    
    return garbledPatterns.some(pattern => pattern.test(text));
  }



  detectDocumentType(text) {
    const englishLegalTerms = [
      'whereas', 'party', 'parties', 'agreement', 'contract', 'shall', 'herein',
      'liability', 'clause', 'provision', 'terms', 'conditions', 'jurisdiction',
      'breach', 'terminate', 'indemnify', 'covenant', 'consideration'
    ];
    
    // Hebrew legal terms (common in Israeli contracts)
    const hebrewLegalTerms = [
      'הסכם', 'חוזה', 'צד', 'צדדים', 'הצדדים', 'תנאי', 'תנאים', 'הוראות',
      'אחריות', 'חובות', 'זכויות', 'התחייבות', 'התחייבויות', 'סיום', 'ביטול',
      'פיצוי', 'פיצויים', 'שיפוי', 'נזק', 'נזקים', 'הפרה', 'מוסכם', 'בתוקף'
    ];
    
    const textLower = text.toLowerCase();
    const englishTermCount = englishLegalTerms.filter(term => textLower.includes(term)).length;
    const hebrewTermCount = hebrewLegalTerms.filter(term => text.includes(term)).length;
    
    // Check for legal document indicators
    if (englishTermCount >= 4 || hebrewTermCount >= 3) {
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
    
    // Split by sentences with comprehensive Hebrew, Arabic, and English punctuation support
    const sentences = text.split(/[.!?؟։។׃״׳]/).filter(s => s.trim().length > 0);
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

  async deleteDocument(documentId) {
    try {
      console.log(`🗑️ Deleting document: ${documentId}`);
      
      // Remove files
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      
      if (fs.existsSync(textFilePath)) {
        fs.unlinkSync(textFilePath);
        console.log(`✅ Removed text file: ${documentId}.txt`);
      }
      if (fs.existsSync(chunksFilePath)) {
        fs.unlinkSync(chunksFilePath);
        console.log(`✅ Removed chunks file: ${documentId}_chunks.json`);
      }

      // Remove from vector database
      try {
        await this.vectorService.removeDocument(documentId);
        console.log(`✅ Removed from vector database: ${documentId}`);
      } catch (vectorError) {
        console.warn(`⚠️ Could not remove from vector database: ${vectorError.message}`);
      }

      // Remove from metadata
      const documents = this.getAllDocuments();
      const updatedDocuments = documents.filter(doc => doc.id !== documentId);
      this.store.set('documents', updatedDocuments);
      
      console.log(`✅ Document ${documentId} deleted successfully`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting document: ${error.message}`);
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

  // OCR Service methods - simplified for clean implementation  
  async setGoogleVisionServiceAccount(serviceAccountPath) {
    return await this.ocrService.initialize(serviceAccountPath);
  }

  getOCRInfo() {
    return this.ocrService.getInfo();
  }

  isOCRReady() {
    return this.ocrService.isReady();
  }

  clearGoogleVisionServiceAccount() {
    this.ocrService.clearServiceAccount();
  }

  // Test OCR connection with a simple API call
  async testOCRConnection() {
    try {
      if (!this.ocrService.isReady()) {
        return {
          success: false,
          message: 'OCR service not initialized. Please configure Google Vision API first.'
        };
      }

      // Test with a simple API call to verify connectivity
      const testResult = await this.ocrService.testConnection();
      
      return {
        success: testResult.success,
        message: testResult.message || 'OCR connection test completed',
        details: testResult.details
      };
    } catch (error) {
      return {
        success: false,
        message: `OCR connection test failed: ${error.message}`
      };
    }
  }

  // Helper method to create safe ASCII file paths for processing
  createSafeFilePath(originalPath, documentId) {
    const ext = path.extname(originalPath);
    const tempDir = path.join(require('electron').app.getPath('temp'), 'contract-processing');
    
    // Ensure temp directory exists
    if (!require('fs').existsSync(tempDir)) {
      require('fs').mkdirSync(tempDir, { recursive: true });
    }
    
    // Create safe ASCII filename
    const safeFileName = `doc_${documentId}${ext}`;
    return path.join(tempDir, safeFileName);
  }

  // Copy file to safe path before processing
  async copyToSafePath(originalPath, safePath) {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      const readStream = fs.createReadStream(originalPath);
      const writeStream = fs.createWriteStream(safePath);
      
      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      
      readStream.pipe(writeStream);
    });
  }

  isImageFile(fileName) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const ext = path.extname(fileName).toLowerCase();
    return imageExtensions.includes(ext);
  }

  // 📁 FOLDER MANAGEMENT METHODS

  // Get documents by folder ID
  getDocumentsByFolder(folderId) {
    const documents = this.getAllDocuments();
    return documents.filter(doc => 
      (doc.folderId || this.folderService.getDefaultFolderId()) === folderId
    );
  }

  // Move document to different folder
  moveDocumentToFolder(documentId, targetFolderId) {
    try {
      // Validate target folder
      if (!this.folderService.validateFolder(targetFolderId)) {
        throw new Error('Target folder does not exist');
      }

      const documents = this.getAllDocuments();
      const docIndex = documents.findIndex(doc => doc.id === documentId);
      
      if (docIndex === -1) {
        throw new Error('Document not found');
      }

      const document = documents[docIndex];
      const oldFolderId = document.folderId || this.folderService.getDefaultFolderId();
      
      // Update document metadata
      documents[docIndex] = {
        ...document,
        folderId: targetFolderId,
        folderName: this.folderService.getFolder(targetFolderId)?.name || 'Unknown',
        movedAt: new Date().toISOString()
      };

      // Save updated documents
      this.store.set('documents', documents);
      
      console.log(`📁 Moved document "${document.originalName}" to folder: ${documents[docIndex].folderName}`);
      
      return {
        success: true,
        document: documents[docIndex],
        oldFolderId: oldFolderId,
        newFolderId: targetFolderId
      };
    } catch (error) {
      console.error('❌ Error moving document:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Move multiple documents to a folder (used when deleting folders)
  moveDocumentsToFolder(sourceFolderId, targetFolderId) {
    try {
      const documents = this.getAllDocuments();
      const documentsToMove = documents.filter(doc => 
        (doc.folderId || this.folderService.getDefaultFolderId()) === sourceFolderId
      );

      if (documentsToMove.length === 0) {
        return { success: true, movedCount: 0 };
      }

      // Validate target folder
      if (!this.folderService.validateFolder(targetFolderId)) {
        throw new Error('Target folder does not exist');
      }

      const targetFolder = this.folderService.getFolder(targetFolderId);
      let movedCount = 0;

      // Update each document
      const updatedDocuments = documents.map(doc => {
        if (documentsToMove.some(moveDoc => moveDoc.id === doc.id)) {
          movedCount++;
          return {
            ...doc,
            folderId: targetFolderId,
            folderName: targetFolder?.name || 'Unknown',
            movedAt: new Date().toISOString()
          };
        }
        return doc;
      });

      // Save updated documents
      this.store.set('documents', updatedDocuments);
      
      console.log(`📁 Moved ${movedCount} documents to folder: ${targetFolder?.name}`);
      
      return { success: true, movedCount: movedCount };
    } catch (error) {
      console.error('❌ Error moving documents:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Get folder statistics with document counts
  getFolderStatistics() {
    try {
      const documents = this.getAllDocuments();
      const folders = this.folderService.getAllFolders();
      
      const stats = folders.map(folder => {
        const docsInFolder = documents.filter(doc => 
          (doc.folderId || this.folderService.getDefaultFolderId()) === folder.id
        );
        
        return {
          ...folder,
          documentCount: docsInFolder.length,
          documents: docsInFolder.map(doc => ({
            id: doc.id,
            name: doc.originalName,
            uploadedAt: doc.uploadedAt,
            status: doc.status
          }))
        };
      });

      return { success: true, folders: stats };
    } catch (error) {
      console.error('❌ Error getting folder statistics:', error);
      return { success: false, error: error.message };
    }
  }

  // Search documents within specific folder
  async searchDocumentsInFolder(query, folderId, searchType = 'hybrid') {
    try {
      // Get all search results first
      const allResults = await this.searchDocuments(query, searchType);
      
      // Filter by folder
      const folderResults = allResults.filter(result => {
        const docFolderId = result.document.folderId || this.folderService.getDefaultFolderId();
        return docFolderId === folderId;
      });

      console.log(`🔍 Folder search "${query}" in folder ${folderId}: ${folderResults.length} results`);
      return folderResults;
    } catch (error) {
      console.error('❌ Error searching in folder:', error);
      return [];
    }
  }

  // 🎯 NEW: Search within a specific document only
  async searchInDocument(query, documentId, searchType = 'hybrid') {
    try {
      console.log(`🎯 Document-focused search: "${query}" in document ${documentId}`);
      
      // Get all search results first
      const allResults = await this.searchDocuments(query, searchType);
      
      // Debug: Log result structure to understand the issue
      if (allResults.length > 0) {
        console.log(`🔍 Debug - First result structure:`, {
          hasDocument: !!allResults[0].document,
          hasDocumentId: !!allResults[0].document_id,
          hasMetadata: !!allResults[0].metadata,
          documentId: allResults[0].document_id,
          metadataDocId: allResults[0].metadata?.document_id,
          documentObjectId: allResults[0].document?.id,
          targetDocumentId: documentId
        });
      }
      
      // Filter by specific document ID - fix the structure mismatch
      const documentResults = allResults.filter(result => {
        return result.document_id === documentId || 
               (result.document && result.document.id === documentId) ||
               (result.metadata && result.metadata.document_id === documentId);
      });

      console.log(`🎯 Document search "${query}" in document ${documentId}: ${documentResults.length} results`);
      
      // Fallback: If no document-specific results but we have general results, log this issue
      if (documentResults.length === 0 && allResults.length > 0) {
        console.warn(`⚠️ Document filtering failed - found ${allResults.length} general results but 0 document-specific results`);
        console.warn(`⚠️ Temporarily returning all results to maintain functionality while debugging`);
        // Temporary fallback to prevent complete failure
        return allResults.slice(0, 3); // Limit to 3 results as fallback
      }
      
      return documentResults;
    } catch (error) {
      console.error('❌ Error searching in document:', error);
      return [];
    }
  }

  // Migrate existing documents to default folder (for backward compatibility)
  migrateDocumentsToFolders() {
    try {
      const documents = this.getAllDocuments();
      const defaultFolderId = this.folderService.getDefaultFolderId();
      let migratedCount = 0;

      const updatedDocuments = documents.map(doc => {
        if (!doc.folderId) {
          migratedCount++;
          return {
            ...doc,
            folderId: defaultFolderId,
            folderName: 'All Documents',
            migratedAt: new Date().toISOString()
          };
        }
        return doc;
      });

      if (migratedCount > 0) {
        this.store.set('documents', updatedDocuments);
        console.log(`📁 Migrated ${migratedCount} documents to default folder`);
      }

      return { success: true, migratedCount: migratedCount };
    } catch (error) {
      console.error('❌ Error migrating documents:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Get all folder service methods (passthrough)
  getAllFolders() {
    return this.folderService.getAllFolders();
  }

  createFolder(name, options = {}) {
    return this.folderService.createFolder(name, options);
  }

  updateFolder(folderId, updates) {
    return this.folderService.updateFolder(folderId, updates);
  }

  deleteFolder(folderId, targetFolderId = null) {
    return this.folderService.deleteFolder(folderId, targetFolderId || this.folderService.getDefaultFolderId());
  }
}

module.exports = DocumentService;
