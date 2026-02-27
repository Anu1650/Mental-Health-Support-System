const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Accept external connections

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== MONGODB ====================
let db = null;

async function connectDB() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    if (!mongoUri) {
        console.log('⚠️  No MongoDB URI. Using in-memory storage.');
        return null;
    }
    
    try {
        const { MongoClient } = require('mongodb');
        const mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        db = mongoClient.db();
        console.log('✅ MongoDB Connected');
        
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
        await db.collection('otps').createIndex({ email: 1 }, { expireAfterSeconds: 1800 }); // 30 minutes
        await db.collection('sessions').createIndex({ token: 1 }, { expireAfterSeconds: 86400 });
        
        return db;
    } catch (err) {
        console.error('❌ MongoDB Error:', err.message);
        return null;
    }
}

// ==================== IN-MEMORY FALLBACK ====================
const memoryStore = {
    users: new Map(),
    otps: new Map(),
    sessions: new Map()
};

// ==================== HELPERS ====================
const CRISIS_KEYWORDS = ['suicide', 'kill myself', 'want to die', 'end it all', 'self harm', 'hurt myself'];
const CRISIS_RESPONSE = `I'm concerned about you. Please reach out now:\n\n📞 iCall: 9152987821\n📞 Vandrevala: 1860 2662 345\n📞 Emergency: 112`;

function checkCrisis(text) {
    return CRISIS_KEYWORDS.some(k => text.toLowerCase().includes(k));
}

function generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getClient() {
    return db || memoryStore;
}

// ==================== EMAIL ====================
const nodemailer = require('nodemailer');
let transporter = null;
let emailConfigured = false;

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        }
    });
    transporter.verify((error, success) => {
        if (error) {
            console.log('❌ Email not configured:', error.message);
            emailConfigured = false;
        } else {
            console.log('✅ Email configured and ready');
            emailConfigured = true;
        }
    });
}

async function sendOTP(email, otp) {
    const mailOptions = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: email,
        subject: '🔐 Your NeuralCare Verification Code',
        html: `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 10px; padding: 30px; }
        .otp { font-size: 32px; font-weight: bold; color: #6366f1; letter-spacing: 8px; }
        .footer { margin-top: 20px; color: #888; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>NeuralCare Verification</h2>
        <p>Your verification code is:</p>
        <div class="otp">${otp}</div>
        <p>Valid for <strong>30 minutes</strong>.</p>
        <div class="footer">
            <p>This code was requested for your NeuralCare account.</p>
            <p>If you didn't request this, please ignore this email.</p>
        </div>
    </div>
</body>
</html>`,
        text: `Your NeuralCare OTP: ${otp}. Valid for 30 minutes.`
    };

    if (transporter && emailConfigured) {
        try {
            await transporter.sendMail(mailOptions);
            console.log(`✅ OTP email sent to ${email}`);
            return true;
        } catch (e) {
            console.error('❌ Email send failed:', e.message);
        }
    } else {
        console.log(`📧 OTP for ${email}: ${otp} (Email not configured - check .env)`);
    }
    return true;
}

// ==================== OLLAMA AI ====================
const MENTAL_HEALTH_RESPONSES = [
    "That sounds like it's weighing on you. Want to share more about what's going on? I'm here to listen without judgment.",
    "I appreciate you opening up to me. It takes courage to share. What do you think triggered these feelings?",
    "Thanks for trusting me with this. Let's work through this together - what would help you feel even a little bit better right now?",
    "I hear you. These things can be really tough. Have you been able to take care of yourself lately?",
    "It sounds like you're dealing with a lot right now. Remember to be kind to yourself. What's one small thing that usually helps you feel better?"
];

const OLLAMA_API_KEY = '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';

const SYSTEM_PROMPT = `You are NeuralCare, a warm, empathetic mental health friend. 

Your guidelines:
1. Be conversational and human-like - like a caring friend, NOT a robot
2. NEVER start with "I'm here for you" or similar generic phrases
3. Use the user's name when you know it
4. Reference what they specifically shared - show you actually read it
5. Ask natural follow-up questions
6. Keep responses short (2-4 sentences) and personal
7. Show genuine curiosity about their wellbeing
8. If they seem down, acknowledge it warmly before suggesting anything
9. Use light emojis occasionally to feel approachable
 10. For breathing exercises or techniques, explain step by step in simple language.

Example good responses:
- "That sounds really tough. How long have you been feeling like this?"
- "I'm glad you shared that with me. What happened that made you feel that way?"
- "Ugh, that's exhausting. Have you been able to get any rest?"

Remember: Be human-like, warm, and responsive. NOT formal or clinical.`;

