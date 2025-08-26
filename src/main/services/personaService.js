const Store = require('electron-store');

class PersonaService {
  constructor() {
    // Settings store for persona preferences
    this.settingsStore = new Store({
      name: 'settings',
      encryptionKey: 'covenantrix-settings-key-v1'
    });

    // Current active persona
    this.currentPersona = 'legal_advisor'; // Default persona
    
    console.log('🎭 PersonaService initialized with Legal Advisor as default');
  }

  // Define available personas
  getPersonaDefinitions() {
    return {
      legal_advisor: {
        id: 'legal_advisor',
        name: 'Legal Advisor',
        description: 'Expert legal analyst for contract analysis and risk assessment',
        systemPrompt: `You are Covenantrix Legal Advisor, an expert legal analyst specializing in contract analysis, risk assessment, and compliance review with deep expertise in contract law principles, industry standards, and multi-jurisdictional considerations.

LEGAL EXPERTISE: Apply contract law principles (offer, acceptance, consideration, capacity, legality), industry-specific standards, and jurisdiction-specific requirements. Consider enforceability under governing law, UCC provisions where applicable, and relevant regulatory frameworks.

RISK ANALYSIS METHODOLOGY:
- Legal Risk: Enforceability gaps, ambiguous language, missing protections
- Commercial Risk: Financial exposure, operational constraints, performance issues  
- Compliance Risk: Regulatory violations, industry standard deviations
- Relationship Risk: Power imbalances, dispute triggers, termination vulnerabilities

PROFESSIONAL STANDARDS: Maintain objective, professional analysis with precise legal terminology. Distinguish between legal facts and professional opinions. Provide balanced risk assessment without bias and recommend practical mitigation strategies where applicable.`,
        icon: '⚖️',
        color: '#0e639c'
      },
      
      legal_writer: {
        id: 'legal_writer',
        name: 'Legal Writer',
        description: 'Legal documentation writing assistant for drafting and revision',
        systemPrompt: `You are Covenantrix Legal Writer, expert in legal documentation and contract drafting.

LANGUAGE: Respond in the SAME language as the user's query. Maintain their formality level.

WRITING FRAMEWORK: 1) ANALYZE existing text 2) IDENTIFY improvement opportunities 3) SUGGEST specific revisions 4) RECOMMEND missing elements 5) ENSURE legal precision

INSTRUCTIONS:
- Focus on improving contract language and structure
- Suggest specific clause improvements and alternative phrasing
- Identify missing or incomplete provisions
- Recommend standard legal language where appropriate
- Ensure clarity and enforceability in suggestions
- Provide rationale for recommended changes
- Base recommendations on provided document context
- Highlight areas needing legal review`,
        icon: '✍️',
        color: '#7c3aed'
      }
    };
  }

  // Get current active persona
  getCurrentPersona() {
    return this.currentPersona;
  }

  // Get persona definition by ID
  getPersona(personaId) {
    const personas = this.getPersonaDefinitions();
    return personas[personaId] || personas['legal_advisor']; // Fallback to default
  }

  // Get current persona definition
  getCurrentPersonaDefinition() {
    return this.getPersona(this.currentPersona);
  }

  // Switch to a different persona
  switchPersona(personaId) {
    const personas = this.getPersonaDefinitions();
    
    if (!personas[personaId]) {
      console.warn(`⚠️ Invalid persona ID: ${personaId}, keeping current persona`);
      return false;
    }

    const previousPersona = this.currentPersona;
    this.currentPersona = personaId;
    
    // Save to settings for persistence across sessions
    this.settingsStore.set('active_persona', personaId);
    
    console.log(`🎭 Persona switched: ${previousPersona} → ${personaId}`);
    return true;
  }

  // Initialize persona from saved settings
  initializeFromSettings() {
    const savedPersona = this.settingsStore.get('active_persona', 'legal_advisor');
    this.currentPersona = savedPersona;
    console.log(`🎭 Loaded saved persona: ${savedPersona}`);
    return savedPersona;
  }

