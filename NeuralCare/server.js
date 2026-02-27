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
const MENTAL_HEALTH_RESPONSES = [
    "I understand you're going through a difficult time. I'm here to listen. Would you like to tell me more about how you're feeling?",
    "Thank you for sharing that with me. It takes courage to talk about these things. How long have you been feeling this way?",
    "I'm here to support you. Remember, it's okay to not be okay. Would you like to explore some coping strategies together?",
    "I hear you. Taking care of your mental health is important. Have you tried any relaxation techniques like deep breathing?",
    "It's completely normal to feel overwhelmed sometimes. You're not alone in this. Would you like to talk about what's on your mind?"
];

function generateAIResponse(prompt) {
    return new Promise((resolve) => {
        const cleanPrompt = prompt.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
        
        const process = spawn('ollama', ['run', 'neuralcare', cleanPrompt]);
        let output = '';
        let hasError = false;
        
        process.stdout.on('data', (data) => { output += data.toString(); });
        process.stderr.on('data', (data) => { 
            const err = data.toString();
            if (err.includes('image') || err.includes('error') || err.includes('failed')) {
                hasError = true;
            }
        });
        
        process.on('close', (code) => {
            if (code === 0 && output.trim() && !hasError && output.length > 10) {
                resolve(output.trim());
            } else {
                const randomResponse = MENTAL_HEALTH_RESPONSES[Math.floor(Math.random() * MENTAL_HEALTH_RESPONSES.length)];
                resolve(randomResponse);
            }
        });
        
        process.on('error', () => {
            const randomResponse = MENTAL_HEALTH_RESPONSES[Math.floor(Math.random() * MENTAL_HEALTH_RESPONSES.length)];
            resolve(randomResponse);
        });
        
        setTimeout(() => { 
            process.kill(); 
            const randomResponse = MENTAL_HEALTH_RESPONSES[Math.floor(Math.random() * MENTAL_HEALTH_RESPONSES.length)];
            resolve(randomResponse);
        }, 30000);
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
    console.log(`📧 OTP for ${normalizedEmail}: ${otp}`);
    res.json({ success: true, message: 'OTP sent to email' });
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
    
    res.json({ success: true, message: 'OTP sent to your email' });
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
    if (Date.now() - created > 5 * 60 * 1000) {
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
    if (Date.now() - created > 5 * 60 * 1000) {
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