// Helper function to fetch with timeout
async function fetchWithTimeout(url, options, timeout = 30000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function generateAIResponse(prompt, userContext = '') {
    const cleanPrompt = prompt.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
    
    const fullPrompt = `${SYSTEM_PROMPT}

${userContext}

User just said: "${cleanPrompt}"

Respond as a caring friend would - warm, conversational, and specific to what they shared.`;
    
    // Try local Ollama first
    try {
        const response = await fetchWithTimeout('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'neuralcare',
                prompt: fullPrompt,
                stream: false,
                options: { temperature: 0.7, top_p: 0.9, num_ctx: 4096 }
            })
        }, 45000);
        
        const data = await response.json();
        
        if (response.ok && data.response && data.response.trim()) {
            return data.response.trim();
        }
    } catch(e) {
        console.log('Neuralcare error:', e.message);
    }
    
    // Try mistral
    try {
        const response = await fetchWithTimeout('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'mistral',
                prompt: fullPrompt,
                stream: false,
                options: { temperature: 0.7 }
            })
        }, 45000);
        
        const data = await response.json();
        if (response.ok && data.response && data.response.trim()) {
            return data.response.trim();
        }
    } catch(e) {
        console.log('Mistral error:', e.message);
    }
    
    // Try llama3
    try {
        const response = await fetchWithTimeout('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3',
                prompt: fullPrompt,
                stream: false
            })
        }, 45000);
        
        const data = await response.json();
        if (response.ok && data.response && data.response.trim()) {
            return data.response.trim();
        }
    } catch(e) {
        console.log('Llama3 error:', e.message);
    }
    
    // Fallback
    console.log('Using fallback response');
    const randomResponse = MENTAL_HEALTH_RESPONSES[Math.floor(Math.random() * MENTAL_HEALTH_RESPONSES.length)];
    return randomResponse;
}

// ==================== ROUTES ====================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', name: 'NeuralCare', version: '2.0.0', database: db ? 'Connected' : 'In-Memory' });
});

app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    const normalizedEmail = email.toLowerCase();
    const otp = generateOTP();
    
    const client = getClient();
    if (db) {
        await db.collection('otps').deleteMany({ email: normalizedEmail });
        await db.collection('otps').insertOne({ email: normalizedEmail, otp, attempts: 0, createdAt: new Date() });
    } else {
        memoryStore.otps.set(normalizedEmail, { otp, attempts: 0, createdAt: Date.now() });
    }
    
    await sendOTP(normalizedEmail, otp);
    console.log(`📧 OTP for ${normalizedEmail}: ${otp}`);
    
    // In development mode or if email fails, include OTP in response for testing
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ 
        success: true, 
        message: isDev ? 'OTP sent (see console/server terminal)' : 'OTP sent to email',
        devOTP: isDev ? otp : undefined 
    });
});

// Login with password only (no OTP)
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const normalizedEmail = email.toLowerCase();
    let user;
    
    if (db) {
        user = await db.collection('users').findOne({ email: normalizedEmail });
    } else {
        user = memoryStore.users.get(normalizedEmail);
    }
    
    if (!user) {
        return res.json({ success: false, message: 'User not found. Please sign up first.' });
    }
    
    if (user.password !== password) {
        return res.json({ success: false, message: 'Invalid password' });
    }
    
    // Direct login - create session
    const token = generateToken();
    if (db) {
        await db.collection('sessions').insertOne({ token, userId: user._id.toString(), createdAt: new Date() });
    } else {
        memoryStore.sessions.set(token, { userId: user._id, createdAt: Date.now() });
    }
    
    res.json({ success: true, message: 'Login successful', user: { id: user._id.toString(), email: user.email, name: user.name }, token });
});

