const OpenAI = require('openai');
const Store = require('electron-store');
const VectorService = require('./vectorService');
const DocumentService = require('./documentService');

class RAGService {
  constructor() {
    this.openai = null;
    this.vectorService = new VectorService();
    this.documentService = new DocumentService();
    
    // Settings store for configurations
    this.settingsStore = new Store({
      name: 'settings',
      encryptionKey: 'covenantrix-settings-key-v1'
    });

    // Conversation store for chat history
    this.conversationStore = new Store({
      name: 'conversations',
      encryptionKey: 'covenantrix-conversations-key-v1'
    });
    
    console.log('🤖 RAGService initialized for conversational contract analysis');
  }

  async initialize() {
    try {
      await this.vectorService.initialize();
      
      // Initialize OpenAI if API key exists
      const apiKey = this.settingsStore.get('openai_api_key');
      if (apiKey) {
        await this.setupOpenAI(apiKey);
      }
      
      console.log('✅ RAG Service initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ Error initializing RAG Service:', error);
      return false;
    }
  }

  async setupOpenAI(apiKey) {
    try {
      this.openai = new OpenAI({ apiKey });
      
      // Test the connection
      await this.openai.models.list();
      console.log('✅ OpenAI client initialized for RAG');
      return true;
    } catch (error) {
      console.error('❌ OpenAI setup failed:', error);
      return false;
    }
  }

  // Generate contract-aware prompts based on query type
  generatePrompt(query, context, queryType = 'general') {
    const baseInstructions = `You are Covenantrix, an expert legal document analyst specializing in contract analysis. You help users understand their legal documents through intelligent analysis.

CONTEXT: You have access to relevant sections from the user's uploaded legal documents shown below.

INSTRUCTIONS:
- Provide accurate, helpful analysis based ONLY on the provided document context
- If information isn't in the context, clearly state "I don't see this information in your uploaded documents"
- Always cite which document section you're referencing
- For Hebrew/Arabic content, preserve the original text direction and formatting
- Be professional but conversational
- Focus on practical legal insights

`;

    const querySpecificInstructions = {
      'general': 'Answer the user\'s question comprehensively using the document context.',
      'parties': 'Identify and analyze the parties mentioned in the contracts, their roles, and relationships.',
      'terms': 'Focus on contract terms, conditions, and key provisions.',
      'dates': 'Identify and analyze important dates, deadlines, and time-sensitive clauses.',
      'liability': 'Analyze liability, indemnification, and risk allocation clauses.',
      'termination': 'Focus on termination conditions, notice requirements, and end-of-contract provisions.',
      'payment': 'Analyze payment terms, amounts, schedules, and financial obligations.',
      'confidentiality': 'Focus on confidentiality, non-disclosure, and privacy provisions.'
    };

    const instruction = querySpecificInstructions[queryType] || querySpecificInstructions['general'];

    return `${baseInstructions}

SPECIFIC TASK: ${instruction}

DOCUMENT CONTEXT:
${context}

USER QUESTION: ${query}

RESPONSE:`;
  }

  // Detect query intent for better prompt selection
  detectQueryType(query) {
    const queryLower = query.toLowerCase();
    
    if (queryLower.includes('parties') || queryLower.includes('who') || queryLower.includes('entity') || queryLower.includes('company')) {
      return 'parties';
    } else if (queryLower.includes('payment') || queryLower.includes('money') || queryLower.includes('cost') || queryLower.includes('fee')) {
      return 'payment';
    } else if (queryLower.includes('date') || queryLower.includes('when') || queryLower.includes('deadline') || queryLower.includes('expire')) {
      return 'dates';
    } else if (queryLower.includes('terminate') || queryLower.includes('end') || queryLower.includes('cancel')) {
      return 'termination';
    } else if (queryLower.includes('liability') || queryLower.includes('responsible') || queryLower.includes('indemnif')) {
      return 'liability';
    } else if (queryLower.includes('confidential') || queryLower.includes('secret') || queryLower.includes('disclosure')) {
      return 'confidentiality';
    } else if (queryLower.includes('term') || queryLower.includes('condition') || queryLower.includes('clause')) {
      return 'terms';
    }
    
    return 'general';
  }

  // Format context from search results for LLM
  formatContext(searchResults) {
    if (!searchResults || searchResults.length === 0) {
      return "No relevant document sections found.";
    }

    return searchResults.map((result, index) => {
      const similarity = result.avgSimilarity || result.similarity || 0;
      const documentName = result.document ? result.document.originalName : 'Unknown Document';
      
      let formattedChunks = '';
      if (result.chunks) {
        formattedChunks = result.chunks.map((chunk, chunkIndex) => {
          const chunkSimilarity = chunk.similarity ? ` (${Math.round(chunk.similarity * 100)}% match)` : '';
          return `[Chunk ${chunkIndex + 1}${chunkSimilarity}]: ${chunk.text}`;
        }).join('\n\n');
      } else if (result.text) {
        const resultSimilarity = similarity ? ` (${Math.round(similarity * 100)}% match)` : '';
        formattedChunks = `[Content${resultSimilarity}]: ${result.text}`;
      }

      return `--- Document: ${documentName} ---\n${formattedChunks}`;
    }).join('\n\n');
  }

