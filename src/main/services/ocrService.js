const { ImageAnnotatorClient } = require('@google-cloud/vision');
const fs = require('fs');
const path = require('path');
const pdfPoppler = require('pdf-poppler');
const { app } = require('electron');
const Store = require('electron-store');

/**
 * Clean, focused OCR Service using Google Vision API
 * Handles both images and PDFs with Hebrew/Arabic support
 */
class OCRService {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.store = new Store({ name: 'ocr-settings', encryptionKey: 'contract-rag-ocr' });
    
    console.log('🔍 OCR Service initialized');
  }

  /**
   * Initialize Google Vision API with service account JSON
   * @param {string} serviceAccountPath - Path to service account JSON file
   */
  async initialize(serviceAccountPath) {
    try {
      if (!fs.existsSync(serviceAccountPath)) {
        throw new Error('Service account JSON file not found');
      }

      // Initialize Google Vision client
      this.client = new ImageAnnotatorClient({
        keyFilename: serviceAccountPath
      });

      // Test the connection
      console.log('🔍 Testing Google Vision API connection...');
      await this.client.getProjectId();
      
      this.isInitialized = true;
      this.store.set('serviceAccountPath', serviceAccountPath);
      
      console.log('✅ Google Vision API initialized successfully');
      return true;

    } catch (error) {
      console.error('❌ Failed to initialize Google Vision API:', error.message);
      this.isInitialized = false;
      throw new Error(`Google Vision initialization failed: ${error.message}`);
    }
  }

  /**
   * Check if OCR service is ready
   */
  isReady() {
    return this.isInitialized && this.client;
  }

  /**
   * Extract text from an image using Google Vision
   * @param {string} imagePath - Path to image file
   * @returns {Object} OCR result with text, confidence, and metadata
   */
  async extractFromImage(imagePath) {
    if (!this.isReady()) {
      throw new Error('OCR service not initialized. Please configure Google Vision API first.');
    }

    const startTime = Date.now();

    try {
      console.log(`🔍 Processing image: ${path.basename(imagePath)}`);

      // Configure request with language hints for Hebrew/Arabic
      const request = {
        image: { content: fs.readFileSync(imagePath).toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], // Better for documents than TEXT_DETECTION
        imageContext: {
          languageHints: ['he', 'ar', 'en'] // Hebrew, Arabic, English
        }
      };

      // Call Google Vision API
      const [result] = await this.client.annotateImage(request);

      if (result.error) {
        throw new Error(`Google Vision error: ${result.error.message}`);
      }

      const fullTextAnnotation = result.fullTextAnnotation;
      
      if (!fullTextAnnotation || !fullTextAnnotation.text) {
        console.warn('⚠️ No text found in image');
        return this.createEmptyResult();
      }

      const text = fullTextAnnotation.text;
      const processingTime = Date.now() - startTime;
      
      // Calculate confidence from text annotations
      const confidence = this.calculateConfidence(result.textAnnotations);
      
      console.log(`✅ Extracted ${text.length} characters in ${processingTime}ms`);

      return {
        text: text,
        confidence: confidence,
        language: this.detectLanguage(text),
        wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
        processingTime: processingTime,
        engine: 'google_vision',
        success: true
      };

    } catch (error) {
      console.error('❌ Image OCR failed:', error.message);
      throw new Error(`Image OCR failed: ${error.message}`);
    }
  }

  /**
   * Extract text from PDF by converting to images first
   * @param {string} pdfPath - Path to PDF file
   * @returns {Object} OCR result with combined text from all pages
   */
  async extractFromPDF(pdfPath) {
    if (!this.isReady()) {
      throw new Error('OCR service not initialized. Please configure Google Vision API first.');
    }

    const startTime = Date.now();
    const tempDir = path.join(app.getPath('temp'), 'contract-ocr-' + Date.now());
    
    try {
      console.log(`📄 Processing PDF: ${path.basename(pdfPath)}`);

      // Create temp directory
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Convert PDF to images
      console.log('🔄 Converting PDF pages to images...');
      const convertOptions = {
        format: 'png',
        out_dir: tempDir,
        out_prefix: 'page',
        page: null, // Convert all pages
        resolution: 200 // Good balance between quality and processing time
      };

      const convertStartTime = Date.now();
      const info = await pdfPoppler.info(pdfPath);
      await pdfPoppler.convert(pdfPath, convertOptions);
      const conversionTime = Date.now() - convertStartTime;

      console.log(`✅ Converted ${info.pages} PDF pages in ${conversionTime}ms`);

      // Process each page image with OCR
      let combinedText = '';
      let totalConfidence = 0;
      let totalWords = 0;
      let successfulPages = 0;
      let ocrTime = 0;

      for (let pageNum = 1; pageNum <= info.pages; pageNum++) {
        const imagePath = path.join(tempDir, `page-${pageNum}.png`);
        
        if (fs.existsSync(imagePath)) {
          try {
            console.log(`📄 Processing page ${pageNum}/${info.pages}...`);
            
            const pageResult = await this.extractFromImage(imagePath);
            
            if (pageResult.success && pageResult.text.trim().length > 0) {
              combinedText += pageResult.text + '\n\n';
              totalConfidence += pageResult.confidence;
              totalWords += pageResult.wordCount;
              ocrTime += pageResult.processingTime;
              successfulPages++;
            }

          } catch (pageError) {
            console.warn(`⚠️ Failed to process page ${pageNum}:`, pageError.message);
          }
        }
      }

      // Cleanup temp files
      await this.cleanupTempDir(tempDir);

      const totalTime = Date.now() - startTime;
      const avgConfidence = successfulPages > 0 ? totalConfidence / successfulPages : 0;

      if (successfulPages === 0) {
        console.warn('❌ No text extracted from any PDF pages');
        return this.createEmptyResult();
      }

      console.log(`✅ PDF OCR completed: ${combinedText.length} characters from ${successfulPages}/${info.pages} pages`);
      console.log(`📊 Average confidence: ${avgConfidence.toFixed(1)}%, Total time: ${totalTime}ms`);

      return {
        text: combinedText.trim(),
        confidence: avgConfidence,
        language: this.detectLanguage(combinedText),
        wordCount: totalWords,
        processingTime: totalTime,
        conversionTime: conversionTime,
        ocrTime: ocrTime,
        pagesProcessed: successfulPages,
        totalPages: info.pages,
        engine: 'google_vision',
        success: true
      };

    } catch (error) {
      // Cleanup on error
      await this.cleanupTempDir(tempDir);
      
      console.error('❌ PDF OCR failed:', error.message);
      throw new Error(`PDF OCR failed: ${error.message}`);
    }
  }

  /**
   * Calculate confidence score from text annotations
   */
  calculateConfidence(textAnnotations) {
    if (!textAnnotations || textAnnotations.length === 0) return 0;
    
    // Skip the first annotation (full text) and calculate from word-level annotations
    const wordAnnotations = textAnnotations.slice(1);
    if (wordAnnotations.length === 0) return 85; // Default for document text
    
    const totalConfidence = wordAnnotations.reduce((sum, annotation) => {
      return sum + (annotation.confidence || 0.85);
    }, 0);
    
    return Math.round((totalConfidence / wordAnnotations.length) * 100);
  }

  /**
   * Detect primary language in text
   */
  detectLanguage(text) {
    if (/[\u0590-\u05FF]/.test(text)) return 'hebrew';
    if (/[\u0600-\u06FF]/.test(text)) return 'arabic';
    return 'english';
  }

  /**
   * Create empty result for cases with no text
   */
  createEmptyResult() {
    return {
      text: '',
      confidence: 0,
      language: 'unknown',
      wordCount: 0,
      processingTime: 0,
      engine: 'google_vision',
      success: false
    };
  }

  /**
   * Clean up temporary directory and files
   */
  async cleanupTempDir(tempDir) {
    try {
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(tempDir, file));
        }
        fs.rmdirSync(tempDir);
        console.log('🧹 Cleaned up temporary files');
      }
    } catch (error) {
      console.warn('⚠️ Cleanup warning:', error.message);
    }
  }

  /**
   * Get service configuration info
   */
  getInfo() {
    const serviceAccountPath = this.store.get('serviceAccountPath');
    let projectId = 'unknown';
    
    // Try to get project ID from service account if available
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        projectId = serviceAccount.project_id || 'unknown';
      } catch (error) {
        console.warn('⚠️ Could not read project ID from service account');
      }
    }
    
    return {
      isInitialized: this.isInitialized,
      isConfigured: !!serviceAccountPath && this.isInitialized,
      hasServiceAccount: !!serviceAccountPath,
      serviceAccountPath: serviceAccountPath || null,
      projectId: projectId,
      supportedFormats: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'pdf'],
      supportedLanguages: ['hebrew', 'arabic', 'english']
    };
  }

  /**
   * Auto-initialize from stored service account if available
   */
  async autoInitialize() {
    const serviceAccountPath = this.store.get('serviceAccountPath');
    
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      try {
        await this.initialize(serviceAccountPath);
      return true;
    } catch (error) {
        console.warn('⚠️ Auto-initialization failed:', error.message);
      return false;
    }
  }

    return false;
  }

  /**
   * Clear stored service account configuration
   */
  clearServiceAccount() {
    this.client = null;
    this.isInitialized = false;
    this.store.delete('serviceAccountPath');
    console.log('🗑️ Google Vision service account cleared');
  }
}

module.exports = OCRService;
