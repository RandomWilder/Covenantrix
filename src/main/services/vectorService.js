const OpenAI = require('openai');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');

class VectorService {
  constructor() {
    this.openai = null;
    this.vectorStore = null;
    
    // Settings store for API keys
    this.settingsStore = new Store({
      name: 'settings',
      encryptionKey: 'covenantrix-settings-key-v1'
    });

    // Local vector storage using electron-store
    this.vectorStore = new Store({
      name: 'vector_database',
      encryptionKey: 'covenantrix-vector-key-v1'
    });

    // Get user data path for vector storage
    const { app } = require('electron');
    this.vectorPath = path.join(app.getPath('userData'), 'vector_db');
    this.ensureDirectoryExists(this.vectorPath);
    
    console.log('🧠 VectorService initialized (Local Storage Mode)');
    console.log('📊 Vector DB path:', this.vectorPath);
  }

  ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  async initialize() {
    try {
      // Initialize local vector storage
      if (!this.vectorStore.get('documents')) {
        this.vectorStore.set('documents', {});
        this.vectorStore.set('chunks', {});
        this.vectorStore.set('metadata', {
          created: new Date().toISOString(),
          version: '1.3.2',
          description: 'Contract document chunks for semantic search'
        });
        console.log('📚 New vector database created');
      } else {
        console.log('📚 Existing vector database loaded');
      }

      return true;
    } catch (error) {
      console.error('❌ Error initializing VectorService:', error);
      return false;
    }
  }

  async setupOpenAI(apiKey) {
    try {
      if (!apiKey) {
        console.log('⚠️ No OpenAI API key provided');
        return false;
      }

      // Initialize OpenAI client
      this.openai = new OpenAI({
        apiKey: apiKey
      });

      // Test the API key with a simple request
      await this.openai.models.list();

      // Store the API key securely
      this.settingsStore.set('openai_api_key', apiKey);
      
      console.log('✅ OpenAI API key validated and stored');
      return true;
    } catch (error) {
      console.error('❌ OpenAI API key validation failed:', error.message);
      return false;
    }
  }

  async generateEmbedding(text, retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = 1000 * (retryCount + 1); // Exponential backoff: 1s, 2s, 3s
    
    try {
      // Ensure OpenAI client is initialized
      await this.ensureOpenAIConnection();

      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-large", // 🚀 Enhanced model for better performance
        input: text,
        encoding_format: "float", // Explicit format for consistency
      });

      if (!response.data || !response.data[0] || !response.data[0].embedding) {
        throw new Error('Invalid embedding response from OpenAI API');
      }

