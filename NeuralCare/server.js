const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
require('dotenv').config();

const application = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

application.use(cors());
application.use(express.json({ limit: '10mb' }));
application.use(express.static('public'));

let databaseInstance = null;
const memoryStorage = {
    users: new Map(),
    otps: new Map(),
    sessions: new Map()
};

const initializeDatabase = async () => {
    const mongoConnectionString = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    if (!mongoConnectionString) {
        console.log('Using in-memory storage system');
        return null;
    }
    
    try {
        const { MongoClient } = require('mongodb');
        const mongoConnection = new MongoClient(mongoConnectionString);
        await mongoConnection.connect();
        databaseInstance = mongoConnection.db();
        
        await databaseInstance.collection('users').createIndex({ email: 1 }, { unique: true });
        await databaseInstance.collection('otps').createIndex({ email: 1 }, { expireAfterSeconds: 1800 });
        await databaseInstance.collection('sessions').createIndex({ token: 1 }, { expireAfterSeconds: 86400 });
        
        return databaseInstance;
    } catch (error) {
        console.error('Database connection failed:', error.message);
        return null;
    }
};

const crisisIndicators = ['suicide', 'kill myself', 'want to die', 'end it all', 'self harm', 'hurt myself'];
const crisisSupportMessage = `I'm concerned about you. Please reach out now:\n\n📞 iCall: 9152987821\n📞 Vandrevala: 1860 2662 345\n📞 Emergency: 112`;

const containsCrisisContent = (text) => {
    return crisisIndicators.some(keyword => text.toLowerCase().includes(keyword));
};

const generateSecureOTP = () => {
    return crypto.randomInt(100000, 999999).toString();
};

const generateSessionToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

const getActiveStorage = () => {
    return databaseInstance || memoryStorage;
};

const nodemailer = require('nodemailer');
let emailTransporter = null;
let isEmailConfigured = false;

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        }
    });
    
    emailTransporter.verify((error, success) => {
        if (error) {
            console.log('Email service unavailable:', error.message);
            isEmailConfigured = false;
        } else {
            console.log('Email service ready');
            isEmailConfigured = true;
        }
    });
}

const deliverOTPByEmail = async (recipientEmail, otpCode) => {
    const emailContent = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: recipientEmail,
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
        <div class="otp">${otpCode}</div>
        <p>Valid for <strong>30 minutes</strong>.</p>
        <div class="footer">
            <p>This code was requested for your NeuralCare account.</p>
            <p>If you didn't request this, please ignore this email.</p>
        </div>
    </div>
</body>
</html>`,
        text: `Your NeuralCare OTP: ${otpCode}. Valid for 30 minutes.`
    };

    if (emailTransporter) {
        try {
            await emailTransporter.sendMail(emailContent);
            return true;
        } catch (error) {
            console.error('Email delivery failed:', error.message);
        }
    }
    return true;
};

const systemPrompt = `You are NeuralCare - a cool, friendly mental health buddy. Think of yourself as that supportive best friend who's always there for their buddy.

Your style:
- Be casual and fun, like chatting with a close friend
- Use short sentences and conversational tone
- Add emojis naturally (😊, 👍, 💪, 😅)
- Don't be formal or use big words
- Start responses naturally - NEVER use "I'm here for you" or "How can I help you"
- Use buddy's name when you know it
- If buddy seems down, be playful and encouraging first
- Keep messages short (1-3 lines max)
- Ask one simple question at a time
- For breathing: explain like teaching a friend, keep it simple`;

const languagePrompts = {
    en: "Respond in English in a warm, conversational way.",
    hi: "Respond in Hindi (हिंदी) in a warm, conversational way. Use simple Hindi that everyone can understand.",
    te: "Respond in Telugu (తెలుగు) in a warm, conversational way.",
    ta: "Respond in Tamil (தமிழ்) in a warm, conversational way.",
    bn: "Respond in Bengali (বাংলা) in a warm, conversational way.",
    mr: "Respond in Marathi (मराठी) in a warm, conversational way.",
    kn: "Respond in Kannada (ಕನ್ನಡ) in a warm, conversational way.",
    ml: "Respond in Malayalam (മലയാളം) in a warm, conversational way."
};

const executeRequestWithTimeout = async (url, options, timeoutMs = 30000) => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, { ...options, signal: abortController.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

const generateAIResponse = async (userInput, contextData = '') => {
    const cleanedInput = userInput.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
    
    const fullPrompt = `You are NeuralCare - a caring, empathetic mental health friend. 

Your style:
- Be warm, conversational and genuinely caring
- Use the user's name when you know it
- Give detailed, thoughtful responses (not short)
- Show empathy before giving advice
- Ask follow-up questions
- Use emojis naturally
- Reference what they specifically shared

IMPORTANT - User Information:
${contextData}

User says: "${cleanedInput}"

Reply as a caring friend would - be personal, warm, and detailed. Use their name if you know it. Make your response thoughtful and helpful.`;

    const modelEndpoints = [
        { name: 'neuralcare', url: 'http://localhost:11434/api/generate', timeout: 90000 },
        { name: 'llama3', url: 'http://localhost:11434/api/generate', timeout: 60000 },
        { name: 'mistral', url: 'http://localhost:11434/api/generate', timeout: 60000 }
    ];

    for (const model of modelEndpoints) {
        try {
            const response = await executeRequestWithTimeout(model.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model.name,
                    prompt: fullPrompt,
                    stream: false,
                    options: { temperature: 0.8, top_p: 0.9, num_ctx: 4096, num_predict: 1000 }
                })
            }, model.timeout);
            
            const result = await response.json();
            
            if (response.ok && result.response && result.response.trim()) {
                return result.response.trim();
            }
        } catch (error) {
            continue;
        }
    }
    
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (openRouterApiKey) {
        try {
            const response = await executeRequestWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openRouterApiKey}`,
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'NeuralCare'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-3.5-turbo',
                    messages: [{ role: 'user', content: fullPrompt }],
                    temperature: 0.8,
                    max_tokens: 500
                })
            }, 30000);
            
            const result = await response.json();
            
            if (response.ok && result.choices && result.choices[0]?.message?.content) {
                return result.choices[0].message.content.trim();
            }
        } catch (error) {}
    }
    
    const fallbackResponses = [
        "Hey buddy! What's up? 😊 Tell me what's on your mind!",
        "Yo! What's happening? 😄 I'm here to chat!",
        "Hey! Good to see you 👊 What's going on?",
        "Bro! What's making you think? 😄"
    ];
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
};