// Forgot Password - Send OTP
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    const normalizedEmail = email.toLowerCase();
    let user;
    
    if (db) {
        user = await db.collection('users').findOne({ email: normalizedEmail });
    } else {
        user = memoryStore.users.get(normalizedEmail);
    }
    
    if (!user) {
        return res.json({ success: false, message: 'User not found' });
    }
    
    const otp = generateOTP();
    if (db) {
        await db.collection('otps').deleteMany({ email: normalizedEmail });
        await db.collection('otps').insertOne({ email: normalizedEmail, otp, purpose: 'reset', createdAt: new Date() });
    } else {
        memoryStore.otps.set(normalizedEmail, { otp, purpose: 'reset', createdAt: Date.now() });
    }
    
    await sendOTP(normalizedEmail, otp);
    console.log(`📧 Reset OTP for ${normalizedEmail}: ${otp}`);
    
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ 
        success: true, 
        message: isDev ? 'OTP sent (see console/server terminal)' : 'OTP sent to your email',
        devOTP: isDev ? otp : undefined 
    });
});

// Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
    const { email, otp, password } = req.body;
    
    if (!email || !otp || !password) {
        return res.status(400).json({ success: false, message: 'Email, OTP and password required' });
    }

    const normalizedEmail = email.toLowerCase();
    
    let storedOTP;
    if (db) {
        storedOTP = await db.collection('otps').findOne({ email: normalizedEmail });
    } else {
        storedOTP = memoryStore.otps.get(normalizedEmail);
    }
    
    if (!storedOTP) {
        return res.status(400).json({ success: false, message: 'No OTP found. Request new one.' });
    }
    
    const created = storedOTP.createdAt?.getTime?.() || storedOTP.createdAt;
    if (Date.now() - created > 30 * 60 * 1000) {
        return res.status(400).json({ success: false, message: 'OTP expired. Request new one.' });
    }
    
    if (storedOTP.otp !== String(otp)) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    
    // Delete OTP
    if (db) {
        await db.collection('otps').deleteOne({ email: normalizedEmail });
    } else {
        memoryStore.otps.delete(normalizedEmail);
    }
    
    // Update password
    if (db) {
        await db.collection('users').updateOne({ email: normalizedEmail }, { $set: { password } });
    } else {
        const user = memoryStore.users.get(normalizedEmail);
        if (user) user.password = password;
    }
    
    res.json({ success: true, message: 'Password reset successful' });
});

app.post('/api/auth/verify', async (req, res) => {
    const { email, otp, name, phone, age, gender, address, password } = req.body;
    
    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP required' });
    }

    const normalizedEmail = email.toLowerCase();
    const client = getClient();
    
    let storedOTP;
    if (db) {
        storedOTP = await db.collection('otps').findOne({ email: normalizedEmail });
    } else {
        storedOTP = memoryStore.otps.get(normalizedEmail);
    }
    
    if (!storedOTP) {
        return res.status(400).json({ success: false, message: 'No OTP found. Request new one.' });
    }
    
    const created = storedOTP.createdAt?.getTime?.() || storedOTP.createdAt;
    if (Date.now() - created > 30 * 60 * 1000) {
        return res.status(400).json({ success: false, message: 'OTP expired. Request new one.' });
    }
    
    if (storedOTP.otp !== String(otp)) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    
    if (db) {
        await db.collection('otps').deleteOne({ email: normalizedEmail });
    } else {
        memoryStore.otps.delete(normalizedEmail);
    }
    
    const userData = {
        email: normalizedEmail,
        name: name || email.split('@')[0],
        phone: phone || '',
        age: age || '',
        gender: gender || '',
        address: address || '',
        password: password || '',
        createdAt: db ? new Date() : Date.now()
    };
    
    // Check if user already exists
    let existingUser;
    if (db) {
        existingUser = await db.collection('users').findOne({ email: normalizedEmail });
    } else {
        existingUser = memoryStore.users.get(normalizedEmail);
    }
    
    if (existingUser) {
        return res.status(400).json({ success: false, message: 'User already exists. Please login or use forgot password.' });
    }
    
    let user;
    if (db) {
        const result = await db.collection('users').insertOne(userData);
        user = { _id: result.insertedId, ...userData };
    } else {
        memoryStore.users.set(normalizedEmail, { _id: 'mem_' + Date.now(), ...userData });
        user = memoryStore.users.get(normalizedEmail);
    }
    
    const token = generateToken();
    if (db) {
        await db.collection('sessions').insertOne({ token, userId: user._id.toString(), createdAt: new Date() });
    } else {
        memoryStore.sessions.set(token, { userId: user._id, createdAt: Date.now() });
    }
    
    res.json({
        success: true,
        message: 'Login successful',
        user: { id: user._id.toString(), email: user.email, name: user.name, phone: user.phone, age: user.age, gender: user.gender, address: user.address },
        token
    });
});