  // Generate persona-specific prompt with budget awareness
  generatePersonaPrompt(query, context, queryType = 'general', options = {}) {
    const persona = this.getCurrentPersonaDefinition();
    const { 
      maxTokens = null, 
      complexity = 'standard', 
      confidenceScore = 0.5,
      includeExamples = true 
    } = options;
    
    // Query-specific instructions (shared across personas but applied differently)
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

    // Persona-specific adaptations of instructions
    if (this.currentPersona === 'legal_writer') {
      const writerInstructions = {
        'terms': 'Review term definitions. Suggest clearer language. Recommend standard phrasing.',
        'liability': 'Review liability language. Suggest balanced allocation. Recommend clearer scope.',
        'termination': 'Review termination clauses. Suggest comprehensive triggers. Recommend clear procedures.',
        'payment': 'Review payment terms. Suggest specific language. Recommend penalty structures.',
        'confidentiality': 'Review confidentiality language. Suggest comprehensive scope. Recommend standard exceptions.',
        'interpretation': 'Suggest clearer language to reduce ambiguity. Recommend precise definitions.',
        'amendment': 'Review modification language. Suggest comprehensive procedures. Recommend formal requirements.',
        'general': 'Review document structure and language. Suggest improvements for clarity and enforceability.'
      };
      
      // Use writer-specific instructions where available
      Object.assign(querySpecificInstructions, writerInstructions);
    }

    const instruction = querySpecificInstructions[queryType] || querySpecificInstructions['general'];

    // Dynamic instruction selection based on budget and complexity
    const promptComponents = this.selectPromptComponents(persona, instruction, maxTokens, complexity, confidenceScore);

    return this.assemblePrompt(promptComponents, context, query);
  }

  // Select prompt components based on budget and complexity
  selectPromptComponents(persona, instruction, maxTokens, complexity, confidenceScore) {
    const components = {
      identity: persona.systemPrompt.split('\n')[0], // "You are Covenantrix..."
      language: `LANGUAGE: Respond in the SAME language as the user's query. Maintain their formality level.`,
      framework: this.getFrameworkByComplexity(complexity),
      instructions: this.getInstructionsByBudget(maxTokens, confidenceScore),
      task: instruction
    };

    return components;
  }

  // Get framework detail level based on complexity
  getFrameworkByComplexity(complexity) {
    const frameworks = {
      minimal: `ANALYSIS: 1) IDENTIFY 2) ASSESS 3) CITE`,
      standard: `ANALYSIS FRAMEWORK: 1) IDENTIFY provision type 2) INTERPRET meaning 3) ANALYZE implications 4) ASSESS risks/ambiguities 5) CITE sources`,
      comprehensive: `LEGAL ANALYSIS FRAMEWORK:
1) IDENTIFY: Provision type, parties, obligations, and legal relationships
2) INTERPRET: Meaning using legal principles and industry standards  
3) ANALYZE: Implications for enforceability, compliance, and performance
4) ASSESS: Multi-dimensional risk evaluation (legal, commercial, operational)
5) CITE: Precise references with exact quotes and section numbers`
    };

    return frameworks[complexity] || frameworks.standard;
  }

  // Get instruction detail level based on token budget and confidence
  getInstructionsByBudget(maxTokens, confidenceScore) {
    // High confidence + low budget = minimal instructions
    if (confidenceScore >= 0.8 && maxTokens && maxTokens < 150) {
      return `INSTRUCTIONS: Base analysis on provided context. State limitations when uncertain.`;
    }

    // Standard budget instructions
    if (!maxTokens || maxTokens >= 300) {
      return `INSTRUCTIONS:
- Base analysis EXCLUSIVELY on provided document context
- State explicitly when information is missing from documents
- Cite specific document sections with precision
- Preserve Hebrew/Arabic text direction when quoting
- Focus on practical, actionable legal insights
- Highlight risks and important considerations
- State limitations when uncertain`;
    }

    // Medium budget instructions
    return `INSTRUCTIONS:
- Base analysis on provided document context
- Cite specific sections with precision  
- Focus on practical legal insights
- Highlight key risks and considerations
- State limitations when uncertain`;
  }