const detectMoodFromText = (messageContent) => {
    const text = messageContent.toLowerCase();
    
    if (text.includes('happy') || text.includes('great') || text.includes('wonderful') || text.includes('amazing') || text.includes('love') || text.includes('excited') || text.includes('joy') || text.includes('grateful') || text.includes('thankful') || text.includes('better') || text.includes('improving')) {
        return 'great';
    }
    
    if (text.includes('good') || text.includes('nice') || text.includes('fine') || text.includes('okay') || text.includes('ok') || text.includes('better') || text.includes('relaxed') || text.includes('calm') || text.includes('peaceful')) {
        return 'good';
    }
    
    if (text.includes('okay') || text.includes('ok') || text.includes('normal') || text.includes('average') || text.includes('usual')) {
        return 'okay';
    }
    
    if (text.includes('sad') || text.includes('down') || text.includes('depressed') || text.includes('unhappy') || text.includes('disappointed') || text.includes('hurt') || text.includes('heartbroken') || text.includes('miss') || text.includes('lonely') || text.includes('alone')) {
        return 'bad';
    }
    
    if (text.includes('anxious') || text.includes('worried') || text.includes('stressed') || text.includes('overwhelmed') || text.includes('panic') || text.includes('scared') || text.includes('afraid') || text.includes('terrible') || text.includes('awful') || text.includes('horrible') || text.includes('hopeless') || text.includes('worthless') || text.includes('tired') || text.includes('exhausted')) {
        return 'terrible';
    }
    
    return null;
};

application.get('/api/health', (request, response) => {
    response.json({ 
        status: 'operational', 
        service: 'NeuralCare', 
        version: '2.0.0', 
        database: databaseInstance ? 'Connected' : 'In-Memory' 
    });
});

