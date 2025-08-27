const Store = require('electron-store');
const fs = require('fs');
const path = require('path');

/**
 * Temporary script to examine RAG system stored data
 * This script analyzes chunks, embeddings, and metadata
 */

class RAGDataExaminer {
  constructor() {
    // Get user data path first
    let electronUserData;
    try {
      // Try to get electron app path, fallback to Windows user data path if not available
      const { app } = require('electron');
      electronUserData = app.getPath('userData');
      this.documentsPath = path.join(electronUserData, 'documents');
      this.vectorPath = path.join(electronUserData, 'vector_db');
    } catch (error) {
      console.log('⚠️ Running outside Electron context, using Windows AppData path');
      // Windows Electron user data path: %APPDATA%\contract-rag-manager (package name)
      const appDataPath = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
      electronUserData = path.join(appDataPath, 'contract-rag-manager');
      this.documentsPath = path.join(electronUserData, 'documents');
      this.vectorPath = path.join(electronUserData, 'vector_db');
    }

    // Initialize stores (same as the main application) with correct path
    this.vectorStore = new Store({
      name: 'vector_database',
      encryptionKey: 'covenantrix-vector-key-v1',
      cwd: electronUserData  // Use same path as Electron app
    });

    this.documentsStore = new Store({
      name: 'documents',
      encryptionKey: 'covenantrix-docs-key-v1',
      cwd: electronUserData  // Use same path as Electron app
    });
  }

  examineAllData() {
    console.log('🔍 RAG Data Examination Report');
    console.log('='.repeat(50));
    console.log(`📁 Documents Path: ${this.documentsPath}`);
    console.log(`🧠 Vector Path: ${this.vectorPath}`);
    console.log('');

    this.examineDocumentsStore();
    this.examineVectorStore();
    this.examineFileSystemChunks();
  }

  examineDocumentsStore() {
    console.log('📚 DOCUMENTS STORE ANALYSIS');
    console.log('-'.repeat(30));

    const allDocs = this.documentsStore.store;
    const docIds = Object.keys(allDocs);

    console.log(`Total documents: ${docIds.length}`);
    
    if (docIds.length === 0) {
      console.log('No documents found in store.');
      console.log('');
      return;
    }

    // Show latest 3 documents (most recent first)
    const recentDocs = docIds
      .map(id => ({ id, ...allDocs[id] }))
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .slice(0, 3);

    recentDocs.forEach((doc, index) => {
      console.log(`\n📄 Document ${index + 1}: ${doc.fileName}`);
      console.log(`   ID: ${doc.id}`);
      console.log(`   Status: ${doc.status}`);
      console.log(`   Uploaded: ${doc.uploadedAt}`);
      console.log(`   Text Length: ${doc.textLength || 'N/A'} characters`);
      console.log(`   Chunks Count: ${doc.chunksCount || 'N/A'}`);
      console.log(`   Document Type: ${doc.documentType || 'N/A'}`);
      console.log(`   Vectorized: ${doc.vectorized ? '✅' : '❌'}`);
      
      if (doc.processingSteps && doc.processingSteps.length > 0) {
        console.log(`   Processing Steps: ${doc.processingSteps.length}`);
        const lastStep = doc.processingSteps[doc.processingSteps.length - 1];
        console.log(`   Last Step: ${lastStep.step} at ${lastStep.timestamp}`);
      }

      if (doc.vectorizationError) {
        console.log(`   ⚠️ Vectorization Error: ${doc.vectorizationError}`);
      }
    });

    console.log('');
  }

  examineVectorStore() {
    console.log('🧠 VECTOR STORE ANALYSIS');
    console.log('-'.repeat(30));

    const documents = this.vectorStore.get('documents') || {};
    const chunks = this.vectorStore.get('chunks') || {};

    console.log(`Documents in vector store: ${Object.keys(documents).length}`);
    console.log(`Chunks in vector store: ${Object.keys(chunks).length}`);

    if (Object.keys(chunks).length === 0) {
      console.log('No chunks found in vector store.');
      console.log('');
      return;
    }

    // Analyze chunk data
    const chunkArray = Object.values(chunks);
    const withEmbeddings = chunkArray.filter(chunk => chunk.embedding !== null).length;
    const withoutEmbeddings = chunkArray.filter(chunk => chunk.embedding === null).length;
    
    console.log(`Chunks with embeddings: ${withEmbeddings}`);
    console.log(`Chunks without embeddings: ${withoutEmbeddings}`);

    // Analyze chunk lengths
    const lengths = chunkArray.map(chunk => chunk.length || chunk.text?.length || 0);
    const avgLength = lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
    const minLength = lengths.length > 0 ? Math.min(...lengths) : 0;
    const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;

    console.log(`\n📊 Chunk Size Statistics:`);
    console.log(`   Average length: ${avgLength} characters`);
    console.log(`   Min length: ${minLength} characters`);
    console.log(`   Max length: ${maxLength} characters`);

    // Show sample chunks (latest 3)
    const recentChunks = chunkArray
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 3);

    console.log(`\n🔍 Sample Chunks (Latest 3):`);
    recentChunks.forEach((chunk, index) => {
      console.log(`\n   Chunk ${index + 1}:`);
      console.log(`   ├─ ID: ${chunk.id}`);
      console.log(`   ├─ Document: ${chunk.document_id}`);
      console.log(`   ├─ Length: ${chunk.length || chunk.text?.length || 0} chars`);
      console.log(`   ├─ Has Embedding: ${chunk.embedding ? '✅' : '❌'}`);
      console.log(`   ├─ Created: ${chunk.created}`);
      console.log(`   ├─ Sentence Range: ${chunk.sentence_start}-${chunk.sentence_end}`);
      console.log(`   └─ Preview: "${chunk.text.substring(0, 150)}${chunk.text.length > 150 ? '...' : ''}"`);
    });