app.post('/api/auth/logout', async (req, res) => {
    const { token } = req.body;
    if (token) {
        if (db) await db.collection('sessions').deleteOne({ token });
        else memoryStore.sessions.delete(token);
    }
    res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let user;
    if (db) user = await db.collection('users').findOne({ _id: new ObjectId(session.userId) });
    else user = Array.from(memoryStore.users.values()).find(u => u._id === session.userId);
    
    if (!user) return res.status(401).json({ success: false });
    
    res.json({ success: true, user: { id: user._id.toString(), email: user.email, name: user.name, phone: user.phone, age: user.age, gender: user.gender, address: user.address } });
});

app.post('/api/user/profile', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { name, phone, age, gender, address } = req.body;
    
    console.log('Profile update - address:', address);
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    const updateData = { name, phone, age, gender, address };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    
    console.log('Updating profile with:', updateData);
    
    if (db) {
        await db.collection('users').updateOne({ _id: new ObjectId(session.userId) }, { $set: updateData });
        console.log('Profile updated in DB');
    } else {
        const user = Array.from(memoryStore.users.values()).find(u => u._id === session.userId);
        if (user) Object.assign(user, updateData);
    }
    
    res.json({ success: true, message: 'Profile updated' });
});

app.post('/api/mood', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { mood, note } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    let session = db ? await db.collection('sessions').findOne({ token }) : memoryStore.sessions.get(token);
    if (!session) return res.status(401).json({ success: false });
    
    if (db) await db.collection('moods').insertOne({ userId: session.userId, mood, note, date: new Date().toISOString().split('T')[0], createdAt: new Date() });
    
    res.json({ success: true });
});

app.get('/api/mood', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false });
    
    let session = db ? await db.collection('sessions').findOne({ token }) : memoryStore.sessions.get(token);
    if (!session) return res.status(401).json({ success: false });
    
    let moods = [];
    if (db) moods = await db.collection('moods').find({ userId: session.userId }).sort({ createdAt: -1 }).limit(30).toArray();
    
    res.json({ success: true, moods });
});

app.post('/api/journal', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { title, content } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    let session = db ? await db.collection('sessions').findOne({ token }) : memoryStore.sessions.get(token);
    if (!session) return res.status(401).json({ success: false });
    
    if (db) await db.collection('journals').insertOne({ userId: session.userId, title, content, createdAt: new Date() });
    
    res.json({ success: true });
});

app.get('/api/journal', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false });
    
    let session = db ? await db.collection('sessions').findOne({ token }) : memoryStore.sessions.get(token);
    if (!session) return res.status(401).json({ success: false });
    
    let entries = [];
    if (db) entries = await db.collection('journals').find({ userId: session.userId }).sort({ createdAt: -1 }).limit(50).toArray();
    
    res.json({ success: true, entries });
});

