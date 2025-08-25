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

      // Configure request with comprehensive language support for Hebrew/Arabic
      const request = {
        image: { content: fs.readFileSync(imagePath).toString('base64') },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' } // Better for documents than TEXT_DETECTION
        ],
        imageContext: {
          languageHints: ['he', 'ar', 'en'], // Hebrew, Arabic, English
          textDetectionParams: {
            enableTextDetectionConfidenceScore: true
          }
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
   * Extract text from PDF with smart page-by-page analysis
   * Only performs OCR on pages that need it
   * @param {string} pdfPath - Path to PDF file
   * @returns {Object} OCR result with combined text from all pages
   */
  async extractFromPDF(pdfPath, progressCallback = null) {
    if (!this.isReady()) {
      throw new Error('OCR service not initialized. Please configure Google Vision API first.');
    }

    const startTime = Date.now();
    const tempDir = path.join(app.getPath('temp'), 'contract-ocr-' + Date.now());
    
    try {
      console.log(`📄 Processing PDF with smart OCR: ${path.basename(pdfPath)}`);

      // Create temp directory
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Get PDF info and convert to images
      console.log('🔄 Converting PDF pages to high-quality images...');
      const convertOptions = {
        format: 'png',
        out_dir: tempDir,
        out_prefix: 'page',
        page: null, // Convert all pages
        resolution: 300 // Higher resolution for better OCR accuracy
      };

      const convertStartTime = Date.now();
      const info = await pdfPoppler.info(pdfPath);
      await pdfPoppler.convert(pdfPath, convertOptions);
      const conversionTime = Date.now() - convertStartTime;

      console.log(`✅ Converted ${info.pages} PDF pages in ${conversionTime}ms`);

      // Smart page-by-page processing
      let combinedText = '';
      let totalConfidence = 0;
      let totalWords = 0;
      let successfulPages = 0;
      let ocrTime = 0;
      const pageResults = [];

      for (let pageNum = 1; pageNum <= info.pages; pageNum++) {
        const imagePath = path.join(tempDir, `page-${pageNum}.png`);
        
        // Report progress for current page
        if (progressCallback) {
          progressCallback({
            isOCR: true,
            currentPage: pageNum,
            totalPages: info.pages,
            pagesProcessed: successfulPages,
            stage: 'processing_page'
          });
        }
        
        if (fs.existsSync(imagePath)) {
          try {
            console.log(`📄 Processing page ${pageNum}/${info.pages}...`);
            
            // First, do a quick analysis to see if this page needs OCR
            const pageNeedsOCR = await this.pageNeedsOCR(imagePath);
            
            if (!pageNeedsOCR) {
              console.log(`⏭️ Page ${pageNum} appears to be blank/minimal content, skipping OCR`);
              continue;
            }
            
            const pageResult = await this.extractFromImage(imagePath);
            pageResults.push({ pageNum, result: pageResult });
            
            if (pageResult.success && pageResult.text.trim().length > 0) {
              // Add page separator for multi-page documents
              if (combinedText.length > 0) {
                combinedText += '\n\n--- Page ' + pageNum + ' ---\n\n';
              }
              
              combinedText += pageResult.text.trim();
              totalConfidence += pageResult.confidence;
              totalWords += pageResult.wordCount;
              ocrTime += pageResult.processingTime;
              successfulPages++;
              
              console.log(`✅ Page ${pageNum}: ${pageResult.text.length} chars, confidence: ${pageResult.confidence.toFixed(1)}%`);
            } else {
              console.warn(`⚠️ Page ${pageNum} OCR returned no text`);
            }

          } catch (pageError) {
            console.warn(`⚠️ Failed to process page ${pageNum}:`, pageError.message);
            pageResults.push({ pageNum, error: pageError.message });
          }
        } else {
          console.warn(`⚠️ Page ${pageNum} image not found: ${imagePath}`);
        }
      }

      // Cleanup temp files
      await this.cleanupTempDir(tempDir);

      const totalTime = Date.now() - startTime;
      const avgConfidence = successfulPages > 0 ? totalConfidence / successfulPages : 0;

      if (successfulPages === 0) {
        console.warn('❌ No text extracted from any PDF pages');
        return {
          text: '',
          confidence: 0,
          language: 'unknown',
          wordCount: 0,
          processingTime: totalTime,
          conversionTime: conversionTime,
          ocrTime: ocrTime,
          pagesProcessed: 0,
          totalPages: info.pages,
          engine: 'google_vision',
          success: false,
          error: 'No text could be extracted from any pages'
        };
      }

      // Detect overall language from combined text
      const detectedLanguage = this.detectLanguage(combinedText);
      
      console.log(`✅ Smart PDF OCR completed: ${combinedText.length} characters from ${successfulPages}/${info.pages} pages`);
      console.log(`📊 Language: ${detectedLanguage}, Average confidence: ${avgConfidence.toFixed(1)}%, Total time: ${totalTime}ms`);

      return {
        text: combinedText.trim(),
        confidence: avgConfidence,
        language: detectedLanguage,
        wordCount: totalWords,
        processingTime: totalTime,
        conversionTime: conversionTime,
        ocrTime: ocrTime,
        pagesProcessed: successfulPages,
        totalPages: info.pages,
        pageResults: pageResults,
        engine: 'google_vision',
        success: true
      };

    } catch (error) {
      // Cleanup on error
      await this.cleanupTempDir(tempDir);
      
      console.error('❌ PDF OCR failed:', error.message);
      throw new Error(`Smart PDF OCR failed: ${error.message}`);
    }
  }

  /**
   * Quick analysis to determine if a page needs OCR processing
   * Uses a lightweight check to avoid processing blank/minimal pages
   * @param {string} imagePath - Path to page image
   * @returns {boolean} True if page likely contains meaningful text
   */
  async pageNeedsOCR(imagePath) {
    try {
      // Use TEXT_DETECTION (faster) for quick analysis instead of DOCUMENT_TEXT_DETECTION
      const request = {
        image: { content: fs.readFileSync(imagePath).toString('base64') },
        features: [{ type: 'TEXT_DETECTION' }]
      };

      const [result] = await this.client.annotateImage(request);
      
      if (result.error) {
        console.warn(`⚠️ Quick OCR analysis failed: ${result.error.message}, defaulting to OCR`);
        return true; // When in doubt, process it
      }

      const textAnnotations = result.textAnnotations;
      
      // If no text detected or very minimal text, skip OCR
      if (!textAnnotations || textAnnotations.length === 0) {
        return false;
      }
      
      const detectedText = textAnnotations[0]?.description || '';
      
      // Skip if less than 10 characters detected (likely noise/artifacts)
      if (detectedText.trim().length < 10) {
        return false;
      }
      
      return true;
      
    } catch (error) {
      console.warn('⚠️ Page analysis failed:', error.message, 'defaulting to OCR');
      return true; // When in doubt, process it
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
   * Detect primary language in text with improved accuracy
   */
  detectLanguage(text) {
    if (!text || text.trim().length < 10) return 'unknown';
    
    // Count characters for each language
    const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    
    // Calculate percentages
    const hebrewPct = hebrewChars / totalChars;
    const arabicPct = arabicChars / totalChars;
    const latinPct = latinChars / totalChars;
    
    console.log(`🔤 Language detection: Hebrew ${(hebrewPct * 100).toFixed(1)}%, Arabic ${(arabicPct * 100).toFixed(1)}%, Latin ${(latinPct * 100).toFixed(1)}%`);
    
    // Determine primary language (threshold 20% to handle mixed content)
    if (hebrewPct > 0.2 && hebrewPct >= arabicPct && hebrewPct >= latinPct) {
      return 'hebrew';
    } else if (arabicPct > 0.2 && arabicPct >= hebrewPct && arabicPct >= latinPct) {
      return 'arabic';
    } else if (latinPct > 0.4) {
      return 'english';
    } else {
      // Mixed or unclear content
      return hebrewPct > arabicPct ? 'hebrew' : (arabicPct > latinPct ? 'arabic' : 'english');
    }
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
   * Test OCR service connection with minimal API call
   */
  async testConnection() {
    try {
      if (!this.isReady()) {
        return {
          success: false,
          message: 'OCR service not initialized. Please configure Google Vision API first.'
        };
      }

      // Test with a minimal API call - just check if we can get project info
      console.log('🔍 Testing Google Vision API connectivity...');
      const projectId = await this.client.getProjectId();
      
      console.log(`✅ OCR connection test successful. Project ID: ${projectId}`);
      return {
        success: true,
        message: `Successfully connected to Google Vision API`,
        details: {
          projectId: projectId,
          engine: 'google_vision',
          supportedLanguages: ['hebrew', 'arabic', 'english'],
          isReady: true
        }
      };
    } catch (error) {
      console.error('❌ OCR connection test failed:', error.message);
      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
        details: {
          error: error.message,
          isReady: false
        }
      };
    }
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
