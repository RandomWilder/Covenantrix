/**
 * Simple RAG Data Examiner - Can run with Node.js directly
 * This version examines file system chunks and attempts to read Electron stores
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class SimpleRAGExaminer {
  constructor() {
    // Try to find the typical Electron userData directory
    const appName = 'contract-rag-manager'; // Updated to match package name (not productName)
    
    if (process.platform === 'win32') {
      this.userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', appName);
    } else if (process.platform === 'darwin') {
      this.userDataPath = path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else {
      this.userDataPath = path.join(os.homedir(), '.config', appName);
    }

    this.documentsPath = path.join(this.userDataPath, 'documents');
    this.configPath = this.userDataPath;
    
    console.log('🔍 Simple RAG Data Examiner');
    console.log(`📁 Looking for data in: ${this.userDataPath}`);
    console.log(`📄 Documents path: ${this.documentsPath}`);
  }

  examineFileSystem() {
    console.log('\n💾 FILE SYSTEM EXAMINATION');
    console.log('='.repeat(40));

    if (!fs.existsSync(this.documentsPath)) {
      console.log(`❌ Documents directory not found: ${this.documentsPath}`);
      console.log('   Make sure you have processed at least one document.');
      return;
    }

    const files = fs.readdirSync(this.documentsPath);
    const chunkFiles = files.filter(file => file.endsWith('_chunks.json'));
    const textFiles = files.filter(file => file.endsWith('.txt') && !file.includes('_chunks'));
    const allFiles = files.length;

    console.log(`📊 File Statistics:`);
    console.log(`   Total files: ${allFiles}`);
    console.log(`   Chunk files: ${chunkFiles.length}`);
    console.log(`   Text files: ${textFiles.length}`);
    console.log(`   Other files: ${allFiles - chunkFiles.length - textFiles.length}`);

    if (chunkFiles.length === 0) {
      console.log('\n❌ No chunk files found. Documents may not be processed yet.');
      return;
    }

    // Examine each chunk file
    console.log(`\n📝 CHUNK FILES ANALYSIS:`);
    chunkFiles.forEach((file, index) => {
      const filePath = path.join(this.documentsPath, file);
      const stats = fs.statSync(filePath);
      
      console.log(`\n   📄 File ${index + 1}: ${file}`);
      console.log(`   ├─ Size: ${stats.size} bytes`);
      console.log(`   ├─ Modified: ${stats.mtime.toLocaleString()}`);

      try {
        const chunksData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        console.log(`   ├─ Chunks count: ${chunksData.length}`);

        if (chunksData.length > 0) {
          // Analyze chunk structure and content
          const lengths = chunksData.map(chunk => chunk.text?.length || 0);
          const avgLength = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
          const minLength = Math.min(...lengths);
          const maxLength = Math.max(...lengths);

          console.log(`   ├─ Avg chunk size: ${avgLength} chars`);
          console.log(`   ├─ Size range: ${minLength} - ${maxLength} chars`);

          // Sample chunk analysis
          const sampleChunk = chunksData[0];
          console.log(`   ├─ Sample chunk ID: ${sampleChunk.id || 'N/A'}`);
          console.log(`   ├─ Has sentence bounds: ${sampleChunk.sentenceStart !== undefined ? '✅' : '❌'}`);
          console.log(`   └─ Preview: "${sampleChunk.text.substring(0, 100)}${sampleChunk.text.length > 100 ? '...' : ''}"`);

          // Content quality analysis
          this.analyzeChunkQuality(chunksData, file);
        }

      } catch (error) {
        console.log(`   └─ ❌ Error reading file: ${error.message}`);
      }
    });
  }

  analyzeChunkQuality(chunks, fileName) {
    console.log(`\n   🔍 Content Quality Analysis for ${fileName}:`);
    
    // Language detection (simple heuristic)
    const sampleText = chunks.slice(0, 5).map(c => c.text).join(' ').toLowerCase();
    const hasHebrew = /[\u0590-\u05FF]/.test(sampleText);
    const hasArabic = /[\u0600-\u06FF]/.test(sampleText);
    const hasEnglish = /[a-z]/.test(sampleText);

    console.log(`   ├─ Languages detected: ${[
      hasEnglish && 'English',
      hasHebrew && 'Hebrew',
      hasArabic && 'Arabic'
    ].filter(Boolean).join(', ') || 'Unknown'}`);

    // Content patterns
    const contractKeywords = ['agreement', 'contract', 'party', 'parties', 'shall', 'hereby', 'whereas'];
    const legalKeywords = ['clause', 'section', 'article', 'paragraph', 'terms', 'conditions'];
    const contractMatches = contractKeywords.filter(word => sampleText.includes(word)).length;
    const legalMatches = legalKeywords.filter(word => sampleText.includes(word)).length;

    console.log(`   ├─ Contract keywords: ${contractMatches}/${contractKeywords.length}`);
    console.log(`   ├─ Legal keywords: ${legalMatches}/${legalKeywords.length}`);

    // Chunk overlap analysis
    if (chunks.length > 1) {
      let overlapFound = 0;
      for (let i = 0; i < Math.min(chunks.length - 1, 5); i++) {
        const chunk1End = chunks[i].text.slice(-50);
        const chunk2Start = chunks[i + 1].text.slice(0, 50);
        
        // Simple overlap detection
        const words1 = chunk1End.split(/\s+/);
        const words2 = chunk2Start.split(/\s+/);
        
        for (let j = 0; j < Math.min(words1.length, 10); j++) {
          if (words2.includes(words1[words1.length - 1 - j])) {
            overlapFound++;
            break;
          }
        }
      }
      
      console.log(`   ├─ Overlapping chunks: ${overlapFound}/${Math.min(chunks.length - 1, 5)}`);
    }

    // Structure analysis
    const hasNumbers = chunks.some(c => /\d+/.test(c.text));
    const hasDates = chunks.some(c => /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(c.text));
    const hasAmounts = chunks.some(c => /\$[\d,]+|\b\d+\.\d{2}\b/.test(c.text));

    console.log(`   ├─ Contains numbers: ${hasNumbers ? '✅' : '❌'}`);
    console.log(`   ├─ Contains dates: ${hasDates ? '✅' : '❌'}`);
    console.log(`   └─ Contains amounts: ${hasAmounts ? '✅' : '❌'}`);
  }

  examineStoreFiles() {
    console.log('\n🏪 ELECTRON STORE FILES');
    console.log('='.repeat(40));

    const storeFiles = [
      'vector_database.json',
      'documents.json',
      'settings.json',
      'conversations.json'
    ];

    storeFiles.forEach(storeFile => {
      const storePath = path.join(this.configPath, storeFile);
      
      if (fs.existsSync(storePath)) {
        const stats = fs.statSync(storePath);
        console.log(`✅ ${storeFile}:`);
        console.log(`   ├─ Size: ${stats.size} bytes`);
        console.log(`   └─ Modified: ${stats.mtime.toLocaleString()}`);
        
        // Try to peek at structure (be careful with encrypted stores)
        try {
          const content = fs.readFileSync(storePath, 'utf-8');
          if (content.startsWith('{')) {
            const data = JSON.parse(content);
            const keys = Object.keys(data);
            console.log(`   └─ Top-level keys: [${keys.join(', ')}]`);
          } else {
            console.log(`   └─ (Encrypted store - cannot read structure)`);
          }
        } catch (error) {
          console.log(`   └─ (Cannot read structure - likely encrypted)`);
        }
      } else {
        console.log(`❌ ${storeFile}: Not found`);
      }
    });
  }

  generateSimpleRecommendations() {
    console.log('\n💡 RECOMMENDATIONS');
    console.log('='.repeat(40));

    if (!fs.existsSync(this.documentsPath)) {
      console.log('❌ No documents found. Upload and process documents first.');
      return;
    }

    const files = fs.readdirSync(this.documentsPath);
    const chunkFiles = files.filter(file => file.endsWith('_chunks.json'));

    if (chunkFiles.length === 0) {
      console.log('❌ No chunk files found. Ensure documents are being processed correctly.');
      return;
    }

    // Analyze latest chunk file
    const latestFile = chunkFiles
      .map(file => ({
        name: file,
        mtime: fs.statSync(path.join(this.documentsPath, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime)[0];

    try {
      const chunks = JSON.parse(fs.readFileSync(
        path.join(this.documentsPath, latestFile.name), 
        'utf-8'
      ));

      const avgLength = chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0) / chunks.length;

      console.log('📊 Based on your latest document:');
      
      if (avgLength > 600) {
        console.log('⚠️ Chunks are quite large (avg: ' + Math.round(avgLength) + ' chars)');
        console.log('   → Consider reducing chunk size to 400-500 for better precision');
      } else if (avgLength < 250) {
        console.log('⚠️ Chunks are quite small (avg: ' + Math.round(avgLength) + ' chars)');
        console.log('   → Consider increasing chunk size to preserve more context');
      } else {
        console.log('✅ Chunk size looks good (avg: ' + Math.round(avgLength) + ' chars)');
      }

      // Check for very short or very long chunks
      const tooShort = chunks.filter(c => (c.text?.length || 0) < 100).length;
      const tooLong = chunks.filter(c => (c.text?.length || 0) > 800).length;

      if (tooShort > chunks.length * 0.1) {
        console.log(`⚠️ ${tooShort} chunks are very short (<100 chars)`);
        console.log('   → Review chunking strategy for better content preservation');
      }

      if (tooLong > chunks.length * 0.1) {
        console.log(`⚠️ ${tooLong} chunks are very long (>800 chars)`);
        console.log('   → Consider smaller chunk sizes for better retrieval accuracy');
      }

    } catch (error) {
      console.log('❌ Could not analyze chunk quality:', error.message);
    }

    console.log('\n🎯 Next Steps:');
    console.log('1. Run the full examination script within your Electron app for complete analysis');
    console.log('2. Test some queries and see if retrieval quality matches expectations');
    console.log('3. Adjust chunking parameters in DocumentService if needed');
  }

  run() {
    console.log('\n🚀 Starting examination...\n');
    
    this.examineFileSystem();
    this.examineStoreFiles();
    this.generateSimpleRecommendations();
    
    console.log('\n✅ Simple examination complete!');
    console.log('\nTo get more detailed analysis including embeddings and vector data,');
    console.log('run the temp_examine_rag_data.js script within your Electron application.');
  }
}

// Run the examination
const examiner = new SimpleRAGExaminer();
examiner.run();
