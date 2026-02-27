const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== MONGODB CONNECTION ====================
let db = null;
let mongoClient = null;

async function connectDB() {
    const mongoUri = process.env.MONGODB_URI;
    
    // If no MongoDB URI, use in-memory
    if (!mongoUri || mongoUri.trim() === '') {
        console.log('⚠️  MongoDB URI not configured. Using in-memory storage.');
        return null;
    }
    
    try {
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        db = mongoClient.db();
        console.log('✅ Connected to MongoDB Atlas');
        
        // Create indexes
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
        await db.collection('chats').createIndex({ userId: 1, createdAt: -1 });
        await db.collection('assessments').createIndex({ userId: 1, createdAt: -1 });
        await db.collection('otps').createIndex({ email: 1 }, { expireAfterSeconds: 300 });
        await db.collection('sessions').createIndex({ token: 1 });
        await db.collection('moodlogs').createIndex({ userId: 1, date: -1 });
        await db.collection('journal').createIndex({ userId: 1, date: -1 });
        
        return db;
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        console.log('📝 Using in-memory storage as fallback');
        return null;
    }
}
connectDB();

// ==================== EMAIL CONFIG ====================
let transporter = null;

function setupEmail() {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    
    if (emailUser && emailPass && emailUser.includes('@')) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });
        console.log('✅ Email configured');
        return true;
    }
    console.log('⚠️  Email not configured. Using dev mode.');
    return false;
}
setupEmail();

// ==================== EMAIL TEMPLATE ====================
async function sendOTPEmail(email, otp) {
    const mailOptions = {
        from: process.env.EMAIL_FROM || '"Neural Care" <noreply@neuralcare.com>',
        to: email,
        subject: '🔐 Your Neural Care Verification Code',
        html: `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
            <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                    <td align="center" style="padding: 40px 20px;">
                        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 450px; background: white; border-radius: 20px; overflow: hidden;">
                            <tr>
                                <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
                                    <h1 style="color: white; margin: 0; font-size: 28px;">Neural Care</h1>
                                    <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0;">Mental Health Support</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 30px;">
                                    <h2 style="color: #333; margin: 0 0 15px;">Your Verification Code</h2>
                                    <p style="color: #666; margin: 0 0 20px;">Welcome to Neural Care! Enter this code to verify your email.</p>
                                    <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
                                        <span style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 10px;">${otp}</span>
                                    </div>
                                    <p style="color: #999; font-size: 12px; text-align: center;">This code expires in 5 minutes.</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="background: #f8f9fa; padding: 20px; text-align: center;">
                                    <p style="color: #999; font-size: 11px; margin: 0;">© 2024 Neural Care. This is an automated email.</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `,
        text: `Your Neural Care verification code: ${otp}. This code expires in 5 minutes.`
    };

    if (transporter) {
        try {
            await transporter.sendMail(mailOptions);
            console.log(`✅ OTP sent to ${email}`);
            return true;
        } catch (err) {
            console.error('❌ Email error:', err.message);
            return false;
        }
    } else {
        console.log(`\n📧 [DEV MODE] OTP for ${email}: ${otp}\n`);
        return true;
    }
}

// ==================== IN-MEMORY STORES ====================
const memoryStore = {
    otps: new Map(),
    sessions: new Map(),
    users: new Map(),
    chats: new Map(),
    assessments: new Map(),
    moodLogs: new Map(),
    journal: new Map()
};

// ==================== HELPERS ====================
const CRISIS_KEYWORDS = ['suicide', 'kill myself', 'want to die', 'end it all', 'self harm', 'hurt myself', 'no reason to live', "can't go on"];

const CRISIS_RESPONSE = `I'm really concerned about you. Please reach out now:

📞 **iCall:** 9152987821
📞 **Vandrevala:** 1860 2662 345
📞 **NIMHANS:** 080-4611 0007
📞 **Emergency:** 112

You don't have to face this alone. Please call now.`;

function checkCrisis(text) {
    return CRISIS_KEYWORDS.some(k => text.toLowerCase().includes(k));
}

function generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// MongoDB or Memory helpers
async function dbInsert(collection, data) {
    if (db) {
        return await db.collection(collection).insertOne(data);
    }
    const id = new ObjectId().toString();
    memoryStore[collection].set(id, { ...data, _id: id });
    return { insertedId: id };
}

async function dbFindOne(collection, query) {
    if (db) {
        return await db.collection(collection).findOne(query);
    }
    return Array.from(memoryStore[collection].values()).find(item => {
        return Object.keys(query).every(k => item[k] === query[k]);
    });
}