// Main Chat endpoint with user context
app.post('/api/chat', async (req, res) => {
    const { message, language = 'en' } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    const LANGUAGE_PROMPTS = {
        en: "Respond in English in a warm, conversational way.",
        hi: "Respond in Hindi (हिंदी) in a warm, conversational way. Use simple Hindi that everyone can understand.",
        te: "Respond in Telugu (తెలుగు) in a warm, conversational way.",
        ta: "Respond in Tamil (தமிழ்) in a warm, conversational way.",
        bn: "Respond in Bengali (বাংলা) in a warm, conversational way.",
        mr: "Respond in Marathi (मराठी) in a warm, conversational way.",
        kn: "Respond in Kannada (ಕನ್ನಡ) in a warm, conversational way.",
        ml: "Respond in Malayalam (മലയാളം) in a warm, conversational way."
    };
    
    let userContext = '';
    
    // Get user details if authenticated
    if (token) {
        let session, user;
        if (db) {
            session = await db.collection('sessions').findOne({ token });
            if (session) {
                user = await db.collection('users').findOne({ _id: new ObjectId(session.userId) });
            }
        } else {
            session = memoryStore.sessions.get(token);
            if (session) {
                user = Array.from(memoryStore.users.values()).find(u => u._id === session.userId);
            }
        }
        
        if (user) {
            const age = user.age || 'Not specified';
            const gender = user.gender || 'Not specified';
            
            userContext = `
User Background:
- Age: ${age}
- Gender: ${gender}
${LANGUAGE_PROMPTS[language] || LANGUAGE_PROMPTS.en}

`;
            
            let moods = [];
            if (db && session) {
                moods = await db.collection('moods').find({ userId: session.userId }).sort({ createdAt: -1 }).limit(7).toArray();
            }
            if (moods.length > 0) {
                const moodEmojis = { great: '😄', good: '😊', okay: '😐', bad: '😔', terrible: '😢' };
                const recentMoods = moods.map(m => `${moodEmojis[m.mood]}`).join(', ');
                userContext += `Recent mood trends: ${recentMoods} (most recent to oldest)\n`;
            }
            
            let reports = [];
            if (db && session) {
                reports = await db.collection('clinic_reports').find({ userId: session.userId }).sort({ date: -1 }).limit(5).toArray();
            }
            if (reports.length > 0) {
                const reportTypes = {
                    blood_test: 'Blood Test',
                    urine_test: 'Urine Test',
                    xray: 'X-Ray',
                    mri: 'MRI Scan',
                    ct_scan: 'CT Scan',
                    ecg: 'ECG',
                    other: 'Other'
                };
                const reportInfo = reports.map(r => `${reportTypes[r.type] || r.type}: ${r.findings || 'Normal'}`).join(', ');
                userContext += `Recent medical reports: ${reportInfo}\n`;
            }
        }
    } else {
        userContext = LANGUAGE_PROMPTS[language] || LANGUAGE_PROMPTS.en;
    }
    
    if (!message?.trim()) {
        return res.status(400).json({ error: 'Empty message' });
    }

    if (checkCrisis(message)) {
        // Save detected mood before crisis response
        if (db && session) {
            await db.collection('moods').insertOne({
                userId: session.userId,
                mood: 'terrible',
                note: 'AI detected crisis indicators',
                source: 'ai',
                createdAt: new Date()
            });
        }
        return res.json({
            response: CRISIS_RESPONSE,
            is_crisis: true,
            crisis_resources: [{ name: 'iCall', phone: '9152987821' }, { name: 'Vandrevala', phone: '1860 2662 345' }, { name: 'Emergency', phone: '112' }]
        });
    }

    try {
        const responseText = await generateAIResponse(message, userContext);
        
        // Detect mood from message and save automatically
        if (db && session) {
            const detectedMood = detectMood(message);
            if (detectedMood) {
                await db.collection('moods').insertOne({
                    userId: session.userId,
                    mood: detectedMood,
                    note: 'AI detected from conversation',
                    source: 'ai',
                    createdAt: new Date()
                });
            }
        }
        
        res.json({ response: responseText, is_crisis: false });
    } catch (e) {
        res.json({ response: "I'm here for you. How are you feeling?", is_crisis: false });
    }
});

// Detect mood from message text
function detectMood(message) {
    const text = message.toLowerCase();
    
    // Positive emotions
    if (text.includes('happy') || text.includes('great') || text.includes('wonderful') || text.includes('amazing') || text.includes('love') || text.includes('excited') || text.includes('joy') || text.includes('grateful') || text.includes('thankful') || text.includes('better') || text.includes('improving')) {
        return 'great';
    }
    
    // Good emotions
    if (text.includes('good') || text.includes('nice') || text.includes('fine') || text.includes('okay') || text.includes('ok') || text.includes('better') || text.includes('relaxed') || text.includes('calm') || text.includes('peaceful')) {
        return 'good';
    }
    
    // Neutral
    if (text.includes('okay') || text.includes('ok') || text.includes('normal') || text.includes('average') || text.includes('usual')) {
        return 'okay';
    }
    
    // Negative emotions
    if (text.includes('sad') || text.includes('down') || text.includes('depressed') || text.includes('unhappy') || text.includes('disappointed') || text.includes('hurt') || text.includes('heartbroken') || text.includes('miss') || text.includes('lonely') || text.includes('alone')) {
        return 'bad';
    }
    
    // Very negative / distress
    if (text.includes('anxious') || text.includes('worried') || text.includes('stressed') || text.includes('overwhelmed') || text.includes('panic') || text.includes('scared') || text.includes('afraid') || text.includes('terrible') || text.includes('awful') || text.includes('horrible') || text.includes('hopeless') || text.includes('worthless') || text.includes('tired') || text.includes('exhausted')) {
        return 'terrible';
    }
    
    return null; // No clear emotion detected
}

