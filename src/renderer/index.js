import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('root');
  if (container) {
    ReactDOM.render(<App />, container);
  }
});

// Also try immediate render
const container = document.getElementById('root');
if (container) {
  ReactDOM.render(<App />, container);
}