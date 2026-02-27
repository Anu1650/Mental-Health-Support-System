# NeuralCare - Mental Health Support Platform

A compassionate AI-powered mental health support platform for India, built with Ollama and designed to provide accessible, anonymous, and culturally-aware mental health assistance.

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🤖 **AI-Powered Chat** - Powered by custom Ollama model
- 🌐 **Multilingual Support** - Hindi, English, and more
- 🔒 **Privacy-First** - Secure and anonymous
- 🆘 **Crisis Detection** - Automatic detection and helpline display
- 📋 **Self-Assessment** - PHQ-9 style mental health check
- 😊 **Mood Tracker** - Track your daily moods
- 📝 **Journal** - Write daily journal entries
- 👤 **Profile** - Personal details management
- 📱 **Modern UI** - Beautiful, mobile-responsive interface

## Prerequisites

1. **Ollama** - Install from [ollama.ai](https://ollama.ai)
2. **Node.js** - Version 18+
3. **MongoDB** - Local or Atlas (optional - works without it)

## Quick Start

```bash
# Install dependencies
npm install

# Create the AI model
ollama create neuralcare -f Modelfile

# Start server
npm start
```

Then open **http://localhost:3000**

## Environment Variables

Create `.env` file:

```env
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/neuralcare
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

## Project Structure

```
NeuralCare/
├── public/
│   └── index.html      # Frontend UI
├── scripts/
│   └── setup.bat      # Setup script
├── Modelfile          # Ollama AI configuration
├── server.js          # Express API server
├── package.json       # Node dependencies
├── .env              # Environment variables
└── README.md         # This file
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/send-otp` | POST | Send OTP to email |
| `/api/auth/verify-otp` | POST | Verify OTP & login |
| `/api/chat` | POST | Send message to AI |
| `/api/assessment` | POST | Submit self-assessment |
| `/api/mood` | GET/POST | Track mood |
| `/api/journal` | GET/POST | Journal entries |
| `/api/health` | GET | Health check |

## Crisis Helplines

- 📞 **iCall (TISS):** 9152987821
- 📞 **Vandrevala Foundation:** 1860 2662 345
- 📞 **NIMHANS:** 080-4611 0007
- 📞 **Emergency:** 112

## Technology Stack

- **Frontend:** HTML5, CSS3, Vanilla JavaScript
- **Backend:** Node.js, Express
- **Database:** MongoDB (optional)
- **AI:** Ollama (Llama3)

## License

MIT License

## Disclaimer

This platform is for informational and support purposes only. It is not a medical device and should not be used as a substitute for professional mental health care.
