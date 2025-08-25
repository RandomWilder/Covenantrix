const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

class OCRService {
  constructor() {
    this.scheduler = null;
    this.workers = {};
    this.isInitialized = false;
    
    // Supported languages with their Tesseract codes
    this.supportedLanguages = {
      'english': 'eng',
      'hebrew': 'heb', 
      'arabic': 'ara',
      'spanish': 'spa',
      'french': 'fra',
      'german': 'deu',
      'russian': 'rus',
      'chinese_simplified': 'chi_sim',
      'chinese_traditional': 'chi_tra',
      'japanese': 'jpn',
      'korean': 'kor'
    };
    
    console.log('🔍 OCRService initialized with multi-language support');
  }

  async initialize() {
    try {
      // Create Tesseract scheduler for better performance
      this.scheduler = Tesseract.createScheduler();
      
      // Initialize multi-language worker (English + Hebrew by default)
      // This covers most common use cases including Hebrew documents
      const multiLangWorker = await Tesseract.createWorker(['eng', 'heb']);
      this.scheduler.addWorker(multiLangWorker);
      this.workers['multi'] = multiLangWorker;
      
      this.isInitialized = true;
      console.log('✅ OCR multi-language worker initialized (English + Hebrew)');
      return true;
    } catch (error) {
      console.error('❌ Error initializing OCR service:', error);
      console.log('ℹ️ Falling back to English-only OCR...');
      
      try {
        // Fallback to English only if multi-language fails
        const englishWorker = await Tesseract.createWorker('eng');
        this.scheduler.addWorker(englishWorker);
        this.workers['eng'] = englishWorker;
        this.isInitialized = true;
        console.log('✅ OCR English worker initialized as fallback');
        return true;
      } catch (fallbackError) {
        console.error('❌ OCR initialization completely failed:', fallbackError);
        return false;
      }
    }
  }

  async preprocessImage(imagePath) {
    try {
      // Create a preprocessed version of the image for better OCR accuracy
      const outputPath = imagePath.replace(path.extname(imagePath), '_processed.png');
      
      await sharp(imagePath)
        .greyscale()                    // Convert to grayscale
        .normalize()                    // Normalize contrast
        .sharpen()                     // Sharpen for better text recognition
        .resize(null, 2000, {          // Upscale if needed (max height 2000px)
          withoutEnlargement: true
        })
        .png({ quality: 100 })         // Save as high-quality PNG
        .toFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error('❌ Error preprocessing image:', error);
      return imagePath; // Return original if preprocessing fails
    }
  }

  async extractTextFromImage(imagePath, languages = null) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      console.log(`🔍 Processing image with OCR: ${path.basename(imagePath)}`);

      // Preprocess image for better OCR accuracy
      const processedPath = await this.preprocessImage(imagePath);

      // Perform OCR with multi-language support
      const result = await this.scheduler.addJob('recognize', processedPath, {
        logger: m => console.log(`OCR Progress: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`)
      });

      // Clean up processed file if it was created
      if (processedPath !== imagePath && fs.existsSync(processedPath)) {
        fs.unlinkSync(processedPath);
      }

      // Process the OCR result
      const extractedText = result.data.text;
      const confidence = result.data.confidence;

      // Detect if text contains Hebrew characters
      const hasHebrew = /[\u0590-\u05FF]/.test(extractedText);
      const hasArabic = /[\u0600-\u06FF]/.test(extractedText);
      
      let detectedLanguage = 'unknown';
      if (hasHebrew) detectedLanguage = 'hebrew';
      else if (hasArabic) detectedLanguage = 'arabic';
      else if (/[a-zA-Z]/.test(extractedText)) detectedLanguage = 'english';

      console.log(`✅ OCR completed with ${confidence.toFixed(1)}% confidence`);
      console.log(`📝 Extracted ${extractedText.length} characters`);
      console.log(`🌐 Detected language: ${detectedLanguage}`);

