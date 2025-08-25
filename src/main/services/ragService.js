const OpenAI = require('openai');
const Store = require('electron-store');
const VectorService = require('./vectorService');
const DocumentService = require('./documentService');

class RAGService {
  constructor(vectorService = null, documentService = null) {
    this.openai = null;
    
    // Use injected services or create new ones (backward compatibility)
    this.vectorService = vectorService || new VectorService();
    this.documentService = documentService || new DocumentService();
    
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
    
    const injectionStatus = vectorService && documentService ? '(injected)' : '(self-created)';
    console.log(`🤖 RAGService initialized for conversational contract analysis ${injectionStatus}`);
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

  // Generate optimized contract-aware prompts based on query type
  generatePrompt(query, context, queryType = 'general') {
    const baseInstructions = `You are Covenantrix, expert legal analyst for contract analysis.

LANGUAGE: Respond in the SAME language as the user's query. Maintain their formality level.

ANALYSIS FRAMEWORK: 1) IDENTIFY provision type 2) INTERPRET meaning 3) ANALYZE implications 4) ASSESS risks/ambiguities 5) CITE sources

INSTRUCTIONS:
- Base analysis ONLY on provided document context
- State clearly if information missing from documents  
- Cite specific document sections with precision
- Preserve Hebrew/Arabic text direction when quoting
- Focus on practical, actionable legal insights
- Highlight risks and important considerations
- State limitations when uncertain

`;

    const querySpecificInstructions = {
      'general': 'Apply framework comprehensively. Focus on practical implications.',
      'parties': 'Identify parties, capacity, roles. Analyze relationships and obligations.',
      'terms': 'Identify key terms. Interpret meaning. Analyze enforceability.',
      'dates': 'Identify dates/deadlines. Analyze time obligations. Assess compliance risks.',
      'liability': 'Analyze liability allocation. Identify risk distribution. Assess scope.',
      'termination': 'Analyze termination triggers. Identify notice requirements. Assess post-termination duties.',
      'payment': 'Analyze payment terms. Identify penalties. Assess dispute resolution.',
      'confidentiality': 'Analyze confidentiality scope. Identify exceptions. Assess enforcement.',
      'interpretation': 'Interpret ambiguous provisions. Analyze meanings. Assess legal soundness.',
      'enforceability': 'Analyze binding nature. Identify enforceability issues. Assess remedies.',
      'compliance': 'Identify compliance requirements. Analyze obligations. Assess non-compliance risks.',
      'risk_assessment': 'Identify legal/business risks. Analyze impact. Assess mitigation strategies.',
      'amendment': 'Analyze amendment procedures. Identify modification requirements.',
      'breach': 'Identify breach scenarios. Analyze consequences. Assess notice/cure requirements.'
    };

    const instruction = querySpecificInstructions[queryType] || querySpecificInstructions['general'];

    return `${baseInstructions}

TASK: ${instruction}

CONTEXT:
${context}

QUERY: ${query}

RESPONSE:`;
  }

  // Alternative minimal prompt for high-confidence scenarios
  generateMinimalPrompt(query, context, queryType = 'general') {
    const minimalInstructions = `Legal analyst. Respond in user's language. ${queryType}: ${query}

${context}

Analysis:`;
    
    return minimalInstructions;
  }

  // Smart prompt selection based on confidence and complexity
  selectOptimalPrompt(query, context, queryType, confidenceScore) {
    // Use minimal prompt for high-confidence, simple queries
    if (confidenceScore.overall >= 0.8 && query.length < 50 && 
        ['parties', 'dates', 'payment'].includes(queryType)) {
      console.log('📝 Using minimal prompt for high-confidence simple query');
      return this.generateMinimalPrompt(query, context, queryType);
    }
    
    // Use full prompt for complex or low-confidence queries
    return this.generatePrompt(query, context, queryType);
  }

  // Estimate token count (rough approximation: 1 token ≈ 4 characters)
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  // Log token usage for monitoring
  logTokenUsage(prompt, response, queryType, isMinimal = false) {
    const promptTokens = this.estimateTokens(prompt);
    const responseTokens = this.estimateTokens(response);
    const totalTokens = promptTokens + responseTokens;
    const estimatedCost = (totalTokens / 1000) * 0.03; // GPT-4 pricing
    
    console.log(`💰 Token Usage | Type: ${queryType} | Prompt: ${promptTokens} | Response: ${responseTokens} | Total: ${totalTokens} | Cost: ~$${estimatedCost.toFixed(4)} | Minimal: ${isMinimal}`);
    
    return { promptTokens, responseTokens, totalTokens, estimatedCost, isMinimal };
  }

  // Advanced contract type classification
  classifyContractType(searchResults) {
    if (!searchResults || searchResults.length === 0) return 'unknown';
    
    const contractPatterns = {
      employment: {
        keywords: ['employee', 'salary', 'benefits', 'position', 'termination', 'non-compete', 'employment agreement'],
        weight: 0
      },
      saas: {
        keywords: ['software', 'service', 'subscription', 'API', 'uptime', 'SLA', 'cloud', 'platform'],
        weight: 0
      },
      nda: {
        keywords: ['confidential', 'non-disclosure', 'proprietary', 'trade secret', 'confidentiality agreement'],
        weight: 0
      },
      real_estate: {
        keywords: ['property', 'lease', 'rent', 'premises', 'landlord', 'tenant', 'real estate'],
        weight: 0
      },
      services: {
        keywords: ['services', 'consulting', 'professional', 'deliverables', 'milestones', 'work order'],
        weight: 0
      },
      procurement: {
        keywords: ['purchase', 'supplier', 'goods', 'delivery', 'warranty', 'procurement', 'vendor'],
        weight: 0
      },
      partnership: {
        keywords: ['partnership', 'joint venture', 'collaboration', 'alliance', 'partner'],
        weight: 0
      }
    };

    // Analyze all search result text
    const fullText = searchResults.map(result => {
      if (result.chunks) {
        return result.chunks.map(chunk => chunk.text).join(' ');
      }
      return result.text || '';
    }).join(' ').toLowerCase();

    // Calculate pattern weights
    for (const [type, pattern] of Object.entries(contractPatterns)) {
      pattern.keywords.forEach(keyword => {
        const matches = (fullText.match(new RegExp(keyword, 'gi')) || []).length;
        pattern.weight += matches;
      });
    }

    // Find best match
    const bestMatch = Object.entries(contractPatterns)
      .sort(([,a], [,b]) => b.weight - a.weight)[0];
    
    const contractType = bestMatch[1].weight > 0 ? bestMatch[0] : 'general';
    console.log(`📋 Contract type classified: ${contractType} (confidence: ${bestMatch[1].weight})`);
    
    return contractType;
  }

  // Analyze contract risks based on type and content
  analyzeContractRisks(searchResults, contractType) {
    const riskFactors = {
      financial: { score: 0, issues: [] },
      legal: { score: 0, issues: [] },
      operational: { score: 0, issues: [] },
      compliance: { score: 0, issues: [] }
    };

    const riskPatterns = {
      high_risk: {
        keywords: ['unlimited liability', 'penalty', 'liquidated damages', 'indemnif', 'automatic renewal', 'non-compete'],
        impact: 3
      },
      medium_risk: {
        keywords: ['termination fee', 'exclusivity', 'governing law', 'dispute resolution', 'force majeure'],
        impact: 2
      },
      compliance_risk: {
        keywords: ['gdpr', 'hipaa', 'sox', 'regulatory', 'compliance', 'audit'],
        impact: 2
      }
    };

    const fullText = searchResults.map(result => {
      if (result.chunks) {
        return result.chunks.map(chunk => chunk.text).join(' ');
      }
      return result.text || '';
    }).join(' ').toLowerCase();

    // Analyze risk patterns
    for (const [riskLevel, pattern] of Object.entries(riskPatterns)) {
      pattern.keywords.forEach(keyword => {
        if (fullText.includes(keyword)) {
          if (riskLevel.includes('compliance')) {
            riskFactors.compliance.score += pattern.impact;
            riskFactors.compliance.issues.push(keyword);
          } else {
            riskFactors.legal.score += pattern.impact;
            riskFactors.legal.issues.push(keyword);
          }
        }
      });
    }

    // Contract-type specific risk analysis
    const contractSpecificRisks = {
      employment: ['non-compete', 'confidentiality', 'termination'],
      saas: ['data security', 'uptime', 'liability'],
      real_estate: ['maintenance', 'insurance', 'default'],
      services: ['deliverables', 'timeline', 'payment']
    };

    const typeRisks = contractSpecificRisks[contractType] || [];
    typeRisks.forEach(risk => {
      if (fullText.includes(risk)) {
        riskFactors.operational.score += 1;
        riskFactors.operational.issues.push(risk);
      }
    });

    // Calculate overall risk level
    const totalRisk = Object.values(riskFactors).reduce((sum, factor) => sum + factor.score, 0);
    const riskLevel = totalRisk >= 8 ? 'HIGH' : totalRisk >= 4 ? 'MEDIUM' : 'LOW';

    console.log(`⚠️ Contract risk analysis: ${riskLevel} (total score: ${totalRisk})`);

    return {
      overall: riskLevel,
      totalScore: totalRisk,
      factors: riskFactors
    };
  }

  // Generate intelligent follow-up questions based on context
  generateFollowUpQuestions(queryType, contractType, riskAnalysis, queryLanguage = 'english') {
    const baseQuestions = {
      parties: [
        'Who are the guarantors or subsidiaries?',
        'What happens if a party is acquired?',
        'Are there any third-party beneficiaries?'
      ],
      payment: [
        'What are the penalties for late payment?',
        'Is there a dispute resolution process for payment issues?',
        'Are there any automatic payment adjustments?'
      ],
      termination: [
        'What notice period is required?',
        'What obligations survive termination?',
        'Are there any termination fees?'
      ],
      liability: [
        'What are the liability caps?',
        'Are there any carve-outs from limitation?',
        'How does indemnification work?'
      ],
      risk_assessment: [
        'What are the biggest risks in this contract?',
        'How can these risks be mitigated?',
        'Are there any unusual terms?'
      ]
    };

    // Contract-type specific questions
    const contractSpecificQuestions = {
      employment: [
        'What are the restrictive covenants?',
        'What benefits are included?',
        'How does termination work?'
      ],
      saas: [
        'What are the SLA requirements?',
        'How is data handled?',
        'What happens during downtime?'
      ],
      nda: [
        'What information is considered confidential?',
        'How long does confidentiality last?',
        'What are the permitted disclosures?'
      ],
      real_estate: [
        'Who handles maintenance?',
        'What are the renewal terms?',
        'Are there any restrictions on use?'
      ]
    };

    // Risk-based questions
    const riskBasedQuestions = {
      HIGH: [
        'What are the highest risk provisions?',
        'How can we mitigate these risks?',
        'Should we negotiate these terms?'
      ],
      MEDIUM: [
        'Are there any concerning provisions?',
        'What should we monitor going forward?'
      ],
      LOW: [
        'Are there any optimization opportunities?',
        'What are the key performance requirements?'
      ]
    };

    let questions = [];
    
    // Add base questions for query type
    if (baseQuestions[queryType]) {
      questions.push(...baseQuestions[queryType]);
    }
    
    // Add contract-specific questions
    if (contractSpecificQuestions[contractType]) {
      questions.push(...contractSpecificQuestions[contractType]);
    }
    
    // Add risk-based questions
    if (riskBasedQuestions[riskAnalysis.overall]) {
      questions.push(...riskBasedQuestions[riskAnalysis.overall]);
    }

    // Limit to top 5 most relevant questions
    const relevantQuestions = questions.slice(0, 5);

    console.log(`💡 Generated ${relevantQuestions.length} follow-up questions`);
    
    return relevantQuestions;
  }

  // Generate executive summary of contract analysis
  generateExecutiveSummary(contractType, riskAnalysis, searchResults) {
    const keyPoints = [];
    
    // Contract overview
    keyPoints.push(`Contract Type: ${contractType.charAt(0).toUpperCase() + contractType.slice(1)}`);
    keyPoints.push(`Risk Level: ${riskAnalysis.overall}`);
    
    // Key risk factors
    if (riskAnalysis.factors.legal.issues.length > 0) {
      keyPoints.push(`Legal Concerns: ${riskAnalysis.factors.legal.issues.slice(0, 3).join(', ')}`);
    }
    
    if (riskAnalysis.factors.compliance.issues.length > 0) {
      keyPoints.push(`Compliance Items: ${riskAnalysis.factors.compliance.issues.slice(0, 2).join(', ')}`);
    }
    
    // Document statistics
    const totalChunks = searchResults.reduce((sum, result) => 
      sum + (result.chunks ? result.chunks.length : 1), 0);
    keyPoints.push(`Document Coverage: ${searchResults.length} sections, ${totalChunks} analyzed chunks`);
    
    return {
      overview: `This ${contractType} contract has a ${riskAnalysis.overall} risk profile.`,
      keyPoints: keyPoints,
      riskScore: riskAnalysis.totalScore,
      recommendations: riskAnalysis.overall === 'HIGH' ? 
        ['Review high-risk provisions carefully', 'Consider legal consultation', 'Negotiate risk mitigation'] :
        riskAnalysis.overall === 'MEDIUM' ?
        ['Monitor key provisions', 'Clarify ambiguous terms'] :
        ['Standard contract monitoring', 'Focus on performance metrics']
    };
  }

  // Detect query language for multilingual support
  detectQueryLanguage(query) {
    // Simple language detection based on common patterns
    const patterns = {
      hebrew: /[\u0590-\u05FF]/,
      arabic: /[\u0600-\u06FF]/,
      spanish: /(¿|ñ|¡)/,
      french: /(à|è|é|ê|ë|ï|î|ô|ù|û|ç)/,
      german: /(ä|ö|ü|ß)/,
      russian: /[\u0400-\u04FF]/,
      chinese: /[\u4e00-\u9fff]/,
      japanese: /[\u3040-\u309f\u30a0-\u30ff]/
    };

    for (const [language, pattern] of Object.entries(patterns)) {
      if (pattern.test(query)) {
        return language;
      }
    }
    
    return 'english'; // Default fallback
  }

  // Detect query intent for better prompt selection with advanced categories
  detectQueryType(query) {
    const queryLower = query.toLowerCase();
    
    // Enhanced query type detection with priority order (more specific first)
    const queryPatterns = {
      'interpretation': ['mean', 'interpret', 'unclear', 'define', 'explain', 'understand', 'clarify', 'ambiguous'],
      'enforceability': ['enforce', 'binding', 'valid', 'legal effect', 'enforceable', 'legally binding'],
      'compliance': ['comply', 'regulation', 'requirement', 'law', 'regulatory', 'legal requirement'],
      'risk_assessment': ['risk', 'danger', 'problem', 'issue', 'concern', 'potential problem'],
      'breach': ['violate', 'breach', 'default', 'non-compliance', 'violation', 'breaking'],
      'amendment': ['change', 'modify', 'amend', 'alter', 'update', 'revision'],
      
      // Original categories enhanced
      'parties': ['parties', 'who', 'entity', 'company', 'contracting parties', 'signatories'],
      'payment': ['payment', 'money', 'cost', 'fee', 'price', 'amount', 'financial', 'invoice'],
      'dates': ['date', 'when', 'deadline', 'expire', 'timeline', 'schedule', 'time'],
      'termination': ['terminate', 'end', 'cancel', 'expiry', 'conclusion', 'dissolution'],
      'liability': ['liability', 'responsible', 'indemnif', 'liable', 'accountability', 'fault'],
      'confidentiality': ['confidential', 'secret', 'disclosure', 'private', 'proprietary', 'non-disclosure'],
      'terms': ['term', 'condition', 'clause', 'provision', 'stipulation', 'requirement']
    };

    // Check each pattern type for matches
    for (const [type, keywords] of Object.entries(queryPatterns)) {
      for (const keyword of keywords) {
        if (queryLower.includes(keyword)) {
          return type;
        }
      }
    }
    
    return 'general';
  }

  // Format context from search results for LLM with professional citations
  formatContext(searchResults) {
    if (!searchResults || searchResults.length === 0) {
      return "No relevant document sections found.";
    }

    return searchResults.map((result, index) => {
      const similarity = result.avgSimilarity || result.similarity || 0;
      const documentName = result.document ? result.document.originalName : 'Unknown Document';
      const confidenceLevel = this.getConfidenceLevel(similarity);
      
      // Generate professional citation reference
      const citationId = `REF-${index + 1}`;
      
      let formattedChunks = '';
      if (result.chunks) {
        formattedChunks = result.chunks.map((chunk, chunkIndex) => {
          const chunkSimilarity = chunk.similarity ? ` (${Math.round(chunk.similarity * 100)}% relevance)` : '';
          const chunkRef = `${citationId}.${chunkIndex + 1}`;
          
          return `[${chunkRef}] ${chunk.text}${chunkSimilarity}`;
        }).join('\n\n');
      } else if (result.text) {
        const resultSimilarity = similarity ? ` (${Math.round(similarity * 100)}% relevance)` : '';
        formattedChunks = `[${citationId}] ${result.text}${resultSimilarity}`;
      }

      // Professional document citation format
      const documentCitation = `📄 SOURCE ${citationId}: "${documentName}" | Confidence: ${confidenceLevel}`;
      
      return `${documentCitation}\n${formattedChunks}`;
    }).join('\n\n─────────────────────────────────────\n\n');
  }

  // Helper method to determine confidence level from similarity scores
  getConfidenceLevel(similarity) {
    if (similarity >= 0.8) return 'HIGH';
    if (similarity >= 0.6) return 'MEDIUM';
    if (similarity >= 0.4) return 'LOW';
    return 'MINIMAL';
  }

  // Calculate comprehensive response confidence score
  calculateResponseConfidence(searchResults, queryType, query) {
    if (!searchResults || searchResults.length === 0) {
      return {
        overall: 0.1,
        factors: {
          sourceRelevance: 0.0,
          contextCompleteness: 0.0,
          queryTypeConfidence: 0.5,
          responseQuality: 0.1
        },
        level: 'MINIMAL',
        explanation: 'No relevant sources found in uploaded documents'
      };
    }

    // 1. Source Relevance (40% weight)
    const avgSimilarity = searchResults.reduce((sum, result) => 
      sum + (result.avgSimilarity || result.similarity || 0), 0) / searchResults.length;
    const sourceRelevance = Math.min(avgSimilarity, 1.0);

    // 2. Context Completeness (30% weight)
    const totalChunks = searchResults.reduce((sum, result) => 
      sum + (result.chunks ? result.chunks.length : 1), 0);
    const contextCompleteness = Math.min(totalChunks / 5, 1.0); // Optimal around 5 chunks

    // 3. Query Type Confidence (20% weight)
    const specificQueryTypes = ['interpretation', 'enforceability', 'compliance', 'risk_assessment'];
    const queryTypeConfidence = specificQueryTypes.includes(queryType) ? 0.9 : 
                                queryType !== 'general' ? 0.8 : 0.6;

    // 4. Response Quality Indicator (10% weight)
    const queryLength = query.length;
    const responseQuality = queryLength > 10 && queryLength < 200 ? 0.8 : 0.6;

    // Calculate weighted overall score
    const overall = (sourceRelevance * 0.4) + 
                   (contextCompleteness * 0.3) + 
                   (queryTypeConfidence * 0.2) + 
                   (responseQuality * 0.1);

    // Determine confidence level and explanation
    let level, explanation;
    if (overall >= 0.8) {
      level = 'HIGH';
      explanation = 'Strong source relevance with comprehensive context';
    } else if (overall >= 0.6) {
      level = 'MEDIUM';
      explanation = 'Good source matches with adequate context';
    } else if (overall >= 0.4) {
      level = 'LOW';
      explanation = 'Limited source relevance or incomplete context';
    } else {
      level = 'MINIMAL';
      explanation = 'Weak source matches with insufficient context';
    }

    return {
      overall: Math.round(overall * 100) / 100,
      factors: {
        sourceRelevance: Math.round(sourceRelevance * 100) / 100,
        contextCompleteness: Math.round(contextCompleteness * 100) / 100,
        queryTypeConfidence: Math.round(queryTypeConfidence * 100) / 100,
        responseQuality: Math.round(responseQuality * 100) / 100
      },
      level,
      explanation
    };
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

      // Step 1: Detect query language for multilingual support
      const queryLanguage = this.detectQueryLanguage(query);
      console.log(`🌍 Detected query language: ${queryLanguage}`);

      // Step 2: Retrieve relevant context using existing search
      const searchResults = await this.documentService.searchDocuments(query, searchType);
      
      if (searchResults.length === 0) {
        // Return language-appropriate "no results" message
        const noResultsMessage = queryLanguage === 'hebrew' ? 
          "אני לא מוצא מידע רלוונטי במסמכים שהועלו עבור השאלה הזו. אנא וודא שהעלת מסמכים המכילים מידע הקשור לשאלתך." :
          queryLanguage === 'arabic' ?
          "لا أجد أي معلومات ذات صلة في المستندات التي تم تحميلها لهذا الاستفسار. يرجى التأكد من تحميل مستندات تحتوي على معلومات متعلقة بسؤالك." :
          "I don't find any relevant information in your uploaded documents for this query. Please make sure you have uploaded documents that contain information related to your question.";
        
        return {
          response: noResultsMessage,
          sources: [],
          conversationId: conversationId || this.generateConversationId(),
          queryLanguage: queryLanguage
        };
      }

      // Step 3: Format context for LLM
      const context = this.formatContext(searchResults.slice(0, maxResults));
      
            // Step 4: Detect query type for specialized prompts
      const queryType = this.detectQueryType(query);
      console.log(`🎯 Detected query type: ${queryType}`);
      
      // Step 5: Advanced contract intelligence analysis
      const contractType = this.classifyContractType(searchResults);
      const riskAnalysis = this.analyzeContractRisks(searchResults, contractType);
      const executiveSummary = this.generateExecutiveSummary(contractType, riskAnalysis, searchResults);
      
      // Step 6: Calculate response confidence
      const confidenceScore = this.calculateResponseConfidence(searchResults, queryType, query);
      console.log(`📊 Response confidence: ${confidenceScore.level} (${Math.round(confidenceScore.overall * 100)}%)`);
      
      // Step 7: Generate smart follow-up questions
      const followUpQuestions = this.generateFollowUpQuestions(queryType, contractType, riskAnalysis, queryLanguage);
      
      // Step 8: Select optimal prompt based on confidence and complexity
      const prompt = this.selectOptimalPrompt(query, context, queryType, confidenceScore);

      // Step 9: Get conversation history if requested
      let messages = [{ role: 'user', content: prompt }];
      if (useConversationContext && conversationId) {
        const history = this.getConversationHistory(conversationId);
        if (history.length > 0) {
          // Add recent context (last 4 exchanges to avoid token limits)
          const recentHistory = history.slice(-8); // 4 user + 4 assistant messages
          messages = [...recentHistory, { role: 'user', content: prompt }];
        }
      }

      // Step 10: Generate LLM response
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: messages,
        temperature: 0.3, // Lower temperature for more factual responses
        max_tokens: 1000,
        stream: false
      });