application.post('/api/auth/send-otp', async (request, response) => {
    const { email } = request.body;
    
    if (!email || !email.includes('@')) {
        return response.status(400).json({ 
            success: false, 
            message: 'A valid email address is required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    const otpCode = generateSecureOTP();
    
    const storage = getActiveStorage();
    
    if (databaseInstance) {
        await databaseInstance.collection('otps').deleteMany({ email: normalizedEmail });
        await databaseInstance.collection('otps').insertOne({ 
            email: normalizedEmail, 
            otp: otpCode, 
            attempts: 0, 
            createdAt: new Date() 
        });
    } else {
        memoryStorage.otps.set(normalizedEmail, { 
            otp: otpCode, 
            attempts: 0, 
            createdAt: Date.now() 
        });
    }
    
    await deliverOTPByEmail(normalizedEmail, otpCode);
    
    const isDevelopment = process.env.NODE_ENV !== 'production';
    response.json({ 
        success: true, 
        message: isDevelopment ? 'OTP sent (check server console)' : 'OTP sent to your email',
        devOTP: isDevelopment ? otpCode : undefined 
    });
});

application.post('/api/auth/login', async (request, response) => {
    const { email, password } = request.body;
    
    if (!email || !password) {
        return response.status(400).json({ 
            success: false, 
            message: 'Email and password are required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    
    let userRecord;
    
    if (databaseInstance) {
        userRecord = await databaseInstance.collection('users').findOne({ email: normalizedEmail });
    } else {
        userRecord = memoryStorage.users.get(normalizedEmail);
    }
    
    if (!userRecord) {
        return response.json({ 
            success: false, 
            message: 'No account found with this email. Please sign up first.' 
        });
    }
    
    if (userRecord.password !== password) {
        return response.json({ 
            success: false, 
            message: 'Incorrect password' 
        });
    }
    
    const sessionToken = generateSessionToken();
    
    if (databaseInstance) {
        await databaseInstance.collection('sessions').insertOne({ 
            token: sessionToken, 
            userId: userRecord._id.toString(), 
            createdAt: new Date() 
        });
    } else {
        memoryStorage.sessions.set(sessionToken, { 
            userId: userRecord._id, 
            createdAt: Date.now() 
        });
    }
    
    response.json({ 
        success: true, 
        message: 'Login successful', 
        user: { 
            id: userRecord._id.toString(), 
            email: userRecord.email, 
            name: userRecord.name 
        }, 
        token: sessionToken 
    });
});

application.post('/api/auth/forgot-password', async (request, response) => {
    const { email } = request.body;
    
    if (!email || !email.includes('@')) {
        return response.status(400).json({ 
            success: false, 
            message: 'A valid email address is required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    
    let userRecord;
    
    if (databaseInstance) {
        userRecord = await databaseInstance.collection('users').findOne({ email: normalizedEmail });
    } else {
        userRecord = memoryStorage.users.get(normalizedEmail);
    }
    
    if (!userRecord) {
        return response.json({ 
            success: false, 
            message: 'No account found with this email' 
        });
    }
    
    const otpCode = generateSecureOTP();
    
    if (databaseInstance) {
        await databaseInstance.collection('otps').deleteMany({ email: normalizedEmail });
        await databaseInstance.collection('otps').insertOne({ 
            email: normalizedEmail, 
            otp: otpCode, 
            purpose: 'reset', 
            createdAt: new Date() 
        });
    } else {
        memoryStorage.otps.set(normalizedEmail, { 
            otp: otpCode, 
            purpose: 'reset', 
            createdAt: Date.now() 
        });
    }
    
    await deliverOTPByEmail(normalizedEmail, otpCode);
    
    const isDevelopment = process.env.NODE_ENV !== 'production';
    response.json({ 
        success: true, 
        message: isDevelopment ? 'OTP sent (check server console)' : 'OTP sent to your email',
        devOTP: isDevelopment ? otpCode : undefined 
    });
});

application.post('/api/auth/reset-password', async (request, response) => {
    const { email, otp, password } = request.body;
    
    if (!email || !otp || !password) {
        return response.status(400).json({ 
            success: false, 
            message: 'Email, OTP code, and new password are required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    
    let storedOtpRecord;
    
    if (databaseInstance) {
        storedOtpRecord = await databaseInstance.collection('otps').findOne({ email: normalizedEmail });
    } else {
        storedOtpRecord = memoryStorage.otps.get(normalizedEmail);
    }
    
    if (!storedOtpRecord) {
        return response.status(400).json({ 
            success: false, 
            message: 'No OTP found. Please request a new one.' 
        });
    }
    
    const creationTime = storedOtpRecord.createdAt?.getTime?.() || storedOtpRecord.createdAt;
    if (Date.now() - creationTime > 30 * 60 * 1000) {
        return response.status(400).json({ 
            success: false, 
            message: 'OTP has expired. Please request a new one.' 
        });
    }
    
    if (storedOtpRecord.otp !== String(otp)) {
        return response.status(400).json({ 
            success: false, 
            message: 'Invalid OTP code' 
        });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('otps').deleteOne({ email: normalizedEmail });
    } else {
        memoryStorage.otps.delete(normalizedEmail);
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('users').updateOne(
            { email: normalizedEmail }, 
            { $set: { password } }
        );
    } else {
        const userRecord = memoryStorage.users.get(normalizedEmail);
        if (userRecord) {
            userRecord.password = password;
        }
    }
    
    response.json({ 
        success: true, 
        message: 'Password has been reset successfully' 
    });
});

application.post('/api/auth/verify', async (request, response) => {
    const { email, otp, name, phone, age, gender, address, password } = request.body;
    
    if (!email || !otp) {
        return response.status(400).json({ 
            success: false, 
            message: 'Email and OTP code are required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    
    let storedOtpRecord;
    
    if (databaseInstance) {
        storedOtpRecord = await databaseInstance.collection('otps').findOne({ email: normalizedEmail });
    } else {
        storedOtpRecord = memoryStorage.otps.get(normalizedEmail);
    }
    
    if (!storedOtpRecord) {
        return response.status(400).json({ 
            success: false, 
            message: 'No OTP found. Please request a new one.' 
        });
    }
    
    const creationTime = storedOtpRecord.createdAt?.getTime?.() || storedOtpRecord.createdAt;
    if (Date.now() - creationTime > 30 * 60 * 1000) {
        return response.status(400).json({ 
            success: false, 
            message: 'OTP has expired. Please request a new one.' 
        });
    }
    
    if (storedOtpRecord.otp !== String(otp)) {
        return response.status(400).json({ 
            success: false, 
            message: 'Invalid OTP code' 
        });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('otps').deleteOne({ email: normalizedEmail });
    } else {
        memoryStorage.otps.delete(normalizedEmail);
    }
    
    const newUserData = {
        email: normalizedEmail,
        name: name || email.split('@')[0],
        phone: phone || '',
        age: age || '',
        gender: gender || '',
        address: address || '',
        password: password || '',
        createdAt: databaseInstance ? new Date() : Date.now()
    };
    
    let existingUser;
    
    if (databaseInstance) {
        existingUser = await databaseInstance.collection('users').findOne({ email: normalizedEmail });
    } else {
        existingUser = memoryStorage.users.get(normalizedEmail);
    }
    
    if (existingUser) {
        return response.status(400).json({ 
            success: false, 
            message: 'An account already exists with this email. Please login or reset your password.' 
        });
    }
    
    let createdUser;
    
    if (databaseInstance) {
        const insertResult = await databaseInstance.collection('users').insertOne(newUserData);
        createdUser = { _id: insertResult.insertedId, ...newUserData };
    } else {
        const userId = 'user_' + Date.now();
        memoryStorage.users.set(normalizedEmail, { _id: userId, ...newUserData });
        createdUser = memoryStorage.users.get(normalizedEmail);
    }
    
    const sessionToken = generateSessionToken();
    
    if (databaseInstance) {
        await databaseInstance.collection('sessions').insertOne({ 
            token: sessionToken, 
            userId: createdUser._id.toString(), 
            createdAt: new Date() 
        });
    } else {
        memoryStorage.sessions.set(sessionToken, { 
            userId: createdUser._id, 
            createdAt: Date.now() 
        });
    }
    
    response.json({
        success: true,
        message: 'Account created successfully',
        user: { 
            id: createdUser._id.toString(), 
            email: createdUser.email, 
            name: createdUser.name, 
            phone: createdUser.phone, 
            age: createdUser.age, 
            gender: createdUser.gender, 
            address: createdUser.address 
        },
        token: sessionToken
    });
});

application.post('/api/auth/logout', async (request, response) => {
    const { token } = request.body;
    
    if (token) {
        if (databaseInstance) {
            await databaseInstance.collection('sessions').deleteOne({ token });
        } else {
            memoryStorage.sessions.delete(token);
        }
    }
    
    response.json({ success: true });
});

application.get('/api/auth/me', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let userRecord;
    
    if (databaseInstance) {
        userRecord = await databaseInstance.collection('users').findOne({ 
            _id: new ObjectId(sessionRecord.userId) 
        });
    } else {
        const users = Array.from(memoryStorage.users.values());
        userRecord = users.find(user => user._id === sessionRecord.userId);
    }
    
    if (!userRecord) {
        return response.status(401).json({ success: false });
    }
    
    response.json({ 
        success: true, 
        user: { 
            id: userRecord._id.toString(), 
            email: userRecord.email, 
            name: userRecord.name, 
            phone: userRecord.phone, 
            age: userRecord.age, 
            gender: userRecord.gender, 
            address: userRecord.address 
        } 
    });
});

application.post('/api/user/profile', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { name, phone, age, gender, address } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    const profileUpdates = { name, phone, age, gender, address };
    Object.keys(profileUpdates).forEach(key => {
        if (profileUpdates[key] === undefined) {
            delete profileUpdates[key];
        }
    });
    
    if (databaseInstance) {
        await databaseInstance.collection('users').updateOne(
            { _id: new ObjectId(sessionRecord.userId) }, 
            { $set: profileUpdates }
        );
    } else {
        const users = Array.from(memoryStorage.users.values());
        const targetUser = users.find(user => user._id === sessionRecord.userId);
        if (targetUser) {
            Object.assign(targetUser, profileUpdates);
        }
    }
    
    response.json({ 
        success: true, 
        message: 'Profile updated successfully' 
    });
});

application.post('/api/mood', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { mood, note } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('moods').insertOne({ 
            userId: sessionRecord.userId, 
            mood, 
            note, 
            date: new Date().toISOString().split('T')[0], 
            createdAt: new Date() 
        });
    }
    
    response.json({ success: true });
});

application.get('/api/mood', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let moodEntries = [];
    
    if (databaseInstance) {
        moodEntries = await databaseInstance.collection('moods')
            .find({ userId: sessionRecord.userId })
            .sort({ createdAt: -1 })
            .limit(30)
            .toArray();
    }
    
    response.json({ 
        success: true, 
        moods: moodEntries 
    });
});

application.post('/api/journal', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { title, content } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('journals').insertOne({ 
            userId: sessionRecord.userId, 
            title, 
            content, 
            createdAt: new Date() 
        });
    }
    
    response.json({ success: true });
});

application.get('/api/journal', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let journalEntries = [];
    
    if (databaseInstance) {
        journalEntries = await databaseInstance.collection('journals')
            .find({ userId: sessionRecord.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
    }
    
    response.json({ 
        success: true, 
        entries: journalEntries 
    });
});

application.post('/api/chat', async (request, response) => {
    const { message, language = 'en' } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    let userContextData = '';
    
    if (authToken) {
        let sessionRecord, userRecord;
        
        if (databaseInstance) {
            sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
            if (sessionRecord) {
                userRecord = await databaseInstance.collection('users').findOne({ 
                    _id: new ObjectId(sessionRecord.userId) 
                });
            }
        } else {
            sessionRecord = memoryStorage.sessions.get(authToken);
            if (sessionRecord) {
                const users = Array.from(memoryStorage.users.values());
                userRecord = users.find(user => user._id === sessionRecord.userId);
            }
        }
        
        if (userRecord) {
            const userAge = userRecord.age || 'Not specified';
            const userGender = userRecord.gender || 'Not specified';
            const userName = userRecord.name || 'User';
            
            userContextData = `
User Details:
- Name: ${userName}
- Age: ${userAge}
- Gender: ${userGender}
- Email: ${userRecord.email || 'Not specified'}
${languagePrompts[language] || languagePrompts.en}

`;
            
            if (databaseInstance && sessionRecord) {
                const medicationList = await databaseInstance.collection('medications')
                    .find({ userId: sessionRecord.userId, active: true })
                    .toArray();
                
                if (medicationList.length > 0) {
                    const formattedMeds = medicationList.map(med => 
                        `${med.name} (${med.dosage}) - ${med.frequency} at ${med.time}`
                    ).join(', ');
                    userContextData += `Current Medications: ${formattedMeds}\n`;
                }
                
                const moodEntries = await databaseInstance.collection('moods')
                    .find({ userId: sessionRecord.userId })
                    .sort({ createdAt: -1 })
                    .limit(7)
                    .toArray();
                
                if (moodEntries.length > 0) {
                    const moodEmojiMap = { 
                        great: '😄', 
                        good: '😊', 
                        okay: '😐', 
                        bad: '😔', 
                        terrible: '😢' 
                    };
                    const recentMoodsFormatted = moodEntries
                        .map(entry => `${moodEmojiMap[entry.mood]}`)
                        .join(', ');
                    userContextData += `Recent mood trends: ${recentMoodsFormatted} (most recent to oldest)\n`;
                }
                
                const clinicReports = await databaseInstance.collection('clinic_reports')
                    .find({ userId: sessionRecord.userId })
                    .sort({ date: -1 })
                    .limit(5)
                    .toArray();
                
                if (clinicReports.length > 0) {
                    const reportTypeLabels = {
                        blood_test: 'Blood Test',
                        urine_test: 'Urine Test',
                        xray: 'X-Ray',
                        mri: 'MRI Scan',
                        ct_scan: 'CT Scan',
                        ecg: 'ECG',
                        other: 'Other'
                    };
                    const reportInfoFormatted = clinicReports
                        .map(report => `${reportTypeLabels[report.type] || report.type}: ${report.findings || 'Normal'}`)
                        .join(', ');
                    userContextData += `Recent medical reports: ${reportInfoFormatted}\n`;
                }
                
                const routineItems = await databaseInstance.collection('routines')
                    .find({ userId: sessionRecord.userId })
                    .toArray();
                
                if (routineItems.length > 0) {
                    const routineInfoFormatted = routineItems
                        .map(item => `${item.name} at ${item.time}`)
                        .join(', ');
                    userContextData += `Daily routine: ${routineInfoFormatted}\n`;
                }
            }
        }
    } else {
        userContextData = languagePrompts[language] || languagePrompts.en;
    }
    
    if (!message?.trim()) {
        return response.status(400).json({ 
            error: 'Message cannot be empty' 
        });
    }

    if (containsCrisisContent(message)) {
        if (databaseInstance && sessionRecord) {
            await databaseInstance.collection('moods').insertOne({
                userId: sessionRecord.userId,
                mood: 'terrible',
                note: 'Crisis indicators detected in conversation',
                source: 'ai_detection',
                createdAt: new Date()
            });
        }
        
        return response.json({
            response: crisisSupportMessage,
            is_crisis: true,
            crisis_resources: [
                { name: 'iCall', phone: '9152987821' }, 
                { name: 'Vandrevala', phone: '1860 2662 345' }, 
                { name: 'Emergency', phone: '112' }
            ]
        });
    }

    try {
        const aiResponse = await generateAIResponse(message, userContextData);
        
        if (databaseInstance && sessionRecord) {
            const detectedMood = detectMoodFromText(message);
            if (detectedMood) {
                await databaseInstance.collection('moods').insertOne({
                    userId: sessionRecord.userId,
                    mood: detectedMood,
                    note: 'AI detected from conversation',
                    source: 'ai_analysis',
                    createdAt: new Date()
                });
            }
        }
        
        response.json({ 
            response: aiResponse, 
            is_crisis: false 
        });
    } catch (error) {
        response.json({ 
            response: "I'm here for you. How are you feeling?", 
            is_crisis: false 
        });
    }
});

application.post('/api/chat/save', async (request, response) => {
    const { message, response: aiResponse } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ 
            success: false, 
            message: 'Authentication required' 
        });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ 
            success: false, 
            message: 'Invalid session' 
        });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('chats').insertOne({
            userId: sessionRecord.userId,
            message,
            response: aiResponse,
            createdAt: new Date()
        });
    }
    
    response.json({ success: true });
});

application.get('/api/chat/history', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ 
            success: false, 
            message: 'Authentication required' 
        });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ 
            success: false, 
            message: 'Invalid session' 
        });
    }
    
    let chatHistory = [];
    
    if (databaseInstance) {
        chatHistory = await databaseInstance.collection('chats')
            .find({ userId: sessionRecord.userId })
            .sort({ createdAt: 1 })
            .limit(100)
            .toArray();
    }
    
    response.json({ 
        success: true, 
        chats: chatHistory 
    });
});

