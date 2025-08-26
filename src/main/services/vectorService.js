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
          version: '1.2.12',
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

  async generateEmbedding(text) {
    try {
      if (!this.openai) {
        const storedKey = this.settingsStore.get('openai_api_key');
        if (!storedKey) {
          throw new Error('OpenAI API key not configured');
        }
        await this.setupOpenAI(storedKey);
      }

      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('❌ Error generating embedding:', error);
      throw error;
    }
  }

  async addDocument(documentId, chunks, progressCallback = null) {
    try {
      await this.initialize();

      const documents = this.vectorStore.get('documents') || {};
      const chunksStore = this.vectorStore.get('chunks') || {};

      // Process each chunk with progress tracking
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = `${documentId}_chunk_${chunk.id}`;
        
        // Report progress
        if (progressCallback) {
          progressCallback({
            processed: i,
            total: chunks.length,
            current: i + 1,
            percentage: Math.round(((i + 1) / chunks.length) * 100)
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
            created: new Date().toISOString()
          };
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
            created: new Date().toISOString()
          };
        }
      }

      // Update document index
      if (!documents[documentId]) {
        documents[documentId] = {
          id: documentId,
          chunk_count: 0,
          created: new Date().toISOString()
        };
      }
      documents[documentId].chunk_count = chunks.length;
      documents[documentId].updated = new Date().toISOString();

      // Save to store
      this.vectorStore.set('documents', documents);
      this.vectorStore.set('chunks', chunksStore);

      console.log(`✅ Added ${chunks.length} chunks to local vector database`);
      return true;
    } catch (error) {
      console.error('❌ Error adding document to vector database:', error);
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
}

module.exports = VectorService;