  // Assemble final prompt from components
  assemblePrompt(components, context, query) {
    const sections = [
      components.identity,
      '',
      components.language,
      '',
      components.framework,
      '',
      components.instructions,
      '',
      `TASK: ${components.task}`,
      '',
      'CONTEXT:',
      context,
      '',
      `QUERY: ${query}`,
      '',
      'RESPONSE:'
    ];

    return sections.join('\n');
  }

  // 💰 COST-AWARE TOKEN BUDGET MANAGEMENT
  
  // Get user's token budget preference
  getUserTokenBudget() {
    return this.settingsStore.get('token_budget', {
      maxTokensPerQuery: 1000,
      budgetTier: 'standard', // 'minimal', 'standard', 'comprehensive'
      costLimit: 0.05 // USD per query
    });
  }

  // Set user's token budget preference
  setUserTokenBudget(budget) {
    this.settingsStore.set('token_budget', budget);
    console.log(`💰 Token budget updated: ${budget.budgetTier} tier, max ${budget.maxTokensPerQuery} tokens`);
  }

  // Calculate complexity level for dynamic prompt selection
  calculateComplexityLevel(query, confidenceScore, queryType) {
    let complexity = 'standard';

    // High confidence simple queries = minimal complexity
    if (confidenceScore >= 0.8 && query.length < 50 && 
        ['parties', 'dates', 'payment'].includes(queryType)) {
      complexity = 'minimal';
    }
    // Complex analysis queries = comprehensive complexity  
    else if (confidenceScore < 0.6 || query.length > 100 || 
             ['risk_assessment', 'compliance', 'interpretation'].includes(queryType)) {
      complexity = 'comprehensive';
    }

    return complexity;
  }

  // Generate budget-aware prompt options
  generateBudgetAwarePrompt(query, context, queryType, confidenceScore) {
    const budget = this.getUserTokenBudget();
    const complexity = this.calculateComplexityLevel(query, confidenceScore, queryType);
    
    const options = {
      maxTokens: budget.maxTokensPerQuery,
      complexity: budget.budgetTier === 'minimal' ? 'minimal' : 
                 budget.budgetTier === 'comprehensive' ? 'comprehensive' : complexity,
      confidenceScore: confidenceScore,
      includeExamples: budget.budgetTier !== 'minimal'
    };

    return this.generatePersonaPrompt(query, context, queryType, options);
  }

  // Estimate prompt tokens (rough approximation)
  estimatePromptTokens(prompt) {
    return Math.ceil(prompt.length / 4);
  }

  // Validate prompt fits within budget
  validatePromptBudget(prompt) {
    const budget = this.getUserTokenBudget();
    const estimatedTokens = this.estimatePromptTokens(prompt);
    const estimatedCost = (estimatedTokens / 1000) * 0.03; // GPT-4 pricing
    
    if (estimatedTokens > budget.maxTokensPerQuery) {
      console.warn(`⚠️ Prompt exceeds token budget: ${estimatedTokens} > ${budget.maxTokensPerQuery}`);
      return false;
    }
    
    if (estimatedCost > budget.costLimit) {
      console.warn(`⚠️ Prompt exceeds cost limit: $${estimatedCost.toFixed(4)} > $${budget.costLimit}`);
      return false;
    }

    return true;
  }

  // Get all available personas for UI
  getAllPersonas() {
    return Object.values(this.getPersonaDefinitions());
  }

  // Validate persona exists
  isValidPersona(personaId) {
    const personas = this.getPersonaDefinitions();
    return personas.hasOwnProperty(personaId);
  }
}

module.exports = PersonaService;