application.post('/api/clinic/report', async (request, response) => {
    const { title, type, date, notes } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('clinic_reports').insertOne({
            userId: sessionRecord.userId,
            title,
            type,
            date,
            notes,
            createdAt: new Date()
        });
    }
    
    response.json({ success: true });
});

application.get('/api/clinic/reports', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let clinicReports = [];
    
    if (databaseInstance) {
        clinicReports = await databaseInstance.collection('clinic_reports')
            .find({ userId: sessionRecord.userId })
            .sort({ date: -1 })
            .toArray();
    }
    
    response.json({ 
        success: true, 
        reports: clinicReports 
    });
});

application.post('/api/medications', async (request, response) => {
    const { name, dosage, frequency, time, notes } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('medications').insertOne({
            userId: sessionRecord.userId,
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
    
    response.json({ success: true });
});

application.get('/api/medications', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let medicationList = [];
    
    if (databaseInstance) {
        medicationList = await databaseInstance.collection('medications')
            .find({ userId: sessionRecord.userId, active: true })
            .toArray();
    }
    
    response.json({ 
        success: true, 
        medications: medicationList 
    });
});

application.delete('/api/medications/:id', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('medications').deleteOne({ 
            _id: new ObjectId(request.params.id) 
        });
    }
    
    response.json({ success: true });
});