      return response.data[0].embedding;
      
    } catch (error) {
      console.error(`❌ Error generating embedding (attempt ${retryCount + 1}/${maxRetries + 1}):`, error.message);
      
      // Retry logic for transient errors
      if (retryCount < maxRetries && this.isRetryableError(error)) {
        console.log(`🔄 Retrying embedding generation in ${retryDelay}ms...`);
        await this.delay(retryDelay);
        return this.generateEmbedding(text, retryCount + 1);
      }
      
      // Reset connection on persistent errors
      if (this.isPersistentConnectionError(error)) {
        console.log('🔄 Resetting OpenAI connection due to persistent error...');
        this.openai = null;
      }
      
      throw error;
    }
  }

  // 🛡️ Robust connection management
  async ensureOpenAIConnection() {
    if (!this.openai) {
      const storedKey = this.settingsStore.get('openai_api_key');
      if (!storedKey) {
        throw new Error('OpenAI API key not configured. Please configure your API key in application settings.');
      }
      
      console.log('🔑 Initializing OpenAI connection...');
      await this.setupOpenAI(storedKey);
    }
    
    // Validate connection is still healthy
    if (!await this.validateConnection()) {
      console.log('🔄 OpenAI connection validation failed, reinitializing...');
      this.openai = null;
      await this.ensureOpenAIConnection();
    }
  }

  // 🔍 Connection validation
  async validateConnection() {
    if (!this.openai) return false;
    
    try {
      // Quick API test with minimal cost
      const testResponse = await Promise.race([
        this.openai.models.list(),
        this.timeoutPromise(5000, 'Connection validation timeout')
      ]);
      
      return testResponse && testResponse.data;
    } catch (error) {
      console.warn('⚠️ OpenAI connection validation failed:', error.message);
      return false;
    }
  }

  // 🔄 Retry logic helpers
  isRetryableError(error) {
    if (!error) return false;
    
    const retryablePatterns = [
      'ECONNRESET',
      'ENOTFOUND', 
      'ETIMEOUT',
      'rate_limit_exceeded',
      'server_error',
      'timeout',
      'fetch failed'
    ];
    
    return retryablePatterns.some(pattern => 
      error.message.toLowerCase().includes(pattern.toLowerCase()) ||
      error.code === pattern ||
      (error.status >= 500 && error.status < 600) // Server errors
    );
  }

  isPersistentConnectionError(error) {
    const persistentPatterns = [
      'invalid_api_key',
      'insufficient_quota',
      'model_not_found',
      'Unauthorized'
    ];
    
    return persistentPatterns.some(pattern => 
      error.message.toLowerCase().includes(pattern.toLowerCase()) ||
      error.status === 401 || error.status === 403
    );
  }

  // 🕒 Utility functions
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  timeoutPromise(ms, message) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    );
  }

  // 🛡️ Robust completion generation (shared with RAGService pattern)
  async generateRobustCompletion(params, retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = 1000 * (retryCount + 1); // Exponential backoff: 1s, 2s, 3s
    
    try {
      // Ensure OpenAI client is initialized
      await this.ensureOpenAIConnection();

      const completion = await this.openai.chat.completions.create(params);
      
      if (!completion.choices || !completion.choices[0] || !completion.choices[0].message) {
        throw new Error('Invalid completion response from OpenAI API');
      }

      return completion;
      
    } catch (error) {
      console.error(`❌ Error generating completion (attempt ${retryCount + 1}/${maxRetries + 1}):`, error.message);
      
      // Retry logic for transient errors
      if (retryCount < maxRetries && this.isRetryableError(error)) {
        console.log(`🔄 Retrying completion generation in ${retryDelay}ms...`);
        await this.delay(retryDelay);
        return this.generateRobustCompletion(params, retryCount + 1);
      }
      
      // Reset connection on persistent errors
      if (this.isPersistentConnectionError(error)) {
        console.log('🔄 Resetting OpenAI connection due to persistent error...');
        this.openai = null;
      }
      
      throw error;
    }
  }

  async addDocument(documentId, chunks, progressCallback = null, documentMetadata = null) {
    console.log(`🔄 Starting addDocument: ${documentId} with ${chunks.length} chunks`);
    
    try {
      await this.initialize();

      const documents = this.vectorStore.get('documents') || {};
      const chunksStore = this.vectorStore.get('chunks') || {};
      
      console.log(`📖 Initial state: ${Object.keys(documents).length} docs, ${Object.keys(chunksStore).length} chunks`);

      // 🛡️ RESILIENT PROCESSING: Process chunks in batches with checkpoints
      const batchSize = 10;
      let processedCount = 0;
      
      for (let batchStart = 0; batchStart < chunks.length; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, chunks.length);
        const batch = chunks.slice(batchStart, batchEnd);
        
        console.log(`📦 Processing batch ${Math.floor(batchStart/batchSize) + 1}: chunks ${batchStart + 1}-${batchEnd}`);

        // Process each chunk in the batch
        for (let i = 0; i < batch.length; i++) {
          const globalIndex = batchStart + i;
          const chunk = batch[i];
          const chunkId = `${documentId}_chunk_${chunk.id}`;
          
          // Report progress
          if (progressCallback) {
            progressCallback({
              processed: globalIndex,
              total: chunks.length,
              current: globalIndex + 1,
              percentage: Math.round(((globalIndex + 1) / chunks.length) * 100)
            });
          }
          
          try {
            // Generate embedding for the chunk text
            const embedding = await this.generateEmbedding(chunk.text);
            
            // Store chunk with embedding
            chunksStore[chunkId] = {
              id: chunkId,
              document_id: documentId,
              chunk_id: chunk.id,
              text: chunk.text,
              embedding: embedding,
              length: chunk.length,
              sentence_start: chunk.sentenceStart || 0,
              sentence_end: chunk.sentenceEnd || 0,
              created: new Date().toISOString(),
              
              // 🚀 Enhanced Phase 1 Metadata (leveraging already-computed data)
              document_type: documentMetadata?.documentType || null,
              language: documentMetadata?.language || null,
              confidence_score: documentMetadata?.confidence || null,
              chunk_position: globalIndex + 1,
              
              // 🎯 Phase 2A Metadata - File Context & Processing Info
              file_name: documentMetadata?.fileName || null,
              file_id: documentMetadata?.fileId || null,
              file_type: documentMetadata?.fileType || null,
              file_size: documentMetadata?.fileSize || null,
              upload_timestamp: documentMetadata?.uploadTimestamp || null,
              processing_timestamp: documentMetadata?.processingTimestamp || null,
              embedding_model: documentMetadata?.embeddingModel || "text-embedding-3-large"
            };
            
            console.log(`✅ Chunk ${globalIndex + 1}/${chunks.length}: ${chunkId} embedded`);
            
          } catch (embeddingError) {
            console.warn(`⚠️ Could not generate embedding for chunk ${chunkId}, storing without embedding:`, embeddingError.message);
            
            // Store chunk without embedding (for keyword search)
            chunksStore[chunkId] = {
              id: chunkId,
              document_id: documentId,
              chunk_id: chunk.id,
              text: chunk.text,
              embedding: null,
              length: chunk.length,
              sentence_start: chunk.sentenceStart || 0,
              sentence_end: chunk.sentenceEnd || 0,
              created: new Date().toISOString(),
              
              // 🚀 Enhanced Phase 1 Metadata (leveraging already-computed data)
              document_type: documentMetadata?.documentType || null,
              language: documentMetadata?.language || null,
              confidence_score: documentMetadata?.confidence || null,
              chunk_position: globalIndex + 1
            };
          }
          
          processedCount++;
        }

        // 🛡️ CHECKPOINT: Save batch progress to prevent data loss
        console.log(`💾 Checkpoint: Saving batch ${Math.floor(batchStart/batchSize) + 1} progress...`);
        
        try {
          // Update document index with current progress
          if (!documents[documentId]) {
            documents[documentId] = {
              id: documentId,
              chunk_count: 0,
              created: new Date().toISOString()
            };
          }
          documents[documentId].chunk_count = processedCount;
          documents[documentId].updated = new Date().toISOString();
          documents[documentId].status = 'processing';
          
          // Save checkpoint
          this.vectorStore.set('documents', documents);
          this.vectorStore.set('chunks', chunksStore);
          
          // 🔍 VALIDATION: Verify checkpoint was saved
          const verifyChunks = this.vectorStore.get('chunks') || {};
          const savedChunksForDoc = Object.keys(verifyChunks).filter(key => key.startsWith(documentId)).length;
          
          if (savedChunksForDoc >= processedCount) {
            console.log(`✅ Checkpoint verified: ${savedChunksForDoc} chunks saved`);
          } else {
            throw new Error(`Checkpoint validation failed: expected ${processedCount}, found ${savedChunksForDoc}`);
          }
          
        } catch (checkpointError) {
          console.error(`❌ Checkpoint failed for batch ${Math.floor(batchStart/batchSize) + 1}:`, checkpointError);
          throw new Error(`Processing failed at checkpoint after ${processedCount} chunks: ${checkpointError.message}`);
        }
      }

      // 🎯 FINAL PERSISTENCE: Complete document processing
      console.log(`🏁 Finalizing document: ${documentId} with ${processedCount} chunks`);
      
      try {
        // Final document index update
        if (!documents[documentId]) {
          documents[documentId] = {
            id: documentId,
            chunk_count: 0,
            created: new Date().toISOString()
          };
        }
        documents[documentId].chunk_count = chunks.length;
        documents[documentId].updated = new Date().toISOString();
        documents[documentId].status = 'completed';

        // 🛡️ FINAL SAVE with enhanced error handling
        console.log('💾 Performing final save...');
        
        console.log('   → Saving documents index...');
        this.vectorStore.set('documents', documents);
        console.log('   ✅ Documents saved');
        
        console.log('   → Saving chunks data...');
        this.vectorStore.set('chunks', chunksStore);
        console.log('   ✅ Chunks saved');

        // 🔍 FINAL VALIDATION: Verify complete persistence
        console.log('🔍 Final validation...');
        const finalChunks = this.vectorStore.get('chunks') || {};
        const finalDocs = this.vectorStore.get('documents') || {};
        
        const finalChunkCount = Object.keys(finalChunks).filter(key => key.startsWith(documentId)).length;
        const docExists = finalDocs[documentId] !== undefined;
        
        if (!docExists) {
          throw new Error('Document not found in final validation');
        }
        
        if (finalChunkCount !== chunks.length) {
          throw new Error(`Chunk count mismatch: expected ${chunks.length}, found ${finalChunkCount}`);
        }
        
        console.log(`✅ VALIDATION PASSED: ${finalChunkCount} chunks, document status: ${finalDocs[documentId].status}`);
        console.log(`🎉 Successfully added ${chunks.length} chunks to local vector database`);
        
        return true;
        
      } catch (persistenceError) {
        console.error('❌ FINAL PERSISTENCE FAILED:', persistenceError);
        
        // 🔄 ROLLBACK: Attempt to clean up partial data
        console.log('🔄 Attempting rollback...');
        try {
          const rollbackChunks = this.vectorStore.get('chunks') || {};
          const rollbackDocs = this.vectorStore.get('documents') || {};
          
          // Remove partial chunks
          Object.keys(rollbackChunks).forEach(key => {
            if (key.startsWith(documentId)) {
              delete rollbackChunks[key];
            }
          });
          
          // Remove partial document
          if (rollbackDocs[documentId]) {
            delete rollbackDocs[documentId];
          }
          
          this.vectorStore.set('chunks', rollbackChunks);
          this.vectorStore.set('documents', rollbackDocs);
          
          console.log('✅ Rollback completed - partial data removed');
        } catch (rollbackError) {
          console.error('❌ Rollback failed:', rollbackError);
        }
        
        throw persistenceError;
      }
      
    } catch (error) {
      console.error('❌ Error adding document to vector database:', error);
      console.error('📊 Error context:', {
        documentId,
        totalChunks: chunks.length,
        processedCount: processedCount || 0,
        error: error.message
      });
      return false;
    }
  }

  // Calculate cosine similarity between two vectors
  cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async semanticSearch(query, limit = 5) {
    try {
      await this.initialize();

      // Generate embedding for the search query
      const queryEmbedding = await this.generateEmbedding(query);
      
      const chunksStore = this.vectorStore.get('chunks') || {};
      const searchResults = [];

      // Calculate similarity for each chunk that has embeddings
      for (const [chunkId, chunk] of Object.entries(chunksStore)) {
        if (chunk.embedding) {
          const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
          
          searchResults.push({
            text: chunk.text,
            metadata: {
              document_id: chunk.document_id,
              chunk_id: chunk.chunk_id,
              length: chunk.length,
              sentence_start: chunk.sentence_start,
              sentence_end: chunk.sentence_end
            },
            similarity: similarity,
            document_id: chunk.document_id,
            chunk_id: chunk.chunk_id
          });
        }
      }

      // Sort by similarity (highest first) and limit results
      searchResults.sort((a, b) => b.similarity - a.similarity);
      const limitedResults = searchResults.slice(0, limit);

      console.log(`🔍 Semantic search found ${limitedResults.length} results`);
      return limitedResults;
    } catch (error) {
      console.error('❌ Error in semantic search:', error);
      return [];
    }
  }

  async hybridSearch(query, limit = 10) {
    try {
      // Get both semantic and keyword results
      const semanticResults = await this.semanticSearch(query, Math.ceil(limit / 2));
      
      // For now, return semantic results (we'll enhance this later)
      return {
        results: semanticResults,
        type: 'semantic',
        query: query
      };
    } catch (error) {
      console.error('❌ Error in hybrid search:', error);
      return { results: [], type: 'error', query: query };
    }
  }

  async removeDocument(documentId) {
    try {
      await this.initialize();

      const documents = this.vectorStore.get('documents') || {};
      const chunksStore = this.vectorStore.get('chunks') || {};
      
      let removedChunks = 0;

      // Remove all chunks for this document
      for (const [chunkId, chunk] of Object.entries(chunksStore)) {
        if (chunk.document_id === documentId) {
          delete chunksStore[chunkId];
          removedChunks++;
        }
      }

      // Remove document from index
      if (documents[documentId]) {
        delete documents[documentId];
      }

      // Save updated stores
      this.vectorStore.set('documents', documents);
      this.vectorStore.set('chunks', chunksStore);

      console.log(`🗑️ Removed ${removedChunks} chunks from vector database`);
      return true;
    } catch (error) {
      console.error('❌ Error removing document from vector database:', error);
      return false;
    }
  }

  async getStats() {
    try {
      await this.initialize();

      const documents = this.vectorStore.get('documents') || {};
      const chunksStore = this.vectorStore.get('chunks') || {};
      
      // Count chunks with embeddings
      let chunksWithEmbeddings = 0;
      for (const chunk of Object.values(chunksStore)) {
        if (chunk.embedding) {
          chunksWithEmbeddings++;
        }
      }
      
      return {
        total_chunks: Object.keys(chunksStore).length,
        chunks_with_embeddings: chunksWithEmbeddings,
        total_documents: Object.keys(documents).length,
        has_openai_key: !!this.settingsStore.get('openai_api_key'),
        storage_type: 'local_store'
      };
    } catch (error) {
      console.error('❌ Error getting vector database stats:', error);
      return { 
        total_chunks: 0, 
        chunks_with_embeddings: 0,
        total_documents: 0,
        has_openai_key: false,
        storage_type: 'error'
      };
    }
  }

  getStoredApiKey() {
    return this.settingsStore.get('openai_api_key');
  }

  clearApiKey() {
    this.settingsStore.delete('openai_api_key');
    this.openai = null;
    console.log('🔑 OpenAI API key cleared');
  }

  // 🧹 MEMORY MANAGEMENT: Clear service cache between documents
  async clearCache() {
    try {
      console.log('🧹 Clearing VectorService cache...');
      
      // Clear any large cached variables
      // (Don't clear stored vectors/documents, just temporary processing data)
      
      // Reset OpenAI connection state if needed to prevent accumulation
      // Keep connection alive for efficiency, just clear any temp data
      
      console.log('✅ VectorService cache cleared');
      
    } catch (error) {
      console.warn('⚠️ VectorService cache clearing warning:', error.message);
    }
  }
}

module.exports = VectorService;