// Save chat message
app.post('/api/chat/save', async (req, res) => {
    const { message, response } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    
    let session;
    if (db) {
        session = await db.collection('sessions').findOne({ token });
    } else {
        session = memoryStore.sessions.get(token);
    }
    
    if (!session) {
        console.log('Invalid session for chat save');
        return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    
    if (db) {
        try {
            await db.collection('chats').insertOne({
                userId: session.userId,
                message,
                response,
                createdAt: new Date()
            });
            console.log('Chat saved to DB for user:', session.userId);
        } catch(e) {
            console.log('Error saving chat:', e.message);
        }
    } else {
        console.log('Chat saved to memory for user:', session.userId);
    }
    
    res.json({ success: true });
});

// Get chat history
app.get('/api/chat/history', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    
    let session;
    if (db) {
        session = await db.collection('sessions').findOne({ token });
    } else {
        session = memoryStore.sessions.get(token);
    }
    
    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    
    let chats = [];
    if (db) {
        chats = await db.collection('chats').find({ userId: session.userId }).sort({ createdAt: 1 }).limit(100).toArray();
    }
    
    res.json({ success: true, chats });
});

app.get('*', (req, res) => {
    if (req.path === '/' || req.path === '/index.html') {
        res.sendFile(path.join(__dirname, 'public', 'landing.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', req.path) || path.join(__dirname, 'public', 'index.html'));
    }
});

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════════════════════╗');
        console.log('║         NEURAL CARE - Mental Health Support         ║');
        console.log('╠═══════════════════════════════════════════════════════╣');
        console.log(`║  🌐 Server:   http://localhost:${PORT}                    ║`);
        console.log('║  🤖 AI:      neuralcare (Ollama)                   ║');
        console.log(`║  💾 Database: ${db ? 'MongoDB' : 'In-Memory'}                              ║`);
        console.log('╚═══════════════════════════════════════════════════════════════╝');
    });
});

// Clinic Reports - Save
app.post('/api/clinic/report', async (req, res) => {
    const { title, type, date, notes } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('clinic_reports').insertOne({
            userId: session.userId,
            title,
            type,
            date,
            notes,
            createdAt: new Date()
        });
    }
    
    res.json({ success: true });
});

// Clinic Reports - Get All
app.get('/api/clinic/reports', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let reports = [];
    if (db) {
        reports = await db.collection('clinic_reports').find({ userId: session.userId }).sort({ date: -1 }).toArray();
    }
    
    res.json({ success: true, reports });
});

// API Key Management - Generate API Key
app.post('/api/user/api-key', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    const apiKey = 'nc_' + crypto.randomBytes(16).toString('hex');
    
    if (db) {
        await db.collection('users').updateOne(
            { _id: new ObjectId(session.userId) },
            { $set: { apiKey: apiKey, apiKeyCreatedAt: new Date() } }
        );
    }
    
    res.json({ success: true, apiKey: apiKey });
});

// Get API Key
app.get('/api/user/api-key', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let user;
    if (db) user = await db.collection('users').findOne({ _id: new ObjectId(session.userId) });
    else user = Array.from(memoryStore.users.values()).find(u => u._id === session.userId);
    
    res.json({ success: true, apiKey: user?.apiKey || null });
});

// Public API endpoint for external users
app.post('/api/public/chat', async (req, res) => {
    const { message, apiKey } = req.body;
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API Key required' });
    }
    
    let user;
    if (db) {
        user = await db.collection('users').findOne({ apiKey: apiKey });
    }
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid API Key' });
    }
    
    let userContext = `User: ${user.name || 'User'}, Age: ${user.age || 'N/A'}, Gender: ${user.gender || 'N/A'}\n\nUser's message: ${message}`;

    if (checkCrisis(message)) {
        return res.json({
            response: CRISIS_RESPONSE,
            is_crisis: true,
            crisis_resources: [{ name: 'iCall', phone: '9152987821' }, { name: 'Vandrevala', phone: '1860 2662 345' }, { name: 'Emergency', phone: '112' }]
        });
    }

    try {
        const responseText = await generateAIResponse(userContext);
        res.json({ response: responseText, is_crisis: false });
    } catch (e) {
        res.json({ response: "I'm here for you. How are you feeling?", is_crisis: false });
    }
});

