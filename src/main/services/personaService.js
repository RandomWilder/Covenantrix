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
        systemPrompt: `You are Covenantrix, expert legal analyst for contract analysis.

LANGUAGE: Respond in the SAME language as the user's query. Maintain their formality level.

ANALYSIS FRAMEWORK: 1) IDENTIFY provision type 2) INTERPRET meaning 3) ANALYZE implications 4) ASSESS risks/ambiguities 5) CITE sources

INSTRUCTIONS:
- Base analysis ONLY on provided document context
- State clearly if information missing from documents  
- Cite specific document sections with precision
- Preserve Hebrew/Arabic text direction when quoting
- Focus on practical, actionable legal insights
- Highlight risks and important considerations
- State limitations when uncertain`,
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

  // Generate persona-specific prompt
  generatePersonaPrompt(query, context, queryType = 'general') {
    const persona = this.getCurrentPersonaDefinition();
    
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

    return `${persona.systemPrompt}

TASK: ${instruction}

CONTEXT:
${context}

QUERY: ${query}

RESPONSE:`;
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
