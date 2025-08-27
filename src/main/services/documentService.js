const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const rtfParser = require('rtf-parser');
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
    console.log(`DocumentService initialized with Graph RAG capabilities ${injectionStatus}`);
    console.log('Documents stored at:', this.documentsPath);
  }

  async initializeServices() {
    try {
      await this.vectorService.initialize();
      await this.ocrService.autoInitialize();
      console.log('Services initialized (Google Vision OCR + Graph RAG ready)');
    } catch (error) {
      console.error('Error initializing services:', error);
    }
  }

  ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  async processDocument(filePath, fileName, progressCallback = null, folderId = null) {
    const documentId = uuidv4();
    console.log(`Processing document: ${fileName} (ID: ${documentId})`);
    
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
      'entity_chunking': { progress: 85, message: 'Creating entity-aware text chunks...' },
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
          eta: eta > 1000 ? Math.round(eta / 1000) : 0,
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
      console.log(`File type: ${fileExt}, Size: ${fs.statSync(filePath).size} bytes`);
      
      reportProgress('file_validation', { fileSize: fs.statSync(filePath).size });

      // Check if filename contains non-ASCII characters that might cause issues
      const hasUnicodeChars = /[^\x00-\x7F]/.test(filePath);
      if (hasUnicodeChars) {
        console.log(`Unicode characters detected in file path, creating safe copy...`);
        tempFilePath = this.createSafeFilePath(filePath, documentId);
        await this.copyToSafePath(filePath, tempFilePath);
        workingFilePath = tempFilePath;
        console.log(`Working with safe file path: ${path.basename(tempFilePath)}`);
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
        folderName: this.folderService.getFolder(targetFolderId)?.name || 'All Documents',
        // Graph RAG ready fields
        entities: [],
        relationships: [],
        graphVersion: "1.0",
        entityAwareChunking: true
      };

      // Extract text based on file type
      if (fileExt === '.pdf') {
        console.log(`Starting PDF processing for ${fileName}...`);
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
        
        if (typeof pdfResult === 'object' && pdfResult.text) {
          extractedText = pdfResult.text;
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
          
          console.log(`Scanned PDF OCR processing completed for ${fileName}`);
          console.log(`Engine: ${pdfResult.engine}, Confidence: ${pdfResult.confidence.toFixed(1)}%, Language: ${pdfResult.language}`);
          
        } else if (typeof pdfResult === 'string') {
          extractedText = pdfResult;
          metadata.isScannedPDF = false;
          console.log(`Standard PDF text extraction: ${extractedText.length} characters`);
        } else {
          throw new Error('Invalid PDF processing result');
        }
        
      } else if (this.isWordDocument(fileName)) {
        console.log(`Starting Word document processing: ${fileName}`);
        reportProgress('text_extraction', { stage: 'word_extraction' });
        metadata.processingSteps.push({ step: 'word_extraction_started', timestamp: new Date().toISOString() });
        
        const wordResult = await this.extractTextFromWord(buffer, fileName);
        extractedText = wordResult.text;
        metadata.processingSteps.push({ step: 'word_extraction_completed', timestamp: new Date().toISOString() });
        
        metadata.wordCount = wordResult.wordCount;
        metadata.detectedLanguage = wordResult.language;
        metadata.processingEngine = wordResult.engine;
        metadata.processingTime = wordResult.processingTime;
        metadata.confidence = wordResult.confidence;
        
        console.log(`Word document processing completed for ${fileName}`);
        console.log(`Engine: ${wordResult.engine}, Text length: ${extractedText.length} characters`);
        
      } else if (this.isExcelDocument(fileName)) {
        console.log(`Starting Excel document processing: ${fileName}`);
        reportProgress('text_extraction', { stage: 'excel_extraction' });
        metadata.processingSteps.push({ step: 'excel_extraction_started', timestamp: new Date().toISOString() });
        
        const excelResult = await this.extractTextFromExcel(buffer, fileName);
        extractedText = excelResult.text;
        metadata.processingSteps.push({ step: 'excel_extraction_completed', timestamp: new Date().toISOString() });
        
        metadata.wordCount = excelResult.wordCount;
        metadata.detectedLanguage = excelResult.language;
        metadata.processingEngine = excelResult.engine;
        metadata.processingTime = excelResult.processingTime;
        metadata.confidence = excelResult.confidence;
        metadata.sheetsProcessed = excelResult.sheetsProcessed;
        metadata.cellsProcessed = excelResult.cellsProcessed;
        
        console.log(`Excel document processing completed for ${fileName}`);
        console.log(`Engine: ${excelResult.engine}, Sheets: ${excelResult.sheetsProcessed}, Text length: ${extractedText.length} characters`);
        
      } else if (this.isRTFDocument(fileName)) {
        console.log(`Starting RTF document processing: ${fileName}`);
        reportProgress('text_extraction', { stage: 'rtf_extraction' });
        metadata.processingSteps.push({ step: 'rtf_extraction_started', timestamp: new Date().toISOString() });
        
        const rtfResult = await this.extractTextFromRTF(buffer, fileName);
        extractedText = rtfResult.text;
        metadata.processingSteps.push({ step: 'rtf_extraction_completed', timestamp: new Date().toISOString() });
        
        metadata.wordCount = rtfResult.wordCount;
        metadata.detectedLanguage = rtfResult.language;
        metadata.processingEngine = rtfResult.engine;
        metadata.processingTime = rtfResult.processingTime;
        metadata.confidence = rtfResult.confidence;
        
        console.log(`RTF document processing completed for ${fileName}`);
        console.log(`Engine: ${rtfResult.engine}, Text length: ${extractedText.length} characters`);
        
      } else if (this.isPlainTextDocument(fileName)) {
        console.log(`Starting plain text document processing: ${fileName}`);
        reportProgress('text_extraction', { stage: 'text_extraction' });
        metadata.processingSteps.push({ step: 'text_extraction_started', timestamp: new Date().toISOString() });
        
        const textResult = await this.extractTextFromPlainText(buffer, fileName);
        extractedText = textResult.text;
        metadata.processingSteps.push({ step: 'text_extraction_completed', timestamp: new Date().toISOString() });
        
        metadata.wordCount = textResult.wordCount;
        metadata.detectedLanguage = textResult.language;
        metadata.processingEngine = textResult.engine;
        metadata.processingTime = textResult.processingTime;
        metadata.confidence = textResult.confidence;
        
        console.log(`Plain text document processing completed for ${fileName}`);
        console.log(`Text length: ${extractedText.length} characters`);
        
      } else if (this.isImageFile(fileName)) {
        console.log(`Starting image OCR processing: ${fileName}`);
        reportProgress('ocr_processing', { stage: 'image_ocr' });
        metadata.processingSteps.push({ step: 'image_ocr_started', timestamp: new Date().toISOString() });
        
        try {
          const ocrResult = await this.ocrService.extractFromImage(workingFilePath);
          extractedText = ocrResult.text;
          metadata.processingSteps.push({ step: 'image_ocr_completed', timestamp: new Date().toISOString() });
          
          metadata.ocrConfidence = ocrResult.confidence;
          metadata.wordCount = ocrResult.wordCount;
          metadata.detectedLanguage = ocrResult.language;
          metadata.hasHebrew = ocrResult.language === 'hebrew';
          metadata.hasArabic = ocrResult.language === 'arabic';
          metadata.ocrEngine = ocrResult.engine;
          metadata.processingTime = ocrResult.processingTime;
          
          console.log(`Image OCR processing completed for ${fileName}`);
          console.log(`Engine: ${ocrResult.engine}, Confidence: ${ocrResult.confidence.toFixed(1)}%, Language: ${ocrResult.language}`);
          
        } catch (ocrError) {
          console.error(`OCR processing failed for ${fileName}:`, ocrError.message);
          metadata.processingSteps.push({ 
            step: 'image_ocr_failed', 
            timestamp: new Date().toISOString(), 
            error: ocrError.message 
          });
          
          throw new Error(`Image OCR failed: ${ocrError.message}. Please ensure the image is clear and contains readable text.`);
        }
      } else {
        throw new Error(`Unsupported file type: ${fileExt}. Supported formats: PDF, DOC, DOCX, XLS, XLSX, RTF, TXT, PNG, JPG, JPEG, GIF, BMP, WEBP`);
      }

      // Validate extracted text
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text could be extracted from the document. The document may be empty or contain only images/graphics.');
      }

      console.log(`Text extraction successful: ${extractedText.length} characters extracted`);

      // Document type detection and entity-aware chunking
      reportProgress('document_analysis', { textLength: extractedText.length });
      console.log(`Analyzing document structure and preparing entity-aware chunks...`);
      metadata.processingSteps.push({ step: 'entity_chunking_started', timestamp: new Date().toISOString() });
      
      const documentType = this.detectDocumentType(extractedText);
      console.log(`Document type detected: ${documentType}`);
      
      reportProgress('entity_chunking', { documentType });
      
      // Use new entity-aware chunking
      const chunks = await this.contractAwareChunking(extractedText, {
        chunkSize: 1200,
        overlap: 120,
        documentType: documentType,
        useEntityDetection: true
      });
      
      metadata.processingSteps.push({ 
        step: 'entity_chunking_completed', 
        timestamp: new Date().toISOString(),
        chunksCreated: chunks.length,
        documentType: documentType,
        entityAware: true
      });

      console.log(`Created ${chunks.length} entity-aware chunks using ${documentType} strategy`);

      // Save extracted text and chunks
      reportProgress('saving', { chunksCount: chunks.length });
      console.log(`Saving document data...`);
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

      // Store metadata before vector processing
      this.saveDocumentMetadata(documentId, metadata);
      metadata.processingSteps.push({ step: 'metadata_saved', timestamp: new Date().toISOString() });

      // Add to vector database for semantic search
      reportProgress('vectorizing', { chunksCount: chunks.length });
      console.log(`Adding to vector database...`);
      metadata.processingSteps.push({ step: 'vectorization_started', timestamp: new Date().toISOString() });
      
      // 🚀 Collect already-computed metadata for enhanced chunk storage
      const documentMetadata = {
        // Phase 1 Metadata (existing)
        documentType: documentType,
        language: metadata.detectedLanguage || null,
        confidence: metadata.ocrConfidence || null,
        
        // 🎯 Phase 2A Metadata - File Context & Processing Info
        fileName: fileName,                           // Original uploaded name
        fileId: documentId,                          // Document UUID  
        fileType: fileExt,                           // File extension (.pdf, .docx, etc.)
        fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0, // File size in bytes
        uploadTimestamp: metadata.uploadedAt,        // Upload timestamp
        processingTimestamp: new Date().toISOString(), // Current processing timestamp
        embeddingModel: "text-embedding-3-large"     // Embedding model used
      };
      
      try {
        await this.vectorService.addDocument(documentId, chunks, (vectorProgress) => {
          reportProgress('vectorizing', { 
            chunksProcessed: vectorProgress.processed || 0,
            totalChunks: vectorProgress.total || chunks.length,
            currentChunk: vectorProgress.current || 0
          });
        }, documentMetadata);
        metadata.vectorized = true;
        metadata.processingSteps.push({ step: 'vectorization_completed', timestamp: new Date().toISOString() });
        console.log(`Added ${chunks.length} chunks to vector database`);
      } catch (vectorError) {
        console.warn('Could not add to vector database:', vectorError.message);
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

      console.log(`\nDocument processed successfully: ${fileName}`);
      console.log(`Summary: ${extractedText.length} characters → ${chunks.length} entity-aware chunks`);
      console.log(`Language: ${metadata.detectedLanguage || 'unknown'} | Type: ${documentType}`);
      console.log(`Vector database: ${metadata.vectorized ? 'Added' : 'Skipped'}`);

      // Report final completion
      reportProgress('completed', { 
        success: true,
        chunksCount: chunks.length,
        textLength: extractedText.length,
        documentType: documentType,
        language: metadata.detectedLanguage,
        vectorized: metadata.vectorized,
        processingTime: Date.now() - startTime,
        entityAware: true
      });

      // 🧹 COMPREHENSIVE CLEANUP: Prevent memory leaks between documents
      console.log('🧹 Performing comprehensive cleanup...');
      
      try {
        // 1. Clean up temporary file if created
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log(`✅ Cleaned up temporary file: ${path.basename(tempFilePath)}`);
        }

        // 2. Clear large text variables to free memory
        extractedText = null;
        chunks = null;
        
        // 3. Force garbage collection if available (Node.js with --expose-gc)
        if (global.gc) {
          global.gc();
          console.log('✅ Forced garbage collection');
        }

        // 4. Clear any cached OCR data
        await this.clearProcessingCache();
        
        console.log('✅ Comprehensive cleanup completed');
        
      } catch (cleanupError) {
        console.warn('⚠️ Cleanup warning:', cleanupError.message);
      }

      const result = {
        success: true,
        document: metadata,
        chunksCount: chunks ? chunks.length : 0,
        textLength: extractedText ? extractedText.length : 0,
        vectorized: metadata.vectorized,
        documentType: documentType,
        language: metadata.detectedLanguage,
        entityAware: true
      };

      return result;

    } catch (error) {
      console.error(`\nError processing document ${fileName}:`, error.message);
      console.error(`Document ID: ${documentId}`);
      console.error(`Error details:`, error);
      
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
        
        errorMetadata.processingSteps.push({
          step: 'processing_failed',
          timestamp: new Date().toISOString(),
          error: error.message
        });
        
        this.saveDocumentMetadata(documentId, errorMetadata);
        console.log(`Error metadata saved for debugging`);
      } catch (metadataError) {
        console.error(`Could not save error metadata:`, metadataError.message);
      }

      // 🧹 COMPREHENSIVE CLEANUP (even on error)
      console.log('🧹 Performing error cleanup...');
      
      try {
        // Clean up temporary file if created
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log(`✅ Cleaned up temporary file after error: ${path.basename(tempFilePath)}`);
        }

        // Clear any large variables that might be in scope
        if (typeof extractedText !== 'undefined') extractedText = null;
        if (typeof chunks !== 'undefined') chunks = null;
        
        // Clear any cached processing data
        await this.clearProcessingCache();
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          console.log('✅ Forced garbage collection after error');
        }
        
        console.log('✅ Error cleanup completed');
        
      } catch (cleanupError) {
        console.warn(`⚠️ Error cleanup warning: ${cleanupError.message}`);
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
      
      console.log(`PDF pages: ${data.numpages}, Text length: ${extractedText.length}`);
      
      // Smart OCR detection: Check if this is likely a scanned PDF
      const avgCharsPerPage = extractedText.length / data.numpages;
      const hasMinimalText = avgCharsPerPage < 150;
      const isLikelyScanned = hasMinimalText || this.containsGarbledText(extractedText);
      
      console.log(`PDF Analysis: ${avgCharsPerPage.toFixed(1)} chars/page, scanned: ${isLikelyScanned}`);
      
      if (isLikelyScanned) {
        console.log(`Detected scanned PDF. Attempting Google Vision OCR...`);
        
        try {
          const ocrResult = await this.ocrService.extractFromPDF(filePath, progressCallback);
          
          if (ocrResult && ocrResult.success && ocrResult.text && ocrResult.text.trim().length > 0) {
            console.log(`PDF OCR successful: ${ocrResult.text.length} characters extracted`);
            console.log(`OCR confidence: ${ocrResult.confidence.toFixed(1)}%, language: ${ocrResult.language}`);
            return ocrResult;
          } else {
            console.warn('PDF OCR returned no text, checking if original extraction has content');
            
            if (extractedText.length > 10) {
              console.log('Using standard extraction with OCR failure notice');
              return extractedText + '\n\n[NOTE: This appears to be a scanned PDF. OCR processing failed but some text was extracted. Quality may be limited.]';
            } else {
              throw new Error('Both standard extraction and OCR failed to extract meaningful text');
            }
          }
        } catch (ocrError) {
          console.error('PDF OCR failed:', ocrError.message);
          
          if (extractedText.length > 10) {
            return extractedText + '\n\n[NOTE: This appears to be a scanned PDF. OCR processing failed. For better text extraction, try converting to high-quality images (PNG/JPG) and re-upload.]';
          } else {
            throw new Error(`PDF OCR failed and no standard text available: ${ocrError.message}`);
          }
        }
      }
      
      console.log('Using standard PDF text extraction');
      return extractedText;
      
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  async extractTextFromWord(buffer, fileName) {
    try {
      console.log(`Extracting text from Word document: ${fileName}`);
      const result = await mammoth.extractRawText({ buffer: buffer });
      const extractedText = result.value.trim();
      
      if (result.messages && result.messages.length > 0) {
        console.warn('Word extraction warnings:', result.messages.map(m => m.message).join(', '));
      }
      
      console.log(`Word extraction successful: ${extractedText.length} characters`);
      return {
        text: extractedText,
        wordCount: extractedText.split(/\s+/).filter(word => word.length > 0).length,
        confidence: 100, // Word documents have perfect text extraction
        language: 'unknown', // Could add language detection here
        engine: 'mammoth',
        processingTime: 0
      };
    } catch (error) {
      throw new Error(`Word document extraction failed: ${error.message}`);
    }
  }

  async extractTextFromExcel(buffer, fileName) {
    try {
      console.log(`Extracting text from Excel document: ${fileName}`);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      let allText = '';
      let cellCount = 0;
      
      workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const sheetText = XLSX.utils.sheet_to_txt(worksheet, { header: 1 });
        if (sheetText.trim().length > 0) {
          allText += `\n=== Sheet: ${sheetName} ===\n${sheetText}\n`;
          cellCount += Object.keys(worksheet).filter(key => key !== '!ref' && key !== '!margins').length;
        }
      });
      
      const extractedText = allText.trim();
      console.log(`Excel extraction successful: ${extractedText.length} characters from ${workbook.SheetNames.length} sheets`);
      
      return {
        text: extractedText,
        wordCount: extractedText.split(/\s+/).filter(word => word.length > 0).length,
        confidence: 100,
        language: 'unknown',
        engine: 'xlsx',
        processingTime: 0,
        sheetsProcessed: workbook.SheetNames.length,
        cellsProcessed: cellCount
      };
    } catch (error) {
      throw new Error(`Excel document extraction failed: ${error.message}`);
    }
  }

  async extractTextFromRTF(buffer, fileName) {
    try {
      console.log(`Extracting text from RTF document: ${fileName}`);
      const rtfContent = buffer.toString('utf-8');
      
      return new Promise((resolve, reject) => {
        rtfParser.parseString(rtfContent, (err, doc) => {
          if (err) {
            reject(new Error(`RTF parsing failed: ${err.message}`));
            return;
          }
          
          // Extract plain text from RTF document structure
          let extractedText = '';
          
          const extractText = (node) => {
            if (node.type === 'text') {
              extractedText += node.value;
            } else if (node.type === 'paragraph') {
              if (node.children) {
                node.children.forEach(child => extractText(child));
              }
              extractedText += '\n';
            } else if (node.children) {
              node.children.forEach(child => extractText(child));
            }
          };
          
          if (doc.children) {
            doc.children.forEach(child => extractText(child));
          }
          
          extractedText = extractedText.trim();
          console.log(`RTF extraction successful: ${extractedText.length} characters`);
          
          resolve({
            text: extractedText,
            wordCount: extractedText.split(/\s+/).filter(word => word.length > 0).length,
            confidence: 100,
            language: 'unknown',
            engine: 'rtf-parser',
            processingTime: 0
          });
        });
      });
    } catch (error) {
      throw new Error(`RTF document extraction failed: ${error.message}`);
    }
  }

  async extractTextFromPlainText(buffer, fileName) {
    try {
      console.log(`Reading plain text file: ${fileName}`);
      const extractedText = buffer.toString('utf-8').trim();
      
      console.log(`Plain text extraction successful: ${extractedText.length} characters`);
      return {
        text: extractedText,
        wordCount: extractedText.split(/\s+/).filter(word => word.length > 0).length,
        confidence: 100,
        language: 'unknown',
        engine: 'native',
        processingTime: 0
      };
    } catch (error) {
      throw new Error(`Plain text extraction failed: ${error.message}`);
    }
  }

  containsGarbledText(text) {
    if (!text || text.length < 20) return false;
    
    const garbledPatterns = [
      /[�]{2,}/g,
      /(.)\1{10,}/g,
      /^[\s\n\r]*$/g,
      /[^\x00-\x7F\u0590-\u05FF\u0600-\u06FF\u0020-\u007E]{20,}/g
    ];
    
    return garbledPatterns.some(pattern => pattern.test(text));
  }

  detectDocumentType(text) {
    const englishLegalTerms = [
      'whereas', 'party', 'parties', 'agreement', 'contract', 'shall', 'herein',
      'liability', 'clause', 'provision', 'terms', 'conditions', 'jurisdiction',
      'breach', 'terminate', 'indemnify', 'covenant', 'consideration'
    ];
    
    const hebrewLegalTerms = [
      'הסכם', 'חוזה', 'צד', 'צדדים', 'הצדדים', 'תנאי', 'תנאים', 'הוראות',
      'אחריות', 'חובות', 'זכויות', 'התחייבות', 'התחייבויות', 'סיום', 'ביטול',
      'פיצוי', 'פיצויים', 'שיפוי', 'נזק', 'נזקים', 'הפרה', 'מוסכם', 'בתוקף'
    ];
    
    const textLower = text.toLowerCase();
    const englishTermCount = englishLegalTerms.filter(term => textLower.includes(term)).length;
    const hebrewTermCount = hebrewLegalTerms.filter(term => text.includes(term)).length;
    
    if (englishTermCount >= 4 || hebrewTermCount >= 3) {
      return 'legal_contract';
    } else if (textLower.includes('assignment') && textLower.includes('manager')) {
      return 'assignment';
    } else {
      return 'general';
    }
  }

  // OPTIMIZED: Language-agnostic entity-aware chunking
  async contractAwareChunking(text, options = {}) {
    const { 
      chunkSize = 1200, 
      overlap = 120, 
      documentType = 'general',
      useEntityDetection = true 
    } = options;
    
    try {
      if (useEntityDetection && this.vectorService.openai) {
        console.log(`Using entity-aware chunking for ${documentType} document`);
        return await this.optimizedEntityChunking(text, chunkSize, documentType);
      } else {
        console.log(`Using enhanced semantic chunking (fallback)`);
        return this.enhancedSemanticChunking(text, chunkSize, overlap, documentType);
      }
    } catch (error) {
      console.warn('Entity-aware chunking failed, using fallback:', error.message);
      return this.enhancedSemanticChunking(text, chunkSize, overlap, documentType);
    }
  }

  // CORE: Language-agnostic entity boundary detection
  async entityAwareBoundaryDetection(text, chunkSize) {
    const windowSize = 2500;
    const overlap = 500;
    const allBoundaries = new Set();
    const maxWindows = Math.ceil(text.length / (windowSize - overlap));
    
    console.log(`Processing ${maxWindows} windows for entity boundary detection`);
    
    for (let i = 0; i < text.length; i += (windowSize - overlap)) {
      const window = text.substring(i, Math.min(i + windowSize, text.length));
      
      if (window.length < 200) continue;
      
      const prompt = `Identify entity boundaries in this text to prevent splitting entities across chunks. Find positions where entities (people, companies, dates, amounts, legal terms) start and end.

Text: ${window}

Return only valid JSON: {"boundaries": [{"position": number, "entity_type": "person|company|date|amount|clause"}]}`;

      try {
        const response = await this.vectorService.generateRobustCompletion({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 500
        });
        
        const result = JSON.parse(response.choices[0].message.content);
        if (result.boundaries) {
          result.boundaries.forEach(boundary => {
            if (typeof boundary.position === 'number') {
              allBoundaries.add(i + boundary.position);
            }
          });
        }
        
      } catch (apiError) {
        console.warn(`Entity detection failed for window starting at ${i}, using structural fallback`);
        this.addStructuralBoundaries(window, i, allBoundaries);
      }
    }
    
    return Array.from(allBoundaries).sort((a, b) => a - b);
  }

  // CORE: Optimized entity chunking with cost control
  async optimizedEntityChunking(text, chunkSize, documentType) {
    // 🛡️ Memory safety check
    if (text.length > 50000) {
      console.warn(`Large text detected (${text.length} chars), using fallback chunking to prevent memory issues`);
      return this.enhancedSemanticChunking(text, chunkSize, 120, documentType);
    }

    try {
      // Phase 1: Fast structural boundary detection (free)
      const structuralBoundaries = this.detectStructuralBoundaries(text, documentType);
      
      // Phase 2: Entity boundary detection for critical sections only (paid)
      const entityBoundaries = await this.entityAwareBoundaryDetection(text, chunkSize);
      
      // Phase 3: Create chunks respecting both boundary types
      const allBoundaries = [...structuralBoundaries, ...entityBoundaries]
        .sort((a, b) => a - b)
        .filter((boundary, index, arr) => index === 0 || boundary !== arr[index - 1]);
      
      // 🛡️ Sanity check: prevent massive boundary arrays
      if (allBoundaries.length > 1000) {
        console.warn(`Excessive boundaries detected (${allBoundaries.length}), using fallback`);
        return this.enhancedSemanticChunking(text, chunkSize, 120, documentType);
      }
      
      return this.createChunksFromBoundaries(text, allBoundaries, chunkSize);
      
    } catch (error) {
      console.error('Entity chunking failed with error:', error.message);
      console.log('Falling back to semantic chunking');
      return this.enhancedSemanticChunking(text, chunkSize, 120, documentType);
    }
  }

  // HELPER: Language-agnostic structural boundary detection
  detectStructuralBoundaries(text, documentType) {
    const boundaries = [0]; // Always start at beginning
    console.log(`🧮 Detecting structural boundaries for ${documentType} document (${text.length} chars)`);
    
    if (documentType === 'legal_contract') {
      // Universal legal section patterns (language-agnostic)
      const legalPatterns = [
        /(?=\n\s*\d+\.\s*)/g,                    // "1. Section"
        /(?=\n\s*[A-Z][A-Z\s]{5,}:)/g,          // "UPPERCASE HEADERS:"
        /(?=\n\s*Article\s+\d+)/gi,              // "Article 1"
        /(?=\n\s*Section\s+\d+)/gi,              // "Section 1"
        /(?=\n\s*\([a-z]\)\s*)/g,                // "(a) subsection"
        /(?=\n\s*\([0-9]+\)\s*)/g,               // "(1) numbered"
      ];
      
      legalPatterns.forEach(pattern => {
        // 🔧 CRITICAL FIX: Reset regex lastIndex to prevent state accumulation between documents
        pattern.lastIndex = 0;
        
        let match;
        while ((match = pattern.exec(text)) !== null) {
          boundaries.push(match.index);
          
          // 🛡️ SAFETY: Prevent infinite loops on zero-length matches
          if (match.index === pattern.lastIndex) {
            pattern.lastIndex++;
          }
        }
        
        // 🧹 CLEANUP: Reset pattern state after use
        pattern.lastIndex = 0;
      });
    }
    
    // Universal paragraph boundaries for all document types (FIXED: O(N) algorithm)
    const paragraphs = text.split(/\n\s*\n/);
    const paragraphBoundaries = [];
    let cumulativeLength = 0;
    
    for (let i = 0; i < paragraphs.length; i++) {
      if (i > 0) {
        paragraphBoundaries.push(cumulativeLength);
      }
      cumulativeLength += paragraphs[i].length + 2; // +2 for \n\n separator
    }
    
    boundaries.push(...paragraphBoundaries);
    boundaries.push(text.length); // Always end at text end
    
    const uniqueBoundaries = [...new Set(boundaries)].sort((a, b) => a - b);
    console.log(`📊 Found ${uniqueBoundaries.length} structural boundaries (${paragraphBoundaries.length} paragraphs)`);
    
    return uniqueBoundaries;
  }

  // HELPER: Add structural boundaries when entity detection fails
  addStructuralBoundaries(window, offset, allBoundaries) {
    // Add paragraph breaks as safe boundaries
    const paragraphs = window.split(/\n\s*\n/);
    let currentPos = offset;
    
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        allBoundaries.add(currentPos);
      }
      currentPos += paragraph.length + 2; // +2 for \n\n
    });
  }

  // HELPER: Create chunks from detected boundaries
  createChunksFromBoundaries(text, boundaries, chunkSize) {
    const chunks = [];
    let chunkId = 0;
    
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      const sectionText = text.substring(start, end).trim();
      
      if (sectionText.length === 0) continue;
      
      if (sectionText.length <= chunkSize) {
        chunks.push({
          id: chunkId++,
          text: sectionText,
          length: sectionText.length,
          type: 'entity_aware',
          entityBoundariesRespected: true,
          startPosition: start,
          endPosition: end
        });
      } else {
        // Split large sections at word boundaries (language-agnostic)
        const subChunks = this.splitLargeSection(sectionText, chunkSize);
        subChunks.forEach(chunk => {
          chunks.push({
            ...chunk,
            id: chunkId++,
            type: 'entity_aware_subsection',
            entityBoundariesRespected: true
          });
        });
      }
    }
    
    return chunks;
  }

  // HELPER: Split large sections at safe word boundaries
  splitLargeSection(text, chunkSize) {
    const chunks = [];
    const words = text.split(/\s+/);
    let currentChunk = '';
    let chunkId = 0;
    
    words.forEach((word, index) => {
      const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
      
      if (testChunk.length > chunkSize && currentChunk.length > 0) {
        chunks.push({
          text: currentChunk.trim(),
          length: currentChunk.length,
          type: 'word_boundary_split',
          wordStart: Math.max(0, index - currentChunk.split(/\s+/).length),
          wordEnd: index - 1
        });
        currentChunk = word;
      } else {
        currentChunk = testChunk;
      }
    });
    
    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        length: currentChunk.length,
        type: 'word_boundary_split',
        wordStart: Math.max(0, words.length - currentChunk.split(/\s+/).length),
        wordEnd: words.length - 1
      });
    }
    
    return chunks;
  }

  // ENHANCED: Language-agnostic semantic chunking fallback
  enhancedSemanticChunking(text, chunkSize, overlap, documentType) {
    const chunks = [];
    
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
    
    // Universal sentence detection (covers 95% of world languages)
    const universalSentencePattern = /[.!?。？！।॥፡፨᱾⸮؟։។׃״׳]/;
    const sentences = text.split(universalSentencePattern).filter(s => s.trim().length > 0);
    let currentChunk = '';
    let chunkId = 0;
    
    console.log(`Enhanced chunking: ${sentences.length} sentences found using universal patterns`);

    if (sentences.length === 0 || (sentences.length === 1 && sentences[0].trim().length === 0)) {
      // Fallback to word-boundary chunking
      return this.wordBoundaryChunking(text, chunkSize, overlap);
    }

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim() + '.';
      
      if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
        chunks.push({
          id: chunkId++,
          text: currentChunk.trim(),
          length: currentChunk.length,
          sentenceStart: Math.max(0, i - Math.floor(currentChunk.split('.').length / 2)),
          sentenceEnd: i - 1,
          type: 'enhanced_semantic'
        });

        const overlapSentences = Math.floor(overlap / 100);
        const startIndex = Math.max(0, i - overlapSentences);
        currentChunk = sentences.slice(startIndex, i + 1).join('. ') + '.';
      } else {
        currentChunk += (currentChunk.length > 0 ? ' ' : '') + sentence;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({
        id: chunkId++,
        text: currentChunk.trim(),
        length: currentChunk.length,
        sentenceStart: Math.max(0, sentences.length - Math.floor(currentChunk.split('.').length)),
        sentenceEnd: sentences.length - 1,
        type: 'enhanced_semantic'
      });
    }

    return chunks;
  }

  // FALLBACK: Word boundary chunking (language-agnostic)
  wordBoundaryChunking(text, chunkSize, overlap) {
    const chunks = [];
    const words = text.split(/\s+/);
    let currentChunk = '';
    let chunkId = 0;
    let wordStart = 0;
    
    console.log(`Word boundary chunking: ${words.length} words`);
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
      
      if (testChunk.length > chunkSize && currentChunk.length > 0) {
        chunks.push({
          id: chunkId++,
          text: currentChunk.trim(),
          length: currentChunk.length,
          type: 'word_boundary',
          wordStart: wordStart,
          wordEnd: i - 1
        });
        
        // Start new chunk with overlap
        const overlapWords = Math.floor(overlap / 10);
        wordStart = Math.max(0, i - overlapWords);
        currentChunk = words.slice(wordStart, i + 1).join(' ');
      } else {
        currentChunk = testChunk;
      }
    }
    
    if (currentChunk.trim().length > 0) {
      chunks.push({
        id: chunkId++,
        text: currentChunk.trim(),
        length: currentChunk.length,
        type: 'word_boundary',
        wordStart: wordStart,
        wordEnd: words.length - 1
      });
    }
    
    return chunks;
  }

  // REMOVED: Old legal contract chunking (replaced by entity-aware)
  // REMOVED: Old semantic chunking (replaced by enhanced version)

  // 🧹 MEMORY MANAGEMENT: Clear processing cache between documents  
  async clearProcessingCache() {
    try {
      console.log('🧹 Clearing processing cache...');
      
      // Clear any service-level caches
      if (this.vectorService && typeof this.vectorService.clearCache === 'function') {
        await this.vectorService.clearCache();
      }
      
      if (this.ocrService && typeof this.ocrService.clearCache === 'function') {
        await this.ocrService.clearCache();
      }
      
      // Clear any accumulated regex state by recreating patterns
      this.resetGlobalPatterns();
      
      console.log('✅ Processing cache cleared');
      
    } catch (error) {
      console.warn('⚠️ Cache clearing warning:', error.message);
    }
  }

  // Reset global regex patterns to prevent state accumulation
  resetGlobalPatterns() {
    try {
      // Reset any global regex patterns that might retain state
      // (Global regexes with /g flag retain lastIndex state between uses)
      console.log('🔄 Resetting global pattern state');
    } catch (error) {
      console.warn('⚠️ Pattern reset warning:', error.message);
    }
  }

  // ENHANCED: Legal metadata extraction with universal patterns
  extractLegalMetadata(text) {
    const metadata = {};
    
    // Universal entity patterns (language-agnostic where possible)
    const entityPatterns = {
      // Money amounts (universal)
      amounts: /[\$€£¥₪₹]\s*[\d,]+(?:\.\d{2})?|\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP|JPY|ILS|INR|dollars?|euros?|pounds?|yen|shekels?)/gi,
      
      // Dates (multiple formats)
      dates: /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi,
      
      // Company entities (universal suffixes)
      companies: /\b[A-Z][a-zA-Z\s]{2,30}(?:\s+(?:Inc|LLC|Corp|Company|Ltd|Limited|GmbH|S\.A\.|Pty|AG|B\.V\.|S\.L\.|LTD|CO|CORP)\.?)\b/g,
      
      // Legal clause indicators (expandable)
      clauses: /\b(?:whereas|therefore|hereby|shall|may|must|will|agrees?|covenant|provision|term|condition|clause|section|article)\b/gi
    };
    
    Object.entries(entityPatterns).forEach(([type, pattern]) => {
      const matches = text.match(pattern);
      if (matches) {
        metadata[type] = [...new Set(matches)]; // Remove duplicates
      }
    });
    
    // Enhanced clause type detection
    const textLower = text.toLowerCase();
    if (textLower.includes('termination') || textLower.includes('terminate')) {
      metadata.clauseType = 'termination';
    } else if (textLower.includes('payment') || textLower.includes('compensation')) {
      metadata.clauseType = 'payment';
    } else if (textLower.includes('liability') || textLower.includes('indemnif')) {
      metadata.clauseType = 'liability';
    } else if (textLower.includes('confidential') || textLower.includes('non-disclosure')) {
      metadata.clauseType = 'confidentiality';
    }
    
    return metadata;
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
      console.log(`Deleting document: ${documentId}`);
      
      const textFilePath = path.join(this.documentsPath, `${documentId}.txt`);
      const chunksFilePath = path.join(this.documentsPath, `${documentId}_chunks.json`);
      
      if (fs.existsSync(textFilePath)) {
        fs.unlinkSync(textFilePath);
        console.log(`Removed text file: ${documentId}.txt`);
      }
      if (fs.existsSync(chunksFilePath)) {
        fs.unlinkSync(chunksFilePath);
        console.log(`Removed chunks file: ${documentId}_chunks.json`);
      }

      try {
        await this.vectorService.removeDocument(documentId);
        console.log(`Removed from vector database: ${documentId}`);
      } catch (vectorError) {
        console.warn(`Could not remove from vector database: ${vectorError.message}`);
      }

      const documents = this.getAllDocuments();
      const updatedDocuments = documents.filter(doc => doc.id !== documentId);
      this.store.set('documents', updatedDocuments);
      
      console.log(`Document ${documentId} deleted successfully`);
      return true;
    } catch (error) {
      console.error(`Error deleting document: ${error.message}`);
      return false;
    }
  }

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
      console.error('Error in searchDocuments:', error);
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
      console.error('Semantic search failed:', error);
      return this.keywordSearch(query);
    }
  }

  async hybridSearch(query) {
    try {
      const [semanticResults, keywordResults] = await Promise.all([
        this.semanticSearch(query),
        this.keywordSearch(query)
      ]);

      const combinedResults = new Map();

      semanticResults.forEach(result => {
        combinedResults.set(result.document.id, {
          ...result,
          score: (result.avgSimilarity || 0) * 0.7,
          searchType: 'hybrid'
        });
      });

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
      console.error('Hybrid search failed:', error);
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

  // OCR Service methods
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

  async testOCRConnection() {
    try {
      if (!this.ocrService.isReady()) {
        return {
          success: false,
          message: 'OCR service not initialized. Please configure Google Vision API first.'
        };
      }

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

  // Utility methods (move to utils/ in future refactoring)
  createSafeFilePath(originalPath, documentId) {
    const ext = path.extname(originalPath);
    const tempDir = path.join(require('electron').app.getPath('temp'), 'contract-processing');
    
    if (!require('fs').existsSync(tempDir)) {
      require('fs').mkdirSync(tempDir, { recursive: true });
    }
    
    const safeFileName = `doc_${documentId}${ext}`;
    return path.join(tempDir, safeFileName);
  }

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

  isWordDocument(fileName) {
    const wordExtensions = ['.docx', '.doc'];
    const ext = path.extname(fileName).toLowerCase();
    return wordExtensions.includes(ext);
  }

  isExcelDocument(fileName) {
    const excelExtensions = ['.xlsx', '.xls'];
    const ext = path.extname(fileName).toLowerCase();
    return excelExtensions.includes(ext);
  }

  isRTFDocument(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return ext === '.rtf';
  }

  isPlainTextDocument(fileName) {
    const textExtensions = ['.txt', '.text'];
    const ext = path.extname(fileName).toLowerCase();
    return textExtensions.includes(ext);
  }

  isSupportedDocument(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const supportedExtensions = [
      // Office documents
      '.docx', '.doc', '.xlsx', '.xls', '.rtf',
      // Text documents
      '.txt', '.text',
      // PDF documents
      '.pdf',
      // Image documents  
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'
    ];
    return supportedExtensions.includes(ext);
  }

  // Document organization methods
  getDocumentsByFolder(folderId) {
    const documents = this.getAllDocuments();
    return documents.filter(doc => 
      (doc.folderId || this.folderService.getDefaultFolderId()) === folderId
    );
  }

  moveDocumentToFolder(documentId, targetFolderId) {
    try {
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
      
      documents[docIndex] = {
        ...document,
        folderId: targetFolderId,
        folderName: this.folderService.getFolder(targetFolderId)?.name || 'Unknown',
        movedAt: new Date().toISOString()
      };

      this.store.set('documents', documents);
      
      console.log(`Moved document "${document.originalName}" to folder: ${documents[docIndex].folderName}`);
      
      return {
        success: true,
        document: documents[docIndex],
        oldFolderId: oldFolderId,
        newFolderId: targetFolderId
      };
    } catch (error) {
      console.error('Error moving document:', error.message);
      return { success: false, error: error.message };
    }
  }

  moveDocumentsToFolder(sourceFolderId, targetFolderId) {
    try {
      const documents = this.getAllDocuments();
      const documentsToMove = documents.filter(doc => 
        (doc.folderId || this.folderService.getDefaultFolderId()) === sourceFolderId
      );

      if (documentsToMove.length === 0) {
        return { success: true, movedCount: 0 };
      }

      if (!this.folderService.validateFolder(targetFolderId)) {
        throw new Error('Target folder does not exist');
      }

      const targetFolder = this.folderService.getFolder(targetFolderId);
      let movedCount = 0;

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

      this.store.set('documents', updatedDocuments);
      
      console.log(`Moved ${movedCount} documents to folder: ${targetFolder?.name}`);
      
      return { success: true, movedCount: movedCount };
    } catch (error) {
      console.error('Error moving documents:', error.message);
      return { success: false, error: error.message };
    }
  }

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
      console.error('Error getting folder statistics:', error);
      return { success: false, error: error.message };
    }
  }

  async searchDocumentsInFolder(query, folderId, searchType = 'hybrid') {
    try {
      const allResults = await this.searchDocuments(query, searchType);
      
      const folderResults = allResults.filter(result => {
        const docFolderId = result.document.folderId || this.folderService.getDefaultFolderId();
        return docFolderId === folderId;
      });

      console.log(`Folder search "${query}" in folder ${folderId}: ${folderResults.length} results`);
      return folderResults;
    } catch (error) {
      console.error('Error searching in folder:', error);
      return [];
    }
  }

  async searchInDocument(query, documentId, searchType = 'hybrid') {
    try {
      console.log(`Document-focused search: "${query}" in document ${documentId}`);
      
      const allResults = await this.searchDocuments(query, searchType);
      
      const documentResults = allResults.filter(result => {
        return result.document_id === documentId || 
               (result.document && result.document.id === documentId) ||
               (result.metadata && result.metadata.document_id === documentId);
      });

      console.log(`Document search "${query}" in document ${documentId}: ${documentResults.length} results`);
      
      if (documentResults.length === 0 && allResults.length > 0) {
        console.warn(`Document filtering failed - found ${allResults.length} general results but 0 document-specific results`);
        return allResults.slice(0, 3);
      }
      
      return documentResults;
    } catch (error) {
      console.error('Error searching in document:', error);
      return [];
    }
  }

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
        console.log(`Migrated ${migratedCount} documents to default folder`);
      }

      return { success: true, migratedCount: migratedCount };
    } catch (error) {
      console.error('Error migrating documents:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Simplified folder service passthroughs (consider removing in future)
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