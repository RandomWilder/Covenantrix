const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

class RAGService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/contracts.db');
    this.db = null;
    this.openai = null;
    this.anthropicKey = null;
    this.initPromise = this.initialize();
  }

  async initialize() {
    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    await fs.mkdir(dataDir, { recursive: true });

    // Initialize SQLite database
    await this.initDatabase();
    
    // Initialize API keys (you'll need to set these via settings)
    // For now, we'll use environment variables or settings file
    this.loadApiKeys();
  }

  async initDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Create tables
        const createTables = `
          CREATE TABLE IF NOT EXISTS contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id INTEGER,
            chunk_text TEXT NOT NULL,
            chunk_type TEXT,
            embedding BLOB,
            metadata TEXT,
            page_number INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contract_id) REFERENCES contracts (id)
          );

          CREATE INDEX IF NOT EXISTS idx_contract_filename ON contracts(filename);
          CREATE INDEX IF NOT EXISTS idx_chunk_contract ON chunks(contract_id);
        `;

        this.db.exec(createTables, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  loadApiKeys() {
    // In production, load from secure settings
    // For development, use environment variables
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    
    this.anthropicKey = process.env.ANTHROPIC_API_KEY;
  }

  async processDocument(filePath) {
    await this.initPromise;
    
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let content = '';
    let metadata = {};

    try {
      // Extract text based on file type
      if (ext === '.pdf') {
        const buffer = await fs.readFile(filePath);
        const pdfData = await pdfParse(buffer);
        content = pdfData.text;
        metadata.pageCount = pdfData.numpages;
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
        metadata.warnings = result.messages;
      } else if (ext === '.txt') {
        content = await fs.readFile(filePath, 'utf-8');
      } else {
        throw new Error(`Unsupported file type: ${ext}`);
      }

      // Extract contract-specific metadata
      metadata = { ...metadata, ...this.extractContractMetadata(content) };

      // Store in database
      const contractId = await this.storeContract(filename, filePath, content, metadata);
      
      // Create smart chunks
      const chunks = this.createSmartChunks(content, metadata);
      
      // Generate embeddings and store chunks
      await this.storeChunks(contractId, chunks);

      return {
        success: true,
        contractId,
        filename,
        chunkCount: chunks.length,
        metadata
      };

    } catch (error) {
      console.error('Document processing error:', error);
      return {
        success: false,
        error: error.message,
        filename
      };
    }
  }

  extractContractMetadata(content) {
    const metadata = {};
    
    // Extract parties (simplified pattern matching)
    const partyPatterns = [
      /between\s+([^,\n]+)\s+(?:,\s*)?(?:a\s+.+?company)?(?:\s+\([^)]+\))?\s+and\s+([^,\n]+)/i,
      /this\s+agreement\s+is\s+made\s+between\s+([^,\n]+)\s+and\s+([^,\n]+)/i
    ];
    
    for (const pattern of partyPatterns) {
      const match = content.match(pattern);
      if (match) {
        metadata.party1 = match[1].trim();
        metadata.party2 = match[2].trim();
        break;
      }
    }

    // Extract dates
    const datePattern = /(?:dated?\s+|effective\s+date\s*:?\s*)([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i;
    const dateMatch = content.match(datePattern);
    if (dateMatch) {
      metadata.effectiveDate = dateMatch[1];
    }

    // Extract contract type
    const typePatterns = {
      'Employment Agreement': /employment\s+agreement/i,
      'Service Agreement': /service\s+agreement/i,
      'Lease Agreement': /lease\s+agreement|rental\s+agreement/i,
      'Purchase Agreement': /purchase\s+agreement|sale\s+agreement/i,
      'NDA': /non.disclosure\s+agreement|confidentiality\s+agreement/i,
    };

    for (const [type, pattern] of Object.entries(typePatterns)) {
      if (pattern.test(content)) {
        metadata.contractType = type;
        break;
      }
    }

    return metadata;
  }

  createSmartChunks(content, metadata) {
    const chunks = [];
    
    // Split by common contract sections
    const sectionPatterns = [
      /(?:^|\n)\s*(?:\d+\.?\s*)?(?:ARTICLE|SECTION|CLAUSE)\s+[IVX\d]+[.:]\s*([^\n]+)/gim,
      /(?:^|\n)\s*(?:\d+\.?\s*)([A-Z][A-Z\s]{5,}[.:]\s*)/gm,
      /(?:^|\n)\s*\(([a-z])\)\s*/gm
    ];

    let lastIndex = 0;
    const sections = [];

    // Find section boundaries
    for (const pattern of sectionPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        sections.push({
          start: match.index,
          title: match[1] || match[0].trim(),
          type: 'section'
        });
      }
    }

    sections.sort((a, b) => a.start - b.start);

    // Create chunks based on sections
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const nextSection = sections[i + 1];
      const endIndex = nextSection ? nextSection.start : content.length;
      
      const sectionContent = content.slice(section.start, endIndex);
      
      if (sectionContent.length > 100) { // Only create chunks for substantial content
        chunks.push({
          text: sectionContent.trim(),
          type: 'section',
          title: section.title,
          metadata: {
            sectionIndex: i,
            wordCount: sectionContent.split(/\s+/).length
          }
        });
      }
    }

    // If no sections found, create paragraph-based chunks
    if (chunks.length === 0) {
      const paragraphs = content.split(/\n\s*\n/);
      paragraphs.forEach((para, index) => {
        if (para.trim().length > 100) {
          chunks.push({
            text: para.trim(),
            type: 'paragraph',
            metadata: {
              paragraphIndex: index,
              wordCount: para.split(/\s+/).length
            }
          });
        }
      });
    }

    return chunks;
  }

  async storeContract(filename, filepath, content, metadata) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO contracts (filename, filepath, content, metadata)
        VALUES (?, ?, ?, ?)
      `);
      
      stmt.run([filename, filepath, content, JSON.stringify(metadata)], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  async storeChunks(contractId, chunks) {
    if (!this.openai) {
      console.warn('OpenAI not configured - storing chunks without embeddings');
      // Store without embeddings for now
      for (const chunk of chunks) {
        await this.storeChunk(contractId, chunk, null);
      }
      return;
    }

    // Generate embeddings in batches
    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      try {
        const embeddings = await this.generateEmbeddings(batch.map(c => c.text));
        
        for (let j = 0; j < batch.length; j++) {
          await this.storeChunk(contractId, batch[j], embeddings[j]);
        }
      } catch (error) {
        console.error('Embedding generation error:', error);
        // Store without embeddings as fallback
        for (const chunk of batch) {
          await this.storeChunk(contractId, chunk, null);
        }
      }
    }
  }

  async generateEmbeddings(texts) {
    const response = await this.openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });
    
    return response.data.map(item => item.embedding);
  }

  async storeChunk(contractId, chunk, embedding) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO chunks (contract_id, chunk_text, chunk_type, embedding, metadata)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
      
      stmt.run([
        contractId,
        chunk.text,
        chunk.type,
        embeddingBlob,
        JSON.stringify(chunk.metadata)
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  async queryContracts(queryText, limit = 5) {
    await this.initPromise;
    
    if (!this.openai) {
      // Fallback to text search
      return this.textSearch(queryText, limit);
    }

    try {
      // Generate query embedding
      const queryEmbedding = await this.generateEmbeddings([queryText]);
      
      // Semantic search using embeddings
      return this.semanticSearch(queryEmbedding[0], limit);
      
    } catch (error) {
      console.error('Query error:', error);
      // Fallback to text search
      return this.textSearch(queryText, limit);
    }
  }

  async textSearch(queryText, limit) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT c.filename, ch.chunk_text, ch.chunk_type, ch.metadata,
               c.metadata as contract_metadata
        FROM chunks ch
        JOIN contracts c ON ch.contract_id = c.id
        WHERE ch.chunk_text LIKE ?
        ORDER BY c.created_at DESC
        LIMIT ?
      `;
      
      this.db.all(sql, [`%${queryText}%`, limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => ({
          filename: row.filename,
          content: row.chunk_text,
          type: row.chunk_type,
          confidence: 0.5, // Placeholder
          metadata: JSON.parse(row.metadata || '{}'),
          contractMetadata: JSON.parse(row.contract_metadata || '{}')
        })));
      });
    });
  }

  async semanticSearch(queryEmbedding, limit) {
    // For SQLite, we'll implement a simple cosine similarity
    // In production, consider using vector databases like Pinecone or Weaviate
    
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT c.filename, ch.chunk_text, ch.chunk_type, ch.embedding,
               ch.metadata, c.metadata as contract_metadata
        FROM chunks ch
        JOIN contracts c ON ch.contract_id = c.id
        WHERE ch.embedding IS NOT NULL
        ORDER BY c.created_at DESC
      `;
      
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        // Calculate similarities
        const results = rows.map(row => {
          const embedding = new Float32Array(row.embedding);
          const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));
          
          return {
            filename: row.filename,
            content: row.chunk_text,
            type: row.chunk_type,
            confidence: similarity,
            metadata: JSON.parse(row.metadata || '{}'),
            contractMetadata: JSON.parse(row.contract_metadata || '{}')
          };
        });

        // Sort by similarity and limit
        results.sort((a, b) => b.confidence - a.confidence);
        resolve(results.slice(0, limit));
      });
    });
  }

  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = RAGService;