      return {
        text: extractedText,
        confidence: confidence,
        wordCount: extractedText.split(/\s+/).filter(word => word.length > 0).length,
        detectedLanguage: detectedLanguage,
        hasHebrew: hasHebrew,
        hasArabic: hasArabic
      };
    } catch (error) {
      console.error('❌ Error in OCR processing:', error);
      throw error;
    }
  }

  async extractTextFromPDF(pdfBuffer) {
    try {
      // This method converts PDF pages to images and then processes with OCR
      // For now, we'll focus on image-based OCR, but this can be extended
      console.log('📄 PDF OCR processing not yet implemented');
      
      return {
        text: '',
        confidence: 0,
        wordCount: 0,
        error: 'PDF OCR not implemented yet - use image files for OCR'
      };
    } catch (error) {
      console.error('❌ Error in PDF OCR:', error);
      throw error;
    }
  }

  async processMultipleImages(imagePaths) {
    try {
      const results = [];
      
      for (const imagePath of imagePaths) {
        try {
          const result = await this.extractTextFromImage(imagePath);
          results.push({
            file: path.basename(imagePath),
            ...result
          });
        } catch (error) {
          results.push({
            file: path.basename(imagePath),
            error: error.message,
            text: '',
            confidence: 0
          });
        }
      }

      return results;
    } catch (error) {
      console.error('❌ Error processing multiple images:', error);
      return [];
    }
  }

  // Enhanced multi-language contract text cleaning
  cleanContractText(rawText, detectedLanguage = 'unknown') {
    try {
      let cleanText = rawText;

      // Apply language-specific cleaning
      if (detectedLanguage === 'hebrew' || /[\u0590-\u05FF]/.test(rawText)) {
        cleanText = this.cleanHebrewText(cleanText);
      } else if (detectedLanguage === 'arabic' || /[\u0600-\u06FF]/.test(rawText)) {
        cleanText = this.cleanArabicText(cleanText);
      } else {
        // Default English/Latin script cleaning
        cleanText = this.cleanEnglishText(cleanText);
      }

      // Universal cleaning (all languages)
      cleanText = cleanText
        // Fix spacing issues
        .replace(/\s+/g, ' ')                         // Multiple spaces to single
        .replace(/\n\s*\n/g, '\n\n')                 // Clean paragraph breaks
        
        // Clean up line breaks
        .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')       // Fix hyphenated words across lines
        
        .trim();

      return cleanText;
    } catch (error) {
      console.error('❌ Error cleaning contract text:', error);
      return rawText;
    }
  }

  cleanHebrewText(text) {
    return text
      // Fix common Hebrew OCR errors
      .replace(/[״״]/g, '"')                        // Normalize Hebrew quotes
      .replace(/[׳׳]/g, "'")                        // Normalize Hebrew apostrophes
      .replace(/־/g, '-')                           // Normalize Hebrew hyphen
      
      // Fix Hebrew punctuation spacing
      .replace(/\s+([.,;:!?״׳])/g, '$1')           // Remove space before punctuation
      .replace(/([.,;:!?״׳])\s*([א-ת])/g, '$1 $2') // Add space after punctuation
      
      // Preserve Hebrew text direction markers
      .replace(/\u200F/g, '')                       // Remove Right-to-Left marks that might cause issues
      .replace(/\u200E/g, '');                      // Remove Left-to-Right marks
  }

  cleanArabicText(text) {
    return text
      // Fix common Arabic OCR errors
      .replace(/["""]/g, '"')                       // Normalize quotes
      .replace(/[''']/g, "'")                       // Normalize apostrophes
      
      // Fix Arabic punctuation spacing
      .replace(/\s+([.,;:!?])/g, '$1')             // Remove space before punctuation
      .replace(/([.,;:!?])\s*([أ-ي])/g, '$1 $2')   // Add space after punctuation
      
      // Clean up Arabic text direction
      .replace(/\u200F/g, '')                       // Remove Right-to-Left marks
      .replace(/\u200E/g, '');                      // Remove Left-to-Right marks
  }

  cleanEnglishText(text) {
    return text
      // Fix common OCR errors in legal documents
      .replace(/\b[Il]\b/g, 'I')                    // Fix standalone I/l confusion
      .replace(/\b[0O]f\b/g, 'of')                  // Fix 0f -> of
      .replace(/\btne\b/g, 'the')                   // Fix tne -> the
      .replace(/\band\b/gi, 'and')                  // Normalize 'and'
      .replace(/\bcontract\b/gi, 'contract')        // Normalize 'contract'
      
      // Fix punctuation
      .replace(/\s+([.,;:!?])/g, '$1')             // Remove space before punctuation
      .replace(/([.,;:!?])\s*([a-zA-Z])/g, '$1 $2') // Add space after punctuation
      
      // Join broken sentences (English-specific)
      .replace(/\n\s*([a-z])/g, ' $1');            // Join broken sentences
  }

  async terminate() {
    try {
      if (this.scheduler) {
        await this.scheduler.terminate();
        this.scheduler = null;
        this.workers = {};
        this.isInitialized = false;
        console.log('🔍 OCR service terminated');
      }
    } catch (error) {
      console.error('❌ Error terminating OCR service:', error);
    }
  }

  // Get available language support info (IPC-safe)
  getLanguageSupport() {
    return {
      initialized: this.isInitialized,
      supportedLanguages: this.supportedLanguages ? Object.keys(this.supportedLanguages) : ['english'],
      activeWorkers: this.workers ? Object.keys(this.workers) : [],
      hasHebrewSupport: !!(this.workers && (this.workers['multi'] || this.workers['heb'])),
      hasMultiLanguageSupport: !!(this.workers && this.workers['multi'])
    };
  }

  // Add specific language worker if needed
  async addLanguageSupport(languageCode) {
    try {
      if (this.workers[languageCode]) {
        console.log(`Language ${languageCode} already supported`);
        return true;
      }

      const worker = await Tesseract.createWorker(languageCode);
      this.scheduler.addWorker(worker);
      this.workers[languageCode] = worker;
      
      console.log(`✅ Added ${languageCode} language support`);
      return true;
    } catch (error) {
      console.error(`❌ Error adding ${languageCode} support:`, error);
      return false;
    }
  }

  // Check if file is an image that can be processed
  isImageFile(filePath) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp'];
    const ext = path.extname(filePath).toLowerCase();
    return imageExtensions.includes(ext);
  }

  // Get supported file types
  getSupportedImageTypes() {
    return [
      { name: 'PNG Images', extensions: ['png'] },
      { name: 'JPEG Images', extensions: ['jpg', 'jpeg'] },
      { name: 'TIFF Images', extensions: ['tiff', 'tif'] },
      { name: 'BMP Images', extensions: ['bmp'] },
      { name: 'GIF Images', extensions: ['gif'] },
      { name: 'WebP Images', extensions: ['webp'] }
    ];
  }
}

module.exports = OCRService;