connectDB().then(() => {
    app.listen(PORT, HOST, () => {
        const os = require('os');
        const networkInterfaces = os.networkInterfaces();
        let ip = 'localhost';
        
        for (const name of Object.keys(networkInterfaces)) {
            for (const iface of networkInterfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ip = iface.address;
                    break;
                }
            }
        }
        
        console.log('');
        console.log('╔═══════════════════════════════════════════════════════════════╗');
        console.log('║         NEURAL CARE - Mental Health Support                 ║');
        console.log('╠═══════════════════════════════════════════════════════════════╣');
        console.log(`║  🌐 Local:    http://localhost:${PORT}                            ║`);
        console.log(`║  📱 Network:  http://${ip}:${PORT}                      ║`);
        console.log('║  🤖 AI:       neuralcare (Ollama)                         ║');
        console.log(`║  💾 Database: ${db ? 'MongoDB' : 'In-Memory'}                                    ║`);
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('To access from other devices, use the Network URL above');
    });
});

// ==================== MEDICATIONS ====================
app.post('/api/medications', async (req, res) => {
    const { name, dosage, frequency, time, notes } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('medications').insertOne({
            userId: session.userId,
            name,
            dosage,
            frequency,
            time,
            instructions: notes,
            active: true,
            lastTaken: null,
            createdAt: new Date()
        });
    }
    
    res.json({ success: true });
});

app.get('/api/medications', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let medications = [];
    if (db) {
        medications = await db.collection('medications').find({ userId: session.userId, active: true }).toArray();
    }
    
    res.json({ success: true, medications });
});

app.delete('/api/medications/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('medications').deleteOne({ _id: new ObjectId(req.params.id) });
    }
    
    res.json({ success: true });
});

app.post('/api/medications/:id/take', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('medications').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { lastTaken: new Date() } }
        );
    }
    
    res.json({ success: true });
});

// ==================== ROUTINE ====================
app.post('/api/routine', async (req, res) => {
    const { title, time, days, enabled } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('routines').insertOne({
            userId: session.userId,
            title,
            time,
            days,
            enabled: enabled !== false,
            createdAt: new Date()
        });
    }
    
    res.json({ success: true });
});

app.get('/api/routine', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let routines = [];
    if (db) {
        routines = await db.collection('routines').find({ userId: session.userId }).toArray();
    }
    
    res.json({ success: true, routines });
});

app.put('/api/routine/:id', async (req, res) => {
    const { enabled } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('routines').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { enabled } });
    }
    
    res.json({ success: true });
});

app.delete('/api/routine/:id', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    if (db) {
        await db.collection('routines').deleteOne({ _id: new ObjectId(req.params.id) });
    }
    
    res.json({ success: true });
});

// ==================== NOTIFICATION LOG ====================
app.get('/api/notifications', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    let notifications = [];
    if (db) {
        notifications = await db.collection('notifications').find({ userId: session.userId }).sort({ createdAt: -1 }).limit(50).toArray();
    }
    
    res.json({ success: true, notifications });
});

app.post('/api/notifications/send-email', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { type, message } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    let session, user;
    if (db) {
        session = await db.collection('sessions').findOne({ token });
        if (session) {
            user = await db.collection('users').findOne({ _id: new ObjectId(session.userId) });
        }
    }
    
    if (!user) return res.status(401).json({ success: false });
    
    // Send email notification
    if (transporter && user.email) {
        const mailOptions = {
            from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
            to: user.email,
            subject: `🔔 NeuralCare Reminder: ${type}`,
            text: message,
            html: `<h2>NeuralCare Reminder</h2><p>${message}</p>`
        };
        
        try {
            await transporter.sendMail(mailOptions);
            console.log(`📧 Notification email sent to ${user.email}`);
        } catch(e) {
            console.log('Email error:', e.message);
        }
    }
    
    res.json({ success: true });
});