  // Main RAG query method
  async queryDocuments(query, conversationId = null, options = {}) {
    try {
      if (!this.openai) {
        const apiKey = this.settingsStore.get('openai_api_key');
        if (!apiKey) {
          throw new Error('OpenAI API key not configured. Please add your API key in settings.');
        }
        await this.setupOpenAI(apiKey);
      }

      const {
        maxResults = 5,
        useConversationContext = true,
        searchType = 'hybrid'
      } = options;

      console.log(`🤖 RAG Query: "${query}"`);

      // Step 1: Retrieve relevant context using existing search
      const searchResults = await this.documentService.searchDocuments(query, searchType);
      
      if (searchResults.length === 0) {
        return {
          response: "I don't find any relevant information in your uploaded documents for this query. Please make sure you have uploaded documents that contain information related to your question.",
          sources: [],
          conversationId: conversationId || this.generateConversationId()
        };
      }

      // Step 2: Format context for LLM
      const context = this.formatContext(searchResults.slice(0, maxResults));
      
      // Step 3: Detect query type for specialized prompts
      const queryType = this.detectQueryType(query);
      
      // Step 4: Generate appropriate prompt
      const prompt = this.generatePrompt(query, context, queryType);

      // Step 5: Get conversation history if requested
      let messages = [{ role: 'user', content: prompt }];
      if (useConversationContext && conversationId) {
        const history = this.getConversationHistory(conversationId);
        if (history.length > 0) {
          // Add recent context (last 4 exchanges to avoid token limits)
          const recentHistory = history.slice(-8); // 4 user + 4 assistant messages
          messages = [...recentHistory, { role: 'user', content: prompt }];
        }
      }

      // Step 6: Generate LLM response
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: messages,
        temperature: 0.3, // Lower temperature for more factual responses
        max_tokens: 1000,
        stream: false
      });

      const response = completion.choices[0].message.content;

      // Step 7: Save conversation
      const finalConversationId = conversationId || this.generateConversationId();
      this.saveConversationTurn(finalConversationId, query, response, searchResults);

      console.log(`✅ RAG Response generated (${response.length} chars)`);

      return {
        response: response,
        sources: searchResults.map(result => ({
          document: result.document.originalName,
          matches: result.matches,
          similarity: result.avgSimilarity || result.similarity,
          chunks: result.chunks ? result.chunks.length : 1
        })),
        conversationId: finalConversationId,
        queryType: queryType
      };

    } catch (error) {
      console.error('❌ RAG Query failed:', error);
      
      // Fallback to search-only response
      try {
        const searchResults = await this.documentService.searchDocuments(query, 'keyword');
        return {
          response: `I encountered an error generating a detailed response, but I found ${searchResults.length} relevant sections in your documents. ${error.message.includes('API key') ? 'Please check your OpenAI API key configuration.' : 'Please try rephrasing your question.'}`,
          sources: searchResults.map(result => ({
            document: result.document.originalName,
            matches: result.matches,
            chunks: result.chunks ? result.chunks.length : 1
          })),
          conversationId: conversationId || this.generateConversationId(),
          error: error.message
        };
      } catch (fallbackError) {
        throw new Error(`RAG query failed: ${error.message}`);
      }
    }
  }

  // Conversation management
  generateConversationId() {
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  saveConversationTurn(conversationId, query, response, sources) {
    try {
      const conversations = this.conversationStore.get('conversations', {});
      
      if (!conversations[conversationId]) {
        conversations[conversationId] = {
          id: conversationId,
          created: new Date().toISOString(),
          messages: []
        };
      }

      conversations[conversationId].messages.push({
        timestamp: new Date().toISOString(),
        query: query,
        response: response,
        sources: sources ? sources.length : 0
      });

      conversations[conversationId].updated = new Date().toISOString();
      
      // Keep only last 50 conversations to manage storage
      const conversationIds = Object.keys(conversations);
      if (conversationIds.length > 50) {
        const sortedConversations = conversationIds
          .map(id => ({ id, updated: conversations[id].updated }))
          .sort((a, b) => new Date(b.updated) - new Date(a.updated));
        
        // Remove oldest conversations
        sortedConversations.slice(50).forEach(conv => {
          delete conversations[conv.id];
        });
      }

      this.conversationStore.set('conversations', conversations);
    } catch (error) {
      console.error('❌ Error saving conversation:', error);
    }
  }

  getConversationHistory(conversationId) {
    try {
      const conversations = this.conversationStore.get('conversations', {});
      const conversation = conversations[conversationId];
      
      if (!conversation) return [];

      // Convert to OpenAI message format
      const messages = [];
      conversation.messages.forEach(turn => {
        messages.push({ role: 'user', content: turn.query });
        messages.push({ role: 'assistant', content: turn.response });
      });

      return messages;
    } catch (error) {
      console.error('❌ Error getting conversation history:', error);
      return [];
    }
  }

  getAllConversations() {
    try {
      const conversations = this.conversationStore.get('conversations', {});
      return Object.values(conversations)
        .sort((a, b) => new Date(b.updated) - new Date(a.updated))
        .map(conv => ({
          id: conv.id,
          created: conv.created,
          updated: conv.updated,
          messageCount: conv.messages.length,
          lastQuery: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].query.substring(0, 100) : ''
        }));
    } catch (error) {
      console.error('❌ Error getting conversations:', error);
      return [];
    }
  }

  deleteConversation(conversationId) {
    try {
      const conversations = this.conversationStore.get('conversations', {});
      if (conversations[conversationId]) {
        delete conversations[conversationId];
        this.conversationStore.set('conversations', conversations);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error deleting conversation:', error);
      return false;
    }
  }

  clearAllConversations() {
    try {
      this.conversationStore.set('conversations', {});
      return true;
    } catch (error) {
      console.error('❌ Error clearing conversations:', error);
      return false;
    }
  }
}

module.exports = RAGService;