async function dbUpdate(collection, query, data) {
    if (db) {
        return await db.collection(collection).updateOne(query, { $set: data });
    }
    const item = await dbFindOne(collection, query);
    if (item) {
        memoryStore[collection].set(item._id.toString(), { ...item, ...data });
    }
    return { modifiedCount: 1 };
}

async function dbDelete(collection, query) {
    if (db) {
        return await db.collection(collection).deleteOne(query);
    }
    const item = await dbFindOne(collection, query);
    if (item) {
        memoryStore[collection].delete(item._id.toString());
    }
    return { deletedCount: 1 };
}

async function dbFind(collection, query = {}, sort = {}, limit = 100) {
    if (db) {
        return await db.collection(collection).find(query).sort(sort).limit(limit).toArray();
    }
    return Array.from(memoryStore[collection].values())
        .filter(item => Object.keys(query).every(k => item[k] === query[k]))
        .sort((a, b) => (sort.createdAt || 0) === -1 ? b.createdAt - a.createdAt : 0)
        .slice(0, limit);
}

// ==================== OLLAMA AI ====================
function generateAIResponse(prompt) {
    return new Promise((resolve) => {
        const process = spawn('ollama', ['run', 'neuralcare', prompt]);
        let output = '';
        
        process.stdout.on('data', d => output += d.toString());
        process.stderr.on('data', () => {});
        process.on('close', () => resolve(output.trim() || "I'm here for you. Please try again."));
        process.on('error', () => resolve("I'm having trouble connecting."));
        setTimeout(() => { process.kill(); resolve("Please try again."); }, 90000);
    });
}

// ==================== ROUTES ====================

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        name: 'Neural Care',
        version: '2.0.0',
        database: db ? 'MongoDB Connected' : 'In-Memory',
        email: transporter ? 'Ready' : 'Dev Mode',
        timestamp: new Date().toISOString()
    });
});

// Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const otp = generateOTP();
    
    // Save OTP
    await dbInsert('otps', {
        email: normalizedEmail,
        otp,
        attempts: 0,
        createdAt: new Date()
    });
    
    const sent = await sendOTPEmail(normalizedEmail, otp);
    
    res.json({ 
        success: sent, 
        message: sent ? 'OTP sent to your email' : 'Failed to send OTP'
    });
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    
    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const storedOTP = await dbFindOne('otps', { email: normalizedEmail });
    
    if (!storedOTP) {
        return res.status(400).json({ success: false, message: 'No OTP found. Request again.' });
    }
    
    // Check expiry (5 minutes)
    if (Date.now() - new Date(storedOTP.createdAt).getTime() > 5 * 60 * 1000) {
        await dbDelete('otps', { email: normalizedEmail });
        return res.status(400).json({ success: false, message: 'OTP expired. Request again.' });
    }
    
    if (storedOTP.otp !== otp) {
        const attempts = (storedOTP.attempts || 0) + 1;
        if (attempts >= 3) {
            await dbDelete('otps', { email: normalizedEmail });
            return res.status(400).json({ success: false, message: 'Too many attempts. Request again.' });
        }
        await dbUpdate('otps', { email: normalizedEmail }, { attempts });
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    
    // Success - delete OTP
    await dbDelete('otps', { email: normalizedEmail });
    
    // Get or create user
    let user = await dbFindOne('users', { email: normalizedEmail });
    
    if (!user) {
        const result = await dbInsert('users', {
            email: normalizedEmail,
            name: normalizedEmail.split('@')[0],
            createdAt: new Date(),
            language: 'en'
        });
        user = { _id: result.insertedId, email: normalizedEmail, name: normalizedEmail.split('@')[0] };
    }
    
    const sessionToken = generateToken();
    await dbInsert('sessions', {
        token: sessionToken,
        userId: user._id.toString(),
        createdAt: new Date()
    });
    
    res.json({ 
        success: true, 
        message: 'Login successful',
        user: { 
            id: user._id.toString(), 
            email: user.email, 
            name: user.name,
            language: user.language
        },
        session_token: sessionToken
    });
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
    const { session_token } = req.body;
    if (session_token) {
        await dbDelete('sessions', { token: session_token });
    }
    res.json({ success: true });
});

// Get current user
app.get('/api/auth/me', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    
    const user = await dbFindOne('users', { _id: new ObjectId(session.userId) });
    if (!user) {
        return res.status(401).json({ success: false, message: 'User not found' });
    }
    
    res.json({ 
        success: true, 
        user: { 
            id: user._id.toString(), 
            email: user.email, 
            name: user.name,
            phone: user.phone,
            age: user.age,
            gender: user.gender,
            language: user.language,
            createdAt: user.createdAt
        } 
    });
});