    console.log('');
  }

  examineFileSystemChunks() {
    console.log('💾 FILE SYSTEM CHUNKS ANALYSIS');
    console.log('-'.repeat(30));

    if (!fs.existsSync(this.documentsPath)) {
      console.log('Documents directory does not exist.');
      console.log('');
      return;
    }

    const files = fs.readdirSync(this.documentsPath);
    const chunkFiles = files.filter(file => file.endsWith('_chunks.json'));
    const textFiles = files.filter(file => file.endsWith('.txt') && !file.includes('_chunks'));

    console.log(`Chunk files found: ${chunkFiles.length}`);
    console.log(`Text files found: ${textFiles.length}`);

    if (chunkFiles.length === 0) {
      console.log('No chunk files found on file system.');
      console.log('');
      return;
    }

    // Examine latest chunk file
    const latestChunkFile = chunkFiles
      .map(file => ({
        name: file,
        stats: fs.statSync(path.join(this.documentsPath, file))
      }))
      .sort((a, b) => b.stats.mtime - a.stats.mtime)[0];

    console.log(`\n📝 Latest Chunk File: ${latestChunkFile.name}`);
    console.log(`   Modified: ${latestChunkFile.stats.mtime}`);
    console.log(`   Size: ${latestChunkFile.stats.size} bytes`);

    try {
      const chunksData = JSON.parse(fs.readFileSync(
        path.join(this.documentsPath, latestChunkFile.name), 
        'utf-8'
      ));

      console.log(`   Chunks in file: ${chunksData.length}`);

      if (chunksData.length > 0) {
        const sample = chunksData[0];
        console.log(`\n   🔍 Sample Chunk Structure:`);
        console.log(`   ├─ ID: ${sample.id}`);
        console.log(`   ├─ Length: ${sample.length || sample.text?.length || 0} chars`);
        console.log(`   ├─ Has sentenceStart: ${sample.sentenceStart !== undefined ? '✅' : '❌'}`);
        console.log(`   ├─ Has sentenceEnd: ${sample.sentenceEnd !== undefined ? '✅' : '❌'}`);
        console.log(`   └─ Text Preview: "${sample.text.substring(0, 150)}${sample.text.length > 150 ? '...' : ''}"`);

        // Analyze chunking quality
        const chunkLengths = chunksData.map(chunk => chunk.text?.length || 0);
        const avgFileChunkLength = Math.round(chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length);
        const variance = chunkLengths.map(len => Math.pow(len - avgFileChunkLength, 2));
        const stdDev = Math.round(Math.sqrt(variance.reduce((a, b) => a + b, 0) / variance.length));

        console.log(`\n   📊 Chunking Quality Analysis:`);
        console.log(`   ├─ Average chunk length: ${avgFileChunkLength} chars`);
        console.log(`   ├─ Standard deviation: ${stdDev} chars`);
        console.log(`   ├─ Min chunk length: ${Math.min(...chunkLengths)} chars`);
        console.log(`   └─ Max chunk length: ${Math.max(...chunkLengths)} chars`);
      }

    } catch (error) {
      console.log(`   ❌ Error reading chunk file: ${error.message}`);
    }

    console.log('');
  }

  generateRecommendations() {
    console.log('💡 RECOMMENDATIONS');
    console.log('-'.repeat(30));

    const chunks = this.vectorStore.get('chunks') || {};
    const chunkArray = Object.values(chunks);
    
    if (chunkArray.length === 0) {
      console.log('No data to analyze for recommendations.');
      return;
    }

    const withoutEmbeddings = chunkArray.filter(chunk => chunk.embedding === null).length;
    const withEmbeddings = chunkArray.filter(chunk => chunk.embedding !== null).length;

    if (withoutEmbeddings > 0) {
      console.log(`⚠️ ${withoutEmbeddings} chunks without embeddings detected`);
      console.log('   → Check OpenAI API key configuration');
      console.log('   → Consider re-processing failed chunks');
    }

    const lengths = chunkArray.map(chunk => chunk.length || chunk.text?.length || 0);
    const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((acc, len) => acc + Math.pow(len - avgLength, 2), 0) / lengths.length;
    
    if (variance > 10000) { // High variance in chunk sizes
      console.log(`⚠️ High variance in chunk sizes detected (σ²=${Math.round(variance)})`);
      console.log('   → Consider adjusting chunking parameters');
      console.log('   → Review document type detection accuracy');
    }

    if (avgLength > 600) {
      console.log(`⚠️ Average chunk size (${Math.round(avgLength)}) larger than recommended (400-500)`);
      console.log('   → Consider reducing chunk size for better retrieval precision');
    }

    if (avgLength < 300) {
      console.log(`⚠️ Average chunk size (${Math.round(avgLength)}) smaller than recommended (400-500)`);
      console.log('   → Consider increasing chunk size to preserve context');
    }

    console.log('');
    console.log('✅ Analysis complete. Review the above findings to optimize your RAG system.');
  }
}

// Run the examination
console.log('Starting RAG Data Examination...\n');

try {
  const examiner = new RAGDataExaminer();
  examiner.examineAllData();
  examiner.generateRecommendations();
} catch (error) {
  console.error('❌ Error during examination:', error);
  console.log('\nIf running outside Electron context, some features may not work.');
  console.log('To run this properly, execute it within your Electron application context.');
}
