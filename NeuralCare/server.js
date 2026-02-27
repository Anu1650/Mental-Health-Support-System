const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
        await db.collection('otps').createIndex({ email: 1 }, { expireAfterSeconds: 300 });
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

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
}

async function sendOTP(email, otp) {
    const mailOptions = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: email,
        subject: '🔐 Your NeuralCare Verification Code',
        html: `<h2>Your OTP: ${otp}</h2><p>Valid for 5 minutes.</p>`,
        text: `Your NeuralCare OTP: ${otp}. Valid for 5 minutes.`
    };

    if (transporter) {
        try {
            await transporter.sendMail(mailOptions);
            return true;
        } catch (e) {
            console.log('Email error:', e.message);
        }
    }
    console.log(`📧 OTP for ${email}: ${otp}`);
    return true;
}

// ==================== OLLAMA AI ====================
function generateAIResponse(prompt) {
    return new Promise((resolve) => {
        // Clean prompt - remove any image references
        const cleanPrompt = prompt.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
        
        const process = spawn('ollama', ['run', 'neuralcare', cleanPrompt]);
        let output = '';
        
        process.stdout.on('data', (data) => { output += data.toString(); });
        process.stderr.on('data', (data) => { 
            if (data.toString().includes('image')) {
                output = ''; 
            }
        });
        
        process.on('close', () => {
            resolve(output.trim() || "I'm here to support you. How are you feeling today?");
        });
        
        process.on('error', () => {
            resolve("I'm here to support you. How are you feeling?");
        });
        
        setTimeout(() => { process.kill(); resolve("I'm here for you."); }, 60000);
    });
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
    res.json({ success: true, message: 'OTP sent to email' });
});

app.post('/api/auth/verify', async (req, res) => {
    const { email, otp, name } = req.body;
    
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
    if (Date.now() - created > 5 * 60 * 1000) {
        return res.status(400).json({ success: false, message: 'OTP expired. Request new one.' });
    }
    
    if (storedOTP.otp !== otp) {
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    
    if (db) {
        await db.collection('otps').deleteOne({ email: normalizedEmail });
    } else {
        memoryStore.otps.delete(normalizedEmail);
    }
    
    let user;
    if (db) {
        user = await db.collection('users').findOne({ email: normalizedEmail });
        if (!user) {
            const result = await db.collection('users').insertOne({
                email: normalizedEmail,
                name: name || email.split('@')[0],
                createdAt: new Date()
            });
            user = { _id: result.insertedId, email: normalizedEmail, name: name || email.split('@')[0] };
        }
    } else {
        if (!memoryStore.users.has(normalizedEmail)) {
            memoryStore.users.set(normalizedEmail, {
                _id: 'mem_' + Date.now(),
                email: normalizedEmail,
                name: name || email.split('@')[0],
                createdAt: Date.now()
            });
        }
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
        user: { id: user._id.toString(), email: user.email, name: user.name },
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
    
    res.json({ success: true, user: { id: user._id.toString(), email: user.email, name: user.name, phone: user.phone, age: user.age, gender: user.gender } });
});

app.post('/api/user/profile', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { name, phone, age, gender } = req.body;
    
    if (!token) return res.status(401).json({ success: false });
    
    let session;
    if (db) session = await db.collection('sessions').findOne({ token });
    else session = memoryStore.sessions.get(token);
    
    if (!session) return res.status(401).json({ success: false });
    
    const updateData = { name, phone, age, gender };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    
    if (db) await db.collection('users').updateOne({ _id: new ObjectId(session.userId) }, { $set: updateData });
    else {
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

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    
    if (!message?.trim()) {
        return res.status(400).json({ error: 'Empty message' });
    }

    if (checkCrisis(message)) {
        return res.json({
            response: CRISIS_RESPONSE,
            is_crisis: true,
            crisis_resources: [{ name: 'iCall', phone: '9152987821' }, { name: 'Vandrevala', phone: '1860 2662 345' }, { name: 'Emergency', phone: '112' }]
        });
    }

    try {
        const responseText = await generateAIResponse(message);
        res.json({ response: responseText, is_crisis: false });
    } catch (e) {
        res.json({ response: "I'm here for you. How are you feeling?", is_crisis: false });
    }
});

app.post('/api/assessment', async (req, res) => {
    const { answers } = req.body;
    
    let score = 0;
    const values = { 'not_at_all': 0, 'several_days': 1, 'more_than_half': 2, 'nearly_every': 3 };
    
    Object.values(answers || {}).forEach(val => { score += values[val] || 0; });
    
    let level, message, color;
    if (score <= 4) { level = "low"; color = "#10b981"; message = "You're doing well!"; }
    else if (score <= 9) { level = "moderate"; color = "#f59e0b"; message = "Some symptoms noted."; }
    else { level = "high"; color = "#ef4444"; message = "Consider speaking with a professional."; }
    
    res.json({ score, level, message, color, maxScore: 21 });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
        console.log('╚═══════════════════════════════════════════════════════╝');
    });
});