// Update profile
app.post('/api/user/profile', async (req, res) => {
    const { name, phone, age, gender, language } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    
    const updateData = { name, phone, age, gender, language };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    
    await dbUpdate('users', { _id: new ObjectId(session.userId) }, updateData);
    
    const user = await dbFindOne('users', { _id: new ObjectId(session.userId) });
    
    res.json({ 
        success: true, 
        user: { 
            id: user._id.toString(), 
            email: user.email, 
            name: user.name,
            phone: user.phone,
            age: user.age,
            gender: user.gender,
            language: user.language
        } 
    });
});

// Mood Tracking
app.post('/api/mood', async (req, res) => {
    const { mood, note } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false });
    }
    
    await dbInsert('moodlogs', {
        userId: session.userId,
        mood,
        note,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date()
    });
    
    res.json({ success: true });
});

app.get('/api/mood', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false });
    }
    
    const moods = await dbFind('moodlogs', { userId: session.userId }, { createdAt: -1 }, 30);
    res.json({ success: true, moods });
});

// Journal
app.post('/api/journal', async (req, res) => {
    const { title, content, mood } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false });
    }
    
    await dbInsert('journal', {
        userId: session.userId,
        title,
        content,
        mood,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date()
    });
    
    res.json({ success: true });
});

app.get('/api/journal', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false });
    }
    
    const entries = await dbFind('journal', { userId: session.userId }, { createdAt: -1 }, 50);
    res.json({ success: true, entries });
});

// Chat
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!message?.trim()) {
        return res.status(400).json({ error: 'Empty message' });
    }

    let userId = 'anonymous';
    if (token) {
        const session = await dbFindOne('sessions', { token });
        if (session) userId = session.userId;
    }

    // Crisis check
    if (checkCrisis(message)) {
        await dbInsert('chats', {
            userId,
            message,
            response: '[CRISIS]',
            isCrisis: true,
            createdAt: new Date()
        });
        return res.json({
            response: CRISIS_RESPONSE,
            is_crisis: true,
            crisis_resources: [
                { name: 'iCall', phone: '9152987821' },
                { name: 'Vandrevala', phone: '1860 2662 345' },
                { name: 'NIMHANS', phone: '080-4611 0007' },
                { name: 'Emergency', phone: '112' }
            ]
        });
    }

    try {
        const responseText = await generateAIResponse(message);
        await dbInsert('chats', {
            userId,
            message,
            response: responseText,
            isCrisis: false,
            createdAt: new Date()
        });
        
        res.json({
            response: responseText,
            is_crisis: false,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.json({
            response: "I'm here for you. Please try again.",
            is_crisis: false
        });
    }
});

// Assessment
app.post('/api/assessment', async (req, res) => {
    const { answers } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    let score = 0;
    const values = { 'not_at_all': 0, 'several_days': 1, 'more_than_half': 2, 'nearly_every': 3 };
    
    Object.values(answers || {}).forEach(val => {
        score += values[val] || 0;
    });
    
    let level, message, color;
    if (score <= 4) {
        level = "low"; color = "#10b981";
        message = "You're doing well! Keep up your healthy habits.";
    } else if (score <= 9) {
        level = "moderate"; color = "#f59e0b";
        message = "Some symptoms noted. Consider talking to someone.";
    } else {
        level = "high"; color = "#ef4444";
        message = "Please consider speaking with a professional.";
    }
    
    // Save assessment
    if (token) {
        const session = await dbFindOne('sessions', { token });
        if (session) {
            await dbInsert('assessments', {
                userId: session.userId,
                answers,
                score,
                level,
                message,
                createdAt: new Date()
            });
        }
    }
    
    res.json({ score, level, message, color, maxScore: 21 });
});

// Get assessments
app.get('/api/assessments', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false });
    }
    
    const session = await dbFindOne('sessions', { token });
    if (!session) {
        return res.status(401).json({ success: false });
    }
    
    const assessments = await dbFind('assessments', { userId: session.userId }, { createdAt: -1 }, 10);
    res.json({ success: true, assessments });
});

// Clear chat
app.post('/api/chat/clear', async (req, res) => {
    res.json({ success: true });
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║         NEURAL CARE - Mental Health Support         ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  🌐 Server:   http://localhost:${PORT}                    ║`);
    console.log('║  🤖 AI:      neuralcare (Ollama)                   ║');
    console.log(`║  💾 Database: ${db ? 'MongoDB Atlas' : 'In-Memory'}                             ║`);
    console.log(`║  📧 Email:    ${transporter ? 'Ready' : 'Dev Mode'}                              ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('');
});
