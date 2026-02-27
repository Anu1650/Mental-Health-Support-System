# सहायोग (Sahayog) - Mental Health Support Platform

A compassionate AI-powered mental health support platform for India, built with Ollama and designed to provide accessible, anonymous, and culturally-aware mental health assistance.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🤖 **AI-Powered Chat** - Powered by custom Ollama model (Llama3)
- 🌐 **Bilingual Support** - Hindi, English, and Hinglish
- 🔒 **Privacy-First** - Anonymous, no login required
- 🆘 **Crisis Detection** - Automatic detection and helpline display
- 📋 **Self-Assessment** - PHQ-9 style mental health check
- 📱 **Modern UI** - Beautiful, mobile-responsive interface

## Prerequisites

1. **Ollama** - Install from [ollama.ai](https://ollama.ai)
2. **Node.js** - Version 18+ (for running the server)

## Quick Start

### Option 1: Run Setup & Start

```bash
# Double-click setup.bat to configure everything
setup.bat

# Then run the server
start.bat
```

### Option 2: Manual Setup

```bash
# Install dependencies
npm install

# Create the custom model
ollama create sahayog -f Modelfile

# Start server
npm start
```

Then open **http://localhost:3000** in your browser.

## Project Structure

```
sahayog/
├── public/
│   └── index.html      # Frontend UI
├── scripts/
│   └── setup.bat      # Setup script
├── Modelfile          # Ollama model configuration
├── server.js          # Express API server
├── package.json       # Node dependencies
├── start.bat          # Quick start
└── README.md          # This file
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send a message |
| `/api/chat/clear` | POST | Clear session |
| `/api/assessment` | POST | Submit self-assessment |
| `/api/health` | GET | Health check |

## Crisis Helplines

The system automatically detects crisis situations and displays:

- 📞 **iCall (TISS):** 9152987821
- 📞 **Vandrevala Foundation:** 1860 2662 345
- 📞 **NIMHANS:** 080-4611 0007
- 📞 **Emergency:** 112

## Technology Stack

- **Frontend:** HTML5, CSS3, Vanilla JavaScript
- **Backend:** Node.js, Express
- **AI:** Ollama (Llama3)
- **Design:** Custom CSS with responsive design

## Customization

### Changing the Model

Edit `Modelfile` to customize the AI behavior:

```dockerfile
FROM llama3:latest

PARAMETER temperature 0.7

SYSTEM """
Your custom system prompt...
"""
```

Then recreate the model:
```bash
ollama create sahayog -f Modelfile
```

### Adding Training Data

Create a JSONL file with training examples and fine-tune using Ollama's training capabilities.

## Limitations

- This is a support tool, NOT a replacement for professional mental health care
- The AI may not always provide accurate medical advice
- For emergencies, always use official crisis helplines
- Not a substitute for therapy or psychiatric care

## License

MIT License - Feel free to use and modify for good.

## Disclaimer

This platform is for informational and support purposes only. It is not a medical device and should not be used as a substitute for professional mental health care. If you're in crisis, please contact emergency services or a mental health helpline immediately.
