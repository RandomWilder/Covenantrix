import React, { useState, useEffect } from 'react';
import './App.css';

const App = () => {
  const [contracts, setContracts] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleFileUpload = async () => {
    // Simulate file selection for now
    const mockFiles = [
      { 
        id: Date.now(), 
        name: 'Sample_Contract.pdf', 
        uploadedAt: new Date().toLocaleString(), 
        status: 'Processing...' 
      }
    ];
    
    setContracts(prev => [...prev, ...mockFiles]);
    
    // Simulate processing
    setTimeout(() => {
      setContracts(prev => prev.map(contract => 
        contract.status === 'Processing...' 
          ? { ...contract, status: 'Ready' }
          : contract
      ));
    }, 2000);
  };

  const handleQuery = async () => {
    if (!query.trim()) return;
    
    setIsLoading(true);
    
    setTimeout(() => {
      const mockResults = [
        {
          id: 1,
          content: `Found relevant information for: "${query}"`,
          source: 'Sample_Contract.pdf',
          confidence: 95
        }
      ];
      
      setResults(mockResults);
      setIsLoading(false);
    }, 1000);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Contract RAG Manager</h1>
        <span className="version">v1.2.10</span>
      </header>

      <div className="main-content">
        {/* Upload Section */}
        <div className="section">
          <h2>📄 Contract Upload</h2>
          <button onClick={handleFileUpload} className="upload-btn">
            Upload Contracts
          </button>
          
          {contracts.length > 0 && (
            <div className="contracts-list">
              <h3>Uploaded Contracts ({contracts.length})</h3>
              {contracts.map(contract => (
                <div key={contract.id} className="contract-item">
                  <div className="contract-info">
                    <strong>{contract.name}</strong>
                    <span className="upload-time">{contract.uploadedAt}</span>
                  </div>
                  <span className={`status ${contract.status === 'Ready' ? 'ready' : 'processing'}`}>
                    {contract.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Query Section */}
        <div className="section">
          <h2>🔍 Query Contracts</h2>
          <div className="query-input">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask questions about your contracts..."
              onKeyPress={(e) => e.key === 'Enter' && handleQuery()}
            />
            <button 
              onClick={handleQuery} 
              disabled={isLoading || !query.trim()}
              className="query-btn"
            >
              {isLoading ? '⏳' : '🔍'} Query
            </button>
          </div>

          {results.length > 0 && (
            <div className="results">
              <h3>Results</h3>
              {results.map(result => (
                <div key={result.id} className="result-item">
                  <div className="result-content">{result.content}</div>
                  <div className="result-meta">
                    <span className="source">📄 {result.source}</span>
                    <span className="confidence">
                      Confidence: {result.confidence}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;