application.post('/api/medications/:id/take', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('medications').updateOne(
            { _id: new ObjectId(request.params.id) },
            { $set: { lastTaken: new Date() } }
        );
    }
    
    response.json({ success: true });
});

application.post('/api/routine', async (request, response) => {
    const { title, time, days, enabled } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('routines').insertOne({
            userId: sessionRecord.userId,
            title,
            time,
            days,
            enabled: enabled !== false,
            createdAt: new Date()
        });
    }
    
    response.json({ success: true });
});

application.get('/api/routine', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let routineItems = [];
    
    if (databaseInstance) {
        routineItems = await databaseInstance.collection('routines')
            .find({ userId: sessionRecord.userId })
            .toArray();
    }
    
    response.json({ 
        success: true, 
        routines: routineItems 
    });
});

application.put('/api/routine/:id', async (request, response) => {
    const { enabled } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('routines').updateOne(
            { _id: new ObjectId(request.params.id) }, 
            { $set: { enabled } }
        );
    }
    
    response.json({ success: true });
});

application.delete('/api/routine/:id', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('routines').deleteOne({ 
            _id: new ObjectId(request.params.id) 
        });
    }
    
    response.json({ success: true });
});

application.get('/api/notifications', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let notificationList = [];
    let unreadCount = 0;
    
    if (databaseInstance) {
        notificationList = await databaseInstance.collection('notifications')
            .find({ userId: sessionRecord.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
            
        unreadCount = await databaseInstance.collection('notifications')
            .countDocuments({ 
                userId: sessionRecord.userId, 
                read: false 
            });
    }
    
    response.json({ 
        success: true, 
        notifications: notificationList, 
        unreadCount 
    });
});

application.post('/api/notifications/read', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { notificationId } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (databaseInstance) {
        if (notificationId) {
            await databaseInstance.collection('notifications').updateOne(
                { _id: new ObjectId(notificationId) },
                { $set: { read: true, readAt: new Date() } }
            );
        } else {
            await databaseInstance.collection('notifications').updateMany(
                { userId: sessionRecord.userId, read: false },
                { $set: { read: true, readAt: new Date() } }
            );
        }
    }
    
    response.json({ success: true });
});

application.post('/api/notifications/create', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { type, title, message, sendEmail } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord, userRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
        if (sessionRecord) {
            userRecord = await databaseInstance.collection('users').findOne({ 
                _id: new ObjectId(sessionRecord.userId) 
            });
        }
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
        if (sessionRecord) {
            const users = Array.from(memoryStorage.users.values());
            userRecord = users.find(user => user._id === sessionRecord.userId);
        }
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    const newNotification = {
        userId: sessionRecord.userId,
        type: type || 'reminder',
        title: title,
        message: message,
        read: false,
        emailSent: false,
        createdAt: new Date()
    };
    
    if (sendEmail && emailTransporter && userRecord?.email) {
        const emailContent = {
            from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
            to: userRecord.email,
            subject: `🔔 NeuralCare: ${title}`,
            html: `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        h2 { color: #6366f1; }
        .footer { color: #666; font-size: 12px; margin-top: 20px; }
    </style>
</head>
<body>
    <h2>NeuralCare Reminder</h2>
    <h3>${title}</h3>
    <p>${message}</p>
    <hr>
    <p class="footer">This is an automated reminder from NeuralCare. Stay healthy! 💚</p>
</body>
</html>`
        };
        
        try {
            await emailTransporter.sendMail(emailContent);
            newNotification.emailSent = true;
        } catch (error) {}
    }
    
    if (databaseInstance) {
        await databaseInstance.collection('notifications').insertOne(newNotification);
    }
    
    response.json({ 
        success: true, 
        emailSent: newNotification.emailSent 
    });
});

