const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');

// Mock Electron app for services that need it
const mockApp = {
  getPath: (name) => {
    if (name === 'userData') {
      const appDataPath = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
      return path.join(appDataPath, 'contract-rag-manager');
    }
    return __dirname;
  }
};

// Set up mock electron environment
require.cache[require.resolve('electron')] = {
  exports: { app: mockApp }
};

const VectorService = require('./src/main/services/vectorService');
const DocumentService = require('./src/main/services/documentService');

class DocumentRevectorizer {
  constructor() {
    console.log('🚀 Initializing Document Revectorizer...');
    
    // Initialize services (same as main app)
    this.vectorService = new VectorService();
    this.documentService = new DocumentService(this.vectorService);
    
    // Get paths
    const userDataPath = mockApp.getPath('userData');
    this.documentsPath = path.join(userDataPath, 'documents');
    
    console.log('📁 Documents path:', this.documentsPath);
  }

  async initialize() {
    try {
      console.log('🔧 Initializing services...');
      await this.vectorService.initialize();
      
      // DON'T pre-load API key - let VectorService.generateEmbedding() handle it
      // This follows the exact same pattern as production code
      console.log('🔑 OpenAI API key will be loaded automatically during embedding generation');
      console.log('✅ Services initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize services:', error.message);
      return false;
    }
  }

  async findChunkFiles() {
    if (!fs.existsSync(this.documentsPath)) {
      console.log('❌ Documents directory does not exist');
      return [];
    }

    const files = fs.readdirSync(this.documentsPath);
    const chunkFiles = files.filter(file => file.endsWith('_chunks.json'));
    
    console.log(`📄 Found ${chunkFiles.length} chunk files`);
    return chunkFiles.map(file => ({
      filename: file,
      documentId: file.replace('_chunks.json', ''),
      path: path.join(this.documentsPath, file)
    }));
  }

  async processChunkFile(chunkFileInfo) {
    try {
      console.log(`\n📝 Processing: ${chunkFileInfo.filename}`);
      
      // Read chunk data
      const chunksData = JSON.parse(fs.readFileSync(chunkFileInfo.path, 'utf8'));
      console.log(`   Chunks: ${chunksData.length}`);
      
      // Check if document already exists in vector store with valid embeddings
      const existingDoc = this.vectorService.vectorStore.get('documents') || {};
      if (existingDoc[chunkFileInfo.documentId]) {
        console.log(`   ⚠️ Document ${chunkFileInfo.documentId} already exists in vector store`);
        const chunks = this.vectorService.vectorStore.get('chunks') || {};
        const docChunks = Object.keys(chunks).filter(key => key.startsWith(chunkFileInfo.documentId));
        
        // Check if chunks have embeddings (new embedding model upgrade)
        const chunksWithEmbeddings = docChunks.filter(key => chunks[key] && chunks[key].embedding);
        
        if (chunksWithEmbeddings.length > 0) {
          console.log(`   ✅ Skipping - already has ${chunksWithEmbeddings.length} vectorized chunks with embeddings`);
          return { skipped: true, reason: 'already_vectorized', chunks: chunksWithEmbeddings.length };
        } else {
          console.log(`   🔄 Document exists but chunks need embeddings - re-vectorizing with text-embedding-3-large`);
        }
      }
      
      // Add document to vector database
      console.log(`   🧠 Starting vectorization...`);
      
      let processed = 0;
      await this.vectorService.addDocument(chunkFileInfo.documentId, chunksData, (progress) => {
        const percent = Math.round((progress.current / progress.total) * 100);
        if (progress.current % 5 === 0 || progress.current === progress.total) {
          console.log(`   📊 Progress: ${progress.current}/${progress.total} (${percent}%)`);
        }
        processed = progress.current;
      });
      
      console.log(`   ✅ Successfully vectorized ${processed} chunks`);
      return { success: true, chunks: processed };
      
    } catch (error) {
      console.error(`   ❌ Error processing ${chunkFileInfo.filename}:`, error.message);
      return { error: error.message };
    }
  }

  async revectorizeAll() {
    console.log('\n🔍 Starting document re-vectorization process...\n');

    // Initialize services
    const initialized = await this.initialize();
    if (!initialized) {
      return false;
    }

    // Find chunk files
    const chunkFiles = await this.findChunkFiles();
    if (chunkFiles.length === 0) {
      console.log('❌ No chunk files found to process');
      return false;
    }

    // Process each chunk file
    const results = [];
    for (const chunkFile of chunkFiles) {
      const result = await this.processChunkFile(chunkFile);
      results.push({ file: chunkFile.filename, ...result });
    }

    // Summary
    console.log('\n📊 REVECTORIZATION SUMMARY');
    console.log('='.repeat(50));
    
    const successful = results.filter(r => r.success);
    const skipped = results.filter(r => r.skipped);
    const failed = results.filter(r => r.error);
    
    console.log(`✅ Successfully processed: ${successful.length}`);
    console.log(`⏭️ Skipped (already done): ${skipped.length}`);
    console.log(`❌ Failed: ${failed.length}`);
    
    if (successful.length > 0) {
      const totalChunks = successful.reduce((sum, r) => sum + r.chunks, 0);
      console.log(`🧠 Total chunks vectorized: ${totalChunks}`);
    }
    
    if (failed.length > 0) {
      console.log('\n❌ Failed files:');
      failed.forEach(f => console.log(`   ${f.file}: ${f.error}`));
    }

    return successful.length > 0;
  }
}

// Run the revectorizer
(async () => {
  try {
    const revectorizer = new DocumentRevectorizer();
    const success = await revectorizer.revectorizeAll();
    
    if (success) {
      console.log('\n🎉 Revectorization completed! Your documents should now be searchable.');
      console.log('💡 Try querying your documents in the application UI.');
    } else {
      console.log('\n⚠️ Revectorization completed with issues. Check the output above.');
    }
    
  } catch (error) {
    console.error('💥 Revectorization failed:', error);
  }
})();