      const response = completion.choices[0].message.content;

      // Step 11: Log token usage for optimization tracking
      const isMinimalPrompt = prompt.includes('Legal analyst. Respond in user\'s language');
      const tokenUsage = this.logTokenUsage(prompt, response, queryType, isMinimalPrompt);

      // Step 12: Save conversation
      const finalConversationId = conversationId || this.generateConversationId();
      this.saveConversationTurn(finalConversationId, query, response, searchResults);

      console.log(`✅ Professional RAG Response | ${response.length} chars | ${queryLanguage} | ${contractType} contract | ${riskAnalysis.overall} risk | ${confidenceScore.level} confidence`);

      return {
        response: response,
        
        // Enhanced source information
        sources: searchResults.map(result => ({
          document: result.document.originalName,
          matches: result.matches,
          similarity: result.avgSimilarity || result.similarity,
          chunks: result.chunks ? result.chunks.length : 1
        })),
        
        // Core metadata
        conversationId: finalConversationId,
        queryType: queryType,
        queryLanguage: queryLanguage,
        confidence: confidenceScore,
        tokenUsage: tokenUsage,
        
        // 🚀 NEW: Contract Intelligence Features
        contractIntelligence: {
          contractType: contractType,
          riskAnalysis: riskAnalysis,
          executiveSummary: executiveSummary,
          followUpQuestions: followUpQuestions,
          timestamp: new Date().toISOString()
        }
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

  // 🚀 NEW: Generate comprehensive contract health report
  async generateContractHealthReport(documentIds = null, options = {}) {
    try {
      console.log('📊 Generating comprehensive contract health report...');
      
      // Get documents to analyze
      const documents = documentIds ? 
        documentIds.map(id => this.documentService.getDocument(id)).filter(Boolean) :
        this.documentService.getAllDocuments();
      
      if (documents.length === 0) {
        return {
          error: 'No documents found for health report generation',
          totalDocuments: 0
        };
      }

      const healthAnalysis = {
        totalDocuments: documents.length,
        contractTypes: {},
        riskDistribution: { HIGH: 0, MEDIUM: 0, LOW: 0 },
        commonIssues: {},
        overallScore: 0,
        recommendations: [],
        generatedAt: new Date().toISOString()
      };

      // Analyze each document
      for (const document of documents) {
        try {
          // Simulate search results for analysis
          const mockSearchResults = [{
            document: document,
            text: document.extractedText || '',
            chunks: document.chunks || []
          }];

          const contractType = this.classifyContractType(mockSearchResults);
          const riskAnalysis = this.analyzeContractRisks(mockSearchResults, contractType);

          // Update aggregated statistics
          healthAnalysis.contractTypes[contractType] = (healthAnalysis.contractTypes[contractType] || 0) + 1;
          healthAnalysis.riskDistribution[riskAnalysis.overall] += 1;

          // Collect common issues
          Object.values(riskAnalysis.factors).forEach(factor => {
            factor.issues.forEach(issue => {
              healthAnalysis.commonIssues[issue] = (healthAnalysis.commonIssues[issue] || 0) + 1;
            });
          });

        } catch (docError) {
          console.warn(`⚠️ Could not analyze document ${document.originalName}:`, docError.message);
        }
      }

      // Calculate overall health score (0-100)
      const riskWeights = { LOW: 100, MEDIUM: 60, HIGH: 20 };
      const totalDocs = documents.length;
      healthAnalysis.overallScore = Math.round(
        (healthAnalysis.riskDistribution.LOW * riskWeights.LOW +
         healthAnalysis.riskDistribution.MEDIUM * riskWeights.MEDIUM +
         healthAnalysis.riskDistribution.HIGH * riskWeights.HIGH) / totalDocs
      );

      // Generate recommendations
      if (healthAnalysis.riskDistribution.HIGH > 0) {
        healthAnalysis.recommendations.push('Review high-risk contracts immediately');
        healthAnalysis.recommendations.push('Consider legal consultation for risk mitigation');
      }
      
      if (healthAnalysis.riskDistribution.HIGH + healthAnalysis.riskDistribution.MEDIUM > totalDocs * 0.5) {
        healthAnalysis.recommendations.push('Implement contract review process improvements');
      }

      // Identify most common issues
      const topIssues = Object.entries(healthAnalysis.commonIssues)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([issue, count]) => ({ issue, count, percentage: Math.round((count / totalDocs) * 100) }));

      healthAnalysis.topIssues = topIssues;

      console.log(`✅ Contract health report generated | Overall Score: ${healthAnalysis.overallScore}/100 | Documents: ${totalDocs}`);

      return healthAnalysis;

    } catch (error) {
      console.error('❌ Error generating contract health report:', error);
      return {
        error: error.message,
        totalDocuments: 0
      };
    }
  }
}

module.exports = RAGService;
