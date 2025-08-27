const OpenAI = require('openai');
const Store = require('electron-store');
const VectorService = require('./vectorService');
const DocumentService = require('./documentService');
const PersonaService = require('./personaService');

class RAGService {
  constructor(vectorService = null, documentService = null) {
    this.openai = null;
    
    // Use injected services or create new ones (backward compatibility)
    this.vectorService = vectorService || new VectorService();
    this.documentService = documentService || new DocumentService();
    this.personaService = new PersonaService();
    
    // Settings store for configurations
    this.settingsStore = new Store({
      name: 'settings',
      encryptionKey: 'covenantrix-settings-key-v1'
    });

    // Conversation store for chat history - now organized by persona
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
      
      // Initialize PersonaService from saved settings
      this.personaService.initializeFromSettings();
      
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

  // 🛡️ Robust completion generation with retry logic
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

  // 🛡️ Robust connection management
  async ensureOpenAIConnection() {
    if (!this.openai) {
      const storedKey = this.settingsStore.get('openai_api_key');
      if (!storedKey) {
        throw new Error('OpenAI API key not configured. Please configure your API key in application settings.');
      }
      
      console.log('🔑 Initializing RAG OpenAI connection...');
      await this.setupOpenAI(storedKey);
    }
    
    // Validate connection is still healthy
    if (!await this.validateConnection()) {
      console.log('🔄 RAG OpenAI connection validation failed, reinitializing...');
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
      console.warn('⚠️ RAG OpenAI connection validation failed:', error.message);
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

  // Generate optimized contract-aware prompts based on query type and current persona
  generatePrompt(query, context, queryType = 'general') {
    // Use PersonaService to generate persona-specific prompt
    return this.personaService.generatePersonaPrompt(query, context, queryType);
  }

  // Generate budget-aware prompt using PersonaService
  generateBudgetAwarePrompt(query, context, queryType, confidenceScore) {
    return this.personaService.generateBudgetAwarePrompt(query, context, queryType, confidenceScore);
  }

  // Alternative minimal prompt for high-confidence scenarios
  generateMinimalPrompt(query, context, queryType = 'general') {
    const minimalInstructions = `Legal analyst. Respond in user's language. ${queryType}: ${query}

${context}

Analysis:`;
    
    return minimalInstructions;
  }

  // Smart prompt selection based on confidence, complexity, and budget
  selectOptimalPrompt(query, context, queryType, confidenceScore) {
    // Try budget-aware prompt first
    const budgetAwarePrompt = this.generateBudgetAwarePrompt(query, context, queryType, confidenceScore.overall);
    
    // Validate prompt fits within budget
    if (this.personaService.validatePromptBudget(budgetAwarePrompt)) {
      const budget = this.personaService.getUserTokenBudget();
      console.log(`💰 Using ${budget.budgetTier} budget-aware prompt (${this.estimateTokens(budgetAwarePrompt)} tokens)`);
      return budgetAwarePrompt;
    }

    // Fallback to minimal prompt if budget exceeded
    console.log('⚠️ Budget exceeded, falling back to minimal prompt');
    return this.generateMinimalPrompt(query, context, queryType);
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

  // Advanced contract type classification with multilingual support
  classifyContractType(searchResults) {
    if (!searchResults || searchResults.length === 0) return 'unknown';
    
    const contractPatterns = {
      employment: {
        english: ['employee', 'salary', 'benefits', 'position', 'termination', 'non-compete', 'employment agreement', 'job', 'work'],
        hebrew: ['עובד', 'משכורת', 'זכויות', 'תפקיד', 'סיום עבודה', 'הסכם עבודה', 'עבודה', 'עובדים', 'מעסיק', 'מעביד'],
        weight: 0
      },
      saas: {
        english: ['software', 'service', 'subscription', 'API', 'uptime', 'SLA', 'cloud', 'platform', 'system', 'application'],
        hebrew: ['תוכנה', 'שירות', 'מנוי', 'מערכת', 'פלטפורמה', 'אפליקציה', 'מחשב', 'דיגיטלי', 'טכנולוגי'],
        weight: 0
      },
      nda: {
        english: ['confidential', 'non-disclosure', 'proprietary', 'trade secret', 'confidentiality agreement', 'secret'],
        hebrew: ['סודי', 'סודיות', 'הסכם סודיות', 'מידע סודי', 'סוד מסחרי', 'חסוי', 'אי גילוי'],
        weight: 0
      },
      real_estate: {
        english: ['property', 'lease', 'rent', 'premises', 'landlord', 'tenant', 'real estate', 'apartment', 'building'],
        hebrew: ['נכס', 'שכירות', 'דירה', 'בניין', 'משכיר', 'שוכר', 'נדלן', 'מקרקעין', 'דמי שכירות'],
        weight: 0
      },
      services: {
        english: ['services', 'consulting', 'professional', 'deliverables', 'milestones', 'work order', 'contractor'],
        hebrew: ['שירותים', 'ייעוץ', 'יעץ', 'קבלן', 'עבודות', 'שירות', 'מתן שירותים', 'יועץ'],
        weight: 0
      },
      procurement: {
        english: ['purchase', 'supplier', 'goods', 'delivery', 'warranty', 'procurement', 'vendor', 'buy', 'order'],
        hebrew: ['קנייה', 'רכישה', 'ספק', 'סחורה', 'אספקה', 'משלוח', 'אחריות', 'זמנה', 'הזמנה'],
        weight: 0
      },
      partnership: {
        english: ['partnership', 'joint venture', 'collaboration', 'alliance', 'partner', 'cooperation'],
        hebrew: ['שותפות', 'שותף', 'שיתוף פעולה', 'שותפים', 'בריתות', 'קואופרציה', 'משותף'],
        weight: 0
      },
      loan: {
        english: ['loan', 'credit', 'lending', 'borrower', 'lender', 'interest', 'mortgage', 'finance'],
        hebrew: ['הלוואה', 'אשראי', 'משכנתה', 'לוה', 'מלווה', 'ריבית', 'מימון', 'כספי'],
        weight: 0
      },
      distribution: {
        english: ['distribution', 'distributor', 'reseller', 'sales', 'territory', 'exclusive', 'agent'],
        hebrew: ['הפצה', 'מפיץ', 'מכירות', 'זכיינות', 'בלעדיות', 'סוכן', 'נציג'],
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

    // Calculate pattern weights for both Hebrew and English
    for (const [type, pattern] of Object.entries(contractPatterns)) {
      // Check English keywords
      if (pattern.english) {
        pattern.english.forEach(keyword => {
          const matches = (fullText.match(new RegExp(keyword, 'gi')) || []).length;
          pattern.weight += matches;
        });
      }
      
      // Check Hebrew keywords (case-sensitive for Hebrew)
      if (pattern.hebrew) {
        const originalText = searchResults.map(result => {
          if (result.chunks) {
            return result.chunks.map(chunk => chunk.text).join(' ');
          }
          return result.text || '';
        }).join(' ');
        
        pattern.hebrew.forEach(keyword => {
          const matches = (originalText.match(new RegExp(keyword, 'g')) || []).length;
          pattern.weight += matches * 1.2; // Slight Hebrew bonus for better matching
        });
      }
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
        english: ['unlimited liability', 'penalty', 'liquidated damages', 'indemnif', 'automatic renewal', 'non-compete', 'severe'],
        hebrew: ['אחריות בלתי מוגבלת', 'קנס', 'פיצויים קבועים', 'שיפוי', 'חידוש אוטומטי', 'איסור תחרות', 'חמור'],
        impact: 3
      },
      medium_risk: {
        english: ['termination fee', 'exclusivity', 'governing law', 'dispute resolution', 'force majeure', 'breach'],
        hebrew: ['דמי סיום', 'בלעדיות', 'דין החל', 'יישוב סכסוכים', 'כוח עליון', 'הפרה'],
        impact: 2
      },
      compliance_risk: {
        english: ['gdpr', 'hipaa', 'sox', 'regulatory', 'compliance', 'audit', 'regulation'],
        hebrew: ['תקנות', 'ציות', 'ביקורת', 'רגולציה', 'חוקי', 'פיקוח', 'תקינות'],
        impact: 2
      },
      financial_risk: {
        english: ['guarantee', 'security', 'collateral', 'deposit', 'credit', 'debt', 'payment default'],
        hebrew: ['ערבות', 'בטחון', 'פיקדון', 'אשראי', 'חוב', 'אי תשלום', 'ביטחונות'],
        impact: 2.5
      }
    };

    const fullText = searchResults.map(result => {
      if (result.chunks) {
        return result.chunks.map(chunk => chunk.text).join(' ');
      }
      return result.text || '';
    }).join(' ').toLowerCase();

    // Get original text for Hebrew pattern matching
    const originalText = searchResults.map(result => {
      if (result.chunks) {
        return result.chunks.map(chunk => chunk.text).join(' ');
      }
      return result.text || '';
    }).join(' ');

    // Analyze risk patterns (Hebrew and English)
    for (const [riskLevel, pattern] of Object.entries(riskPatterns)) {
      // Check English patterns
      if (pattern.english) {
        pattern.english.forEach(keyword => {
          if (fullText.includes(keyword)) {
            this.categorizeRisk(riskLevel, keyword, pattern.impact, riskFactors);
          }
        });
      }
      
      // Check Hebrew patterns
      if (pattern.hebrew) {
        pattern.hebrew.forEach(keyword => {
          if (originalText.includes(keyword)) {
            this.categorizeRisk(riskLevel, keyword, pattern.impact * 1.1, riskFactors); // Slight Hebrew bonus
          }
        });
      }
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

  // Generate intelligent follow-up questions based on context (multilingual)
  generateFollowUpQuestions(queryType, contractType, riskAnalysis, queryLanguage = 'english') {
    const baseQuestions = {
      parties: queryLanguage === 'hebrew' ? [
        'מי הם הערבים או החברות הבנות?',
        'מה קורה אם צד נרכש על ידי חברה אחרת?',
        'האם יש צדדים שלישיים מוטבים?'
      ] : [
        'Who are the guarantors or subsidiaries?',
        'What happens if a party is acquired?',
        'Are there any third-party beneficiaries?'
      ],
      payment: queryLanguage === 'hebrew' ? [
        'מה הקנסות על איחור בתשלום?',
        'האם יש הליך יישוב סכסוכים לבעיות תשלום?',
        'האם יש התאמות תשלום אוטומטיות?'
      ] : [
        'What are the penalties for late payment?',
        'Is there a dispute resolution process for payment issues?',
        'Are there any automatic payment adjustments?'
      ],
      termination: queryLanguage === 'hebrew' ? [
        'איזה זמן הודעה נדרש?',
        'אילו התחייבויות שורדות את הסיום?',
        'האם יש דמי סיום?'
      ] : [
        'What notice period is required?',
        'What obligations survive termination?',
        'Are there any termination fees?'
      ],
      liability: queryLanguage === 'hebrew' ? [
        'מה הם מגבלות האחריות?',
        'האם יש חריגים מההגבלה?',
        'איך עובד השיפוי?'
      ] : [
        'What are the liability caps?',
        'Are there any carve-outs from limitation?',
        'How does indemnification work?'
      ],
      risk_assessment: queryLanguage === 'hebrew' ? [
        'מה הסיכונים הגדולים ביותר בחוזה הזה?',
        'איך אפשר למתן את הסיכונים האלו?',
        'האם יש תנאים חריגים?'
      ] : [
        'What are the biggest risks in this contract?',
        'How can these risks be mitigated?',
        'Are there any unusual terms?'
      ]
    };

    // Contract-type specific questions (multilingual)
    const contractSpecificQuestions = {
      employment: queryLanguage === 'hebrew' ? [
        'מה האיסורים והמגבלות?',
        'אילו זכויות כלולות?',
        'איך עובד הסיום?'
      ] : [
        'What are the restrictive covenants?',
        'What benefits are included?',
        'How does termination work?'
      ],
      real_estate: queryLanguage === 'hebrew' ? [
        'מי אחראי על התחזוקה?',
        'מה תנאי החידוש?',
        'האם יש הגבלות על השימוש?'
      ] : [
        'Who handles maintenance?',
        'What are the renewal terms?',
        'Are there any restrictions on use?'
      ],
      nda: queryLanguage === 'hebrew' ? [
        'איזה מידע נחשב סודי?',
        'כמה זמן נמשכת הסודיות?',
        'מה הגילויים המותרים?'
      ] : [
        'What information is considered confidential?',
        'How long does confidentiality last?',
        'What are the permitted disclosures?'
      ],
      saas: [
        'What are the SLA requirements?',
        'How is data handled?',
        'What happens during downtime?'
      ]
    };

    // Risk-based questions (multilingual)
    const riskBasedQuestions = {
      HIGH: queryLanguage === 'hebrew' ? [
        'מה ההוראות עם הסיכון הגבוה ביותר?',
        'איך אפשר למתן את הסיכונים האלה?',
        'האם כדאי לנהל משא ומתן על התנאים האלה?'
      ] : [
        'What are the highest risk provisions?',
        'How can we mitigate these risks?',
        'Should we negotiate these terms?'
      ],
      MEDIUM: queryLanguage === 'hebrew' ? [
        'האם יש הוראות מדאיגות?',
        'על מה כדאי לעקוב בהמשך?'
      ] : [
        'Are there any concerning provisions?',
        'What should we monitor going forward?'
      ],
      LOW: queryLanguage === 'hebrew' ? [
        'האם יש הזדמנויות לייעול?',
        'מה דרישות הביצוע המרכזיות?'
      ] : [
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

  // Detect query intent for better prompt selection with multilingual support
  detectQueryType(query) {
    const queryLower = query.toLowerCase();
    
    // Enhanced query type detection with Hebrew & English patterns
    const queryPatterns = {
      'interpretation': {
        english: ['mean', 'interpret', 'unclear', 'define', 'explain', 'understand', 'clarify', 'ambiguous'],
        hebrew: ['משמעות', 'פירוש', 'מה זה אומר', 'להבין', 'להסביר', 'לפרש', 'מה הכוונה', 'פירושו']
      },
      'enforceability': {
        english: ['enforce', 'binding', 'valid', 'legal effect', 'enforceable', 'legally binding'],
        hebrew: ['אכיפה', 'ואכיפ', 'מחייב', 'תוקף', 'בתוקף', 'תקף', 'חוקי', 'מחייבות']
      },
      'compliance': {
        english: ['comply', 'regulation', 'requirement', 'law', 'regulatory', 'legal requirement'],
        hebrew: ['ציות', 'תקנה', 'דרישה', 'חוק', 'חובה', 'חוקי', 'הוראות', 'חוקים']
      },
      'risk_assessment': {
        english: ['risk', 'danger', 'problem', 'issue', 'concern', 'potential problem'],
        hebrew: ['סיכון', 'סכנה', 'בעיה', 'בעיות', 'חשש', 'דאגה', 'סיכונים', 'בעיתי']
      },
      'breach': {
        english: ['violate', 'breach', 'default', 'non-compliance', 'violation', 'breaking'],
        hebrew: ['הפרה', 'הפר', 'מפר', 'חלף', 'עבירה', 'הפרות', 'מפירה']
      },
      'amendment': {
        english: ['change', 'modify', 'amend', 'alter', 'update', 'revision'],
        hebrew: ['שינוי', 'תיקון', 'עדכון', 'שנה', 'לשנות', 'תיקונים', 'שינויים', 'לתקן']
      },
      'parties': {
        english: ['parties', 'who', 'entity', 'company', 'contracting parties', 'signatories'],
        hebrew: ['צדדים', 'צד', 'מי', 'גורם', 'חברה', 'הצדדים', 'חותמים', 'בעלי']
      },
      'payment': {
        english: ['payment', 'money', 'cost', 'fee', 'price', 'amount', 'financial', 'invoice'],
        hebrew: ['תשלום', 'כסף', 'עלות', 'דמי', 'מחיר', 'סכום', 'כספי', 'חשבון', 'תשלומים']
      },
      'dates': {
        english: ['date', 'when', 'deadline', 'expire', 'timeline', 'schedule', 'time'],
        hebrew: ['תאריך', 'מתי', 'תאריכים', 'פג', 'לוח זמנים', 'זמן', 'מועד', 'תאריכי']
      },
      'termination': {
        english: ['terminate', 'end', 'cancel', 'expiry', 'conclusion', 'dissolution'],
        hebrew: ['סיום', 'סיים', 'לסיים', 'ביטול', 'ביטל', 'פקיעה', 'סיימת', 'פקע']
      },
      'liability': {
        english: ['liability', 'responsible', 'indemnif', 'liable', 'accountability', 'fault'],
        hebrew: ['אחריות', 'אחראי', 'חבות', 'חב', 'שיפוי', 'פיצוי', 'חבים', 'נזק']
      },
      'confidentiality': {
        english: ['confidential', 'secret', 'disclosure', 'private', 'proprietary', 'non-disclosure'],
        hebrew: ['סודי', 'סודיות', 'סוד', 'חשוף', 'חשיפה', 'פרטי', 'גילוי', 'חסוי']
      },
      'terms': {
        english: ['term', 'condition', 'clause', 'provision', 'stipulation', 'requirement'],
        hebrew: ['תנאי', 'תנאים', 'הוראה', 'סעיף', 'הוראות', 'סעיפים', 'תניה', 'תנאיי']
      }
    };

    // Check each pattern type for matches (Hebrew and English)
    for (const [type, patterns] of Object.entries(queryPatterns)) {
      // Check Hebrew patterns
      if (patterns.hebrew) {
        for (const keyword of patterns.hebrew) {
          if (query.includes(keyword)) {
            return type;
          }
        }
      }
      // Check English patterns
      if (patterns.english) {
        for (const keyword of patterns.english) {
          if (queryLower.includes(keyword)) {
            return type;
          }
        }
      }
    }
    
    return 'general';
  }

  // Helper method to categorize risk factors
  categorizeRisk(riskLevel, keyword, impact, riskFactors) {
    if (riskLevel.includes('compliance')) {
      riskFactors.compliance.score += impact;
      riskFactors.compliance.issues.push(keyword);
    } else if (riskLevel.includes('financial')) {
      riskFactors.financial.score += impact;
      riskFactors.financial.issues.push(keyword);
    } else if (riskLevel.includes('operational')) {
      riskFactors.operational.score += impact;
      riskFactors.operational.issues.push(keyword);
    } else {
      riskFactors.legal.score += impact;
      riskFactors.legal.issues.push(keyword);
    }
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

    // 1. Source Relevance (35% weight) - enhanced for multilingual
    const avgSimilarity = searchResults.reduce((sum, result) => 
      sum + (result.avgSimilarity || result.similarity || 0), 0) / searchResults.length;
    
    // Boost confidence for specialized queries and better matching
    const sourceRelevance = queryType !== 'general' ? 
      Math.min(avgSimilarity * 1.6, 1.0) : // Specialized queries get bonus
      Math.min(avgSimilarity * 1.3, 1.0);

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

    // Calculate weighted overall score (adjusted weights)
    const overall = (sourceRelevance * 0.45) + 
                   (contextCompleteness * 0.25) + 
                   (queryTypeConfidence * 0.2) + 
                   (responseQuality * 0.1);

    // Determine confidence level and explanation (adjusted thresholds for multilingual)
    let level, explanation;
    if (overall >= 0.75) {
      level = 'HIGH';
      explanation = 'Strong source relevance with comprehensive context';
    } else if (overall >= 0.55) {
      level = 'MEDIUM';
      explanation = 'Good source matches with adequate context';
    } else if (overall >= 0.35) {
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
        searchType = 'hybrid',
        folderId = null, // Optional folder filtering
        documentId = null // 🎯 NEW: Optional document filtering (highest priority)
      } = options;

      // Priority logging: Document > Folder > All
      if (documentId) {
        console.log(`🤖 RAG Query: "${query}" [🎯 Document: ${documentId}]`);
      } else if (folderId) {
        console.log(`🤖 RAG Query: "${query}" [📁 Folder: ${folderId}]`);
      } else {
        console.log(`🤖 RAG Query: "${query}" [📚 All Documents]`);
      }

      // Step 1: Detect query language for multilingual support
      const queryLanguage = this.detectQueryLanguage(query);
      console.log(`🌍 Detected query language: ${queryLanguage}`);

      // Step 2: Retrieve relevant context with priority filtering
      // Priority: Document focus > Folder focus > All documents
      let searchResults;
      if (documentId) {
        // 🎯 Highest priority: Search within specific document
        searchResults = await this.documentService.searchInDocument(query, documentId, searchType);
      } else if (folderId) {
        // 📁 Medium priority: Search within specific folder
        searchResults = await this.documentService.searchDocumentsInFolder(query, folderId, searchType);
      } else {
        // 📚 Default: Search all documents
        searchResults = await this.documentService.searchDocuments(query, searchType);
      }
      
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

      // Step 10: Generate LLM response with robust connection management
      const completion = await this.generateRobustCompletion({
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
        
        // 🎯 Context metadata (priority: document > folder > all)
        documentId: documentId, // Highest priority context
        documentName: documentId ? this.documentService.getDocument(documentId)?.originalName : null,
        folderId: !documentId ? folderId : null, // Only show folder if no document focus
        folderName: (!documentId && folderId) ? this.documentService.folderService.getFolder(folderId)?.name : null,
        
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
      const currentPersona = this.personaService.getCurrentPersona();
      
      if (!conversations[conversationId]) {
        conversations[conversationId] = {
          id: conversationId,
          persona: currentPersona, // Associate conversation with persona
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
      const currentPersona = this.personaService.getCurrentPersona();
      
      // Only return history if conversation belongs to current persona
      if (!conversation || (conversation.persona && conversation.persona !== currentPersona)) {
        return [];
      }

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
      const currentPersona = this.personaService.getCurrentPersona();
      
      return Object.values(conversations)
        .filter(conv => !conv.persona || conv.persona === currentPersona) // Filter by current persona
        .sort((a, b) => new Date(b.updated) - new Date(a.updated))
        .map(conv => ({
          id: conv.id,
          persona: conv.persona || 'legacy',
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

  // 🎭 PERSONA MANAGEMENT METHODS

  // Get current persona information
  getCurrentPersona() {
    return this.personaService.getCurrentPersonaDefinition();
  }

  // Get all available personas
  getAllPersonas() {
    return this.personaService.getAllPersonas();
  }

  // 💰 TOKEN BUDGET MANAGEMENT METHODS

  // Get user's token budget settings
  getUserTokenBudget() {
    return this.personaService.getUserTokenBudget();
  }

  // Set user's token budget settings
  setUserTokenBudget(budget) {
    return this.personaService.setUserTokenBudget(budget);
  }

  // Switch to a different persona
  switchPersona(personaId) {
    const success = this.personaService.switchPersona(personaId);
    if (success) {
      console.log(`🎭 RAGService: Switched to ${personaId} persona`);
    }
    return success;
  }

  // Clear conversations for current persona only
  clearCurrentPersonaConversations() {
    try {
      const conversations = this.conversationStore.get('conversations', {});
      const currentPersona = this.personaService.getCurrentPersona();
      
      // Remove conversations for current persona
      const updatedConversations = {};
      for (const [convId, conv] of Object.entries(conversations)) {
        if (!conv.persona || conv.persona !== currentPersona) {
          updatedConversations[convId] = conv;
        }
      }
      
      this.conversationStore.set('conversations', updatedConversations);
      console.log(`🗑️ Cleared conversations for persona: ${currentPersona}`);
      return true;
    } catch (error) {
      console.error('❌ Error clearing persona conversations:', error);
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

  // 📁 FOLDER MANAGEMENT METHODS (Passthrough to DocumentService)

  // Get all folders with document counts
  getAllFolders() {
    return this.documentService.getAllFolders();
  }

  // Create new folder
  createFolder(name, options = {}) {
    return this.documentService.createFolder(name, options);
  }

  // Update folder
  updateFolder(folderId, updates) {
    return this.documentService.updateFolder(folderId, updates);
  }

  // Delete folder
  deleteFolder(folderId, targetFolderId = null) {
    return this.documentService.deleteFolder(folderId, targetFolderId);
  }

  // Move document to folder
  moveDocumentToFolder(documentId, targetFolderId) {
    return this.documentService.moveDocumentToFolder(documentId, targetFolderId);
  }

  // Get documents in specific folder
  getDocumentsByFolder(folderId) {
    return this.documentService.getDocumentsByFolder(folderId);
  }

  // Get folder statistics
  getFolderStatistics() {
    return this.documentService.getFolderStatistics();
  }

  // Search documents within specific folder
  async searchDocumentsInFolder(query, folderId, searchType = 'hybrid') {
    return await this.documentService.searchDocumentsInFolder(query, folderId, searchType);
  }

  // 🎯 NEW: Search within specific document
  async searchInDocument(query, documentId, searchType = 'hybrid') {
    return await this.documentService.searchInDocument(query, documentId, searchType);
  }

  // Query documents with folder context (enhanced version)
  async queryDocumentsInFolder(query, folderId, conversationId = null, options = {}) {
    return await this.queryDocuments(query, conversationId, { 
      ...options, 
      folderId: folderId 
    });
  }

  // 🎯 NEW: Query documents with document focus (highest priority)
  async queryDocument(query, documentId, conversationId = null, options = {}) {
    return await this.queryDocuments(query, conversationId, { 
      ...options, 
      documentId: documentId 
    });
  }

  // Migrate existing documents to folders
  migrateDocumentsToFolders() {
    return this.documentService.migrateDocumentsToFolders();
  }
}

module.exports = RAGService;