application.post('/api/notifications/send-email', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { type, message } = request.body;
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord, userRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
        if (sessionRecord) {
            userRecord = await databaseInstance.collection('users').findOne({ 
                _id: new ObjectId(sessionRecord.userId) 
            });
        }
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
        if (sessionRecord) {
            const users = Array.from(memoryStorage.users.values());
            userRecord = users.find(user => user._id === sessionRecord.userId);
        }
    }
    
    if (!userRecord) {
        return response.status(401).json({ success: false });
    }
    
    if (emailTransporter && userRecord.email) {
        const emailContent = {
            from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
            to: userRecord.email,
            subject: `🔔 NeuralCare Reminder: ${type}`,
            text: message,
            html: `<h2>NeuralCare Reminder</h2><p>${message}</p>`
        };
        
        try {
            await emailTransporter.sendMail(emailContent);
        } catch (error) {}
    }
    
    response.json({ success: true });
});

application.post('/api/user/api-key', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    response.json({ 
        success: true, 
        apiKey: process.env.MASTER_API_KEY,
        instructions: 'Use this API key with your user token to access the API'
    });
});

application.get('/api/user/api-key', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    if (!authToken) {
        return response.status(401).json({ success: false });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(authToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ success: false });
    }
    
    let userRecord;
    
    if (databaseInstance) {
        userRecord = await databaseInstance.collection('users').findOne({ 
            _id: new ObjectId(sessionRecord.userId) 
        });
    } else {
        const users = Array.from(memoryStorage.users.values());
        userRecord = users.find(user => user._id === sessionRecord.userId);
    }
    
    response.json({ 
        success: true, 
        apiKey: process.env.MASTER_API_KEY,
        instructions: 'Use this API key with your user token to access the API'
    });
});

application.post('/api/public/chat', async (request, response) => {
    const { message, apiKey, userToken } = request.body;
    
    if (!apiKey || apiKey !== process.env.MASTER_API_KEY) {
        return response.status(401).json({ 
            error: 'Invalid or missing API key' 
        });
    }
    
    if (!userToken) {
        return response.status(401).json({ 
            error: 'User token is required' 
        });
    }
    
    let sessionRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: userToken });
    } else {
        sessionRecord = memoryStorage.sessions.get(userToken);
    }
    
    if (!sessionRecord) {
        return response.status(401).json({ 
            error: 'Invalid user session' 
        });
    }
    
    let userRecord;
    
    if (databaseInstance) {
        userRecord = await databaseInstance.collection('users').findOne({ 
            _id: new ObjectId(sessionRecord.userId) 
        });
    } else {
        const users = Array.from(memoryStorage.users.values());
        userRecord = users.find(user => user._id === sessionRecord.userId);
    }
    
    if (!userRecord) {
        return response.status(404).json({ 
            error: 'User record not found' 
        });
    }
    
    const userContextForAI = `User: ${userRecord.name || 'User'}, Age: ${userRecord.age || 'N/A'}, Gender: ${userRecord.gender || 'N/A'}\n\nUser's message: ${message}`;

    if (containsCrisisContent(message)) {
        return response.json({
            response: crisisSupportMessage,
            is_crisis: true,
            crisis_resources: [
                { name: 'iCall', phone: '9152987821' }, 
                { name: 'Vandrevala', phone: '1860 2662 345' }, 
                { name: 'Emergency', phone: '112' }
            ]
        });
    }

    try {
        const aiResponse = await generateAIResponse(userContextForAI);
        response.json({ 
            response: aiResponse, 
            is_crisis: false 
        });
    } catch (error) {
        response.json({ 
            response: "Hey buddy! What's up? 😄", 
            is_crisis: false 
        });
    }
});

application.get('*', (request, response) => {
    if (request.path === '/' || request.path === '/index.html') {
        response.sendFile(path.join(__dirname, 'public', 'landing.html'));
    } else {
        response.sendFile(
            path.join(__dirname, 'public', request.path) || 
            path.join(__dirname, 'public', 'index.html')
        );
    }
});

initializeDatabase().then(() => {
    application.listen(PORT, HOST, () => {
        const os = require('os');
        const networkAdapters = os.networkInterfaces();
        let localIP = 'localhost';
        
        for (const interfaceName of Object.keys(networkAdapters)) {
            for (const networkInterface of networkAdapters[interfaceName]) {
                if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
                    localIP = networkInterface.address;
                    break;
                }
            }
        }
        
        console.log('');
        console.log('╔═══════════════════════════════════════════════════════════════╗');
        console.log('║         NEURAL CARE - Mental Health Support                 ║');
        console.log('╠═══════════════════════════════════════════════════════════════╣');
        console.log(`║  🌐 Local:    http://localhost:${PORT}                            ║`);
        console.log(`║  📱 Network:  http://${localIP}:${PORT}                      ║`);
        console.log('║  🤖 AI:       neuralcare (Ollama)                         ║');
        console.log(`║  💾 Database: ${databaseInstance ? 'MongoDB' : 'In-Memory'}                                    ║`);
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('To access from other devices, use the Network URL above');
    });
});