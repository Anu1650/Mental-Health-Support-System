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

// ==================== MONGODB CONNECTION ====================
const initializeDatabase = async () => {
    const mongoConnectionString = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    if (!mongoConnectionString) {
        console.log('⚠️ Using in-memory storage system');
        return null;
    }
    
    try {
        const { MongoClient } = require('mongodb');
        const mongoConnection = new MongoClient(mongoConnectionString);
        await mongoConnection.connect();
        databaseInstance = mongoConnection.db();
        
        // Create indexes
        await databaseInstance.collection('users').createIndex({ email: 1 }, { unique: true });
        
        try {
            await databaseInstance.collection('otps').dropIndex('email_1');
        } catch (e) {}
        await databaseInstance.collection('otps').createIndex(
            { email: 1 }, 
            { expireAfterSeconds: 1800 }
        );
        
        try {
            await databaseInstance.collection('sessions').dropIndex('token_1');
        } catch (e) {}
        await databaseInstance.collection('sessions').createIndex(
            { token: 1 }, 
            { expireAfterSeconds: 86400 }
        );
        
        console.log('✅ MongoDB Connected Successfully');
        return databaseInstance;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return null;
    }
};

// ==================== HELPER FUNCTIONS ====================
const crisisIndicators = ['suicide', 'kill myself', 'want to die', 'end it all', 'self harm', 'hurt myself', 'cut myself', 'end my life'];
const crisisSupportMessage = `I'm concerned about you. Please reach out now:\n\n📞 **iCall**: 9152987821\n📞 **Vandrevala**: 1860 2662 345\n📞 **Emergency**: 112\n\nThese helplines are available 24/7. You're not alone.`;

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

// ==================== EMAIL CONFIGURATION ====================
const nodemailer = require('nodemailer');
let emailTransporter = null;

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
            console.log('⚠️ Email service unavailable:', error.message);
        } else {
            console.log('✅ Email service ready');
        }
    });
}

// Send OTP Email
const deliverOTPByEmail = async (recipientEmail, otpCode) => {
    const emailContent = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: recipientEmail,
        subject: '🔐 Your NeuralCare Verification Code',
        html: `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Inter', Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 25px; }
        .logo { font-size: 48px; margin-bottom: 10px; }
        h1 { color: #6366f1; font-size: 28px; margin: 0; }
        .otp-box { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; font-size: 42px; font-weight: 700; letter-spacing: 8px; text-align: center; padding: 20px; border-radius: 12px; margin: 25px 0; }
        .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🧠</div>
            <h1>NeuralCare</h1>
        </div>
        <p style="color: #4b5563; text-align: center;">Your verification code is:</p>
        <div class="otp-box">${otpCode}</div>
        <p style="text-align: center; color: #6b7280;">Valid for <strong>30 minutes</strong></p>
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
            console.log(`📧 OTP email sent to ${recipientEmail}`);
            return true;
        } catch (error) {
            console.error('❌ Email delivery failed:', error.message);
        }
    } else {
        console.log(`📧 OTP for ${recipientEmail}: ${otpCode} (Email not configured)`);
    }
    return true;
};

// Send Login Notification Email
async function sendLoginNotification(email, userName, ipAddress = 'Unknown', deviceInfo = 'Unknown') {
    if (!emailTransporter) {
        console.log(`📧 Login notification would be sent to ${email} (Email not configured)`);
        return;
    }

    const mailOptions = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: email,
        subject: '🔐 New Login to Your NeuralCare Account',
        html: `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Inter', Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 25px; }
        .logo { font-size: 48px; margin-bottom: 10px; }
        h1 { color: #6366f1; font-size: 24px; margin: 0; }
        .content { color: #1f2937; line-height: 1.6; }
        .info-box { background: #f3f4f6; border-radius: 12px; padding: 20px; margin: 20px 0; }
        .info-item { margin-bottom: 15px; }
        .info-item .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
        .info-item .value { font-size: 16px; font-weight: 600; color: #1f2937; margin-top: 4px; }
        .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 12px; }
        .btn { display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🔐</div>
            <h1>NeuralCare</h1>
        </div>
        
        <div class="content">
            <h2>Hi ${userName},</h2>
            <p>We detected a new login to your NeuralCare account.</p>
            
            <div class="info-box">
                <div class="info-item">
                    <div class="label">Time</div>
                    <div class="value">${new Date().toLocaleString('en-US', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZoneName: 'short'
                    })}</div>
                </div>
                
                <div class="info-item">
                    <div class="label">IP Address</div>
                    <div class="value">${ipAddress}</div>
                </div>
                
                <div class="info-item">
                    <div class="label">Device</div>
                    <div class="value">${deviceInfo}</div>
                </div>
            </div>
            
            <div class="warning">
                <strong>⚠️ Not you?</strong>
                <p style="margin-top: 8px;">If you didn't login, please secure your account immediately:</p>
                <ol style="margin-top: 8px; padding-left: 20px;">
                    <li>Change your password</li>
                    <li>Contact support</li>
                </ol>
            </div>
            
            <a href="http://localhost:3000" class="btn">Go to Dashboard</a>
            
            <div class="footer">
                <p>This is an automated security notification from NeuralCare.</p>
                <p>© ${new Date().getFullYear()} NeuralCare. All rights reserved.</p>
            </div>
        </div>
    </div>
</body>
</html>`,
        text: `New login to your NeuralCare account at ${new Date().toLocaleString()}. IP: ${ipAddress}. If this wasn't you, please secure your account immediately.`
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`📧 Login notification sent to ${email}`);
    } catch (error) {
        console.error('❌ Failed to send login notification:', error.message);
    }
}

// ==================== AI CONFIGURATION ====================
// Fine-tuned API endpoint - Replace with your actual fine-tuned API
const FINETUNED_API_URL = process.env.FINETUNED_API_URL || 'http://localhost:5000/api/chat';
const FINETUNED_API_KEY = process.env.FINETUNED_API_KEY || '';

const systemPrompt = `You are NeuralCare - a warm, empathetic mental health companion. Your responses should be:
- Conversational and caring, like a supportive friend
- Use the user's name when you know it
- Keep responses concise but meaningful (2-4 sentences typically)
- Include relevant emojis naturally
- Show genuine empathy and understanding
- Ask gentle follow-up questions when appropriate
- Never be judgmental or dismissive
- If you don't understand something, ask for clarification kindly

Remember: You're here to support, not to diagnose or replace professional help.`;

const languagePrompts = {
    en: "Respond in English.",
    hi: "Respond in Hindi (हिंदी).",
    te: "Respond in Telugu (తెలుగు).",
    ta: "Respond in Tamil (தமிழ்).",
    bn: "Respond in Bengali (বাংলা)."
};

// Execute request with timeout
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

// Generate AI response using fine-tuned API first, then fallback
const generateAIResponse = async (userInput, contextData = '', language = 'en') => {
    const cleanedInput = userInput.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
    
    const fullPrompt = `${systemPrompt}

${languagePrompts[language] || languagePrompts.en}

User Context:
${contextData}

User: ${cleanedInput}

NeuralCare:`;

    // Try fine-tuned API first (highest priority)
    if (FINETUNED_API_URL) {
        try {
            console.log('🤖 Attempting fine-tuned API...');
            const response = await executeRequestWithTimeout(FINETUNED_API_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${FINETUNED_API_KEY}`
                },
                body: JSON.stringify({
                    prompt: fullPrompt,
                    temperature: 0.7,
                    max_tokens: 300,
                    language: language
                })
            }, 45000); // 45 second timeout for fine-tuned API
            
            const result = await response.json();
            
            if (response.ok && result.response) {
                console.log('✅ Fine-tuned API response received');
                return {
                    text: result.response.trim(),
                    source: 'fine-tuned'
                };
            }
        } catch (error) {
            console.log('⚠️ Fine-tuned API error:', error.message);
        }
    }

    // Try local Ollama models as fallback
    const modelEndpoints = [
        { name: 'neuralcare', url: 'http://localhost:11434/api/generate', timeout: 60000 },
        { name: 'llama3', url: 'http://localhost:11434/api/generate', timeout: 45000 },
        { name: 'mistral', url: 'http://localhost:11434/api/generate', timeout: 45000 }
    ];

    for (const model of modelEndpoints) {
        try {
            console.log(`🤖 Trying ${model.name} model...`);
            const response = await executeRequestWithTimeout(model.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model.name,
                    prompt: fullPrompt,
                    stream: false,
                    options: { 
                        temperature: 0.7, 
                        top_p: 0.9, 
                        num_ctx: 4096, 
                        num_predict: 500
                    }
                })
            }, model.timeout);
            
            const result = await response.json();
            
            if (response.ok && result.response && result.response.trim()) {
                console.log(`✅ ${model.name} response received`);
                return {
                    text: result.response.trim(),
                    source: model.name
                };
            }
        } catch (error) {
            console.log(`⚠️ ${model.name} error:`, error.message);
        }
    }
    
    // Try OpenRouter as last resort
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (openRouterApiKey) {
        try {
            console.log('🤖 Trying OpenRouter API...');
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
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: cleanedInput }
                    ],
                    temperature: 0.7,
                    max_tokens: 300
                })
            }, 30000);
            
            const result = await response.json();
            
            if (response.ok && result.choices && result.choices[0]?.message?.content) {
                console.log('✅ OpenRouter response received');
                return {
                    text: result.choices[0].message.content.trim(),
                    source: 'openrouter'
                };
            }
        } catch (error) {
            console.log('⚠️ OpenRouter error:', error.message);
        }
    }
    
    // Ultimate fallback responses
    console.log('⚠️ Using fallback responses');
    const fallbackResponses = [
        "I'm here with you. How are you feeling right now? 💭",
        "Tell me more about what's on your mind. I'm listening. 👂",
        "That sounds challenging. Would you like to talk about it? 💙",
        "I hear you. How can I support you best right now? 🤗",
        "Thank you for sharing that with me. What else is on your heart? 🌱"
    ];
    
    return {
        text: fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)],
        source: 'fallback'
    };
};

// Detect mood from message
const detectMoodFromText = (messageContent) => {
    const text = messageContent.toLowerCase();
    
    if (text.includes('happy') || text.includes('great') || text.includes('wonderful') || text.includes('amazing') || text.includes('love') || text.includes('excited') || text.includes('joy') || text.includes('grateful')) {
        return 'great';
    }
    
    if (text.includes('good') || text.includes('nice') || text.includes('fine') || text.includes('better') || text.includes('relaxed') || text.includes('calm') || text.includes('peaceful')) {
        return 'good';
    }
    
    if (text.includes('okay') || text.includes('normal') || text.includes('average') || text.includes('usual')) {
        return 'okay';
    }
    
    if (text.includes('sad') || text.includes('down') || text.includes('depressed') || text.includes('unhappy') || text.includes('disappointed') || text.includes('hurt') || text.includes('lonely')) {
        return 'bad';
    }
    
    if (text.includes('anxious') || text.includes('worried') || text.includes('stressed') || text.includes('overwhelmed') || text.includes('panic') || text.includes('scared') || text.includes('afraid') || text.includes('terrible') || text.includes('hopeless')) {
        return 'terrible';
    }
    
    return null;
};

// ==================== API ROUTES ====================

// Health check
application.get('/api/health', (request, response) => {
    response.json({ 
        status: 'operational', 
        service: 'NeuralCare', 
        version: '2.0.0', 
        database: databaseInstance ? 'Connected' : 'In-Memory',
        ai: {
            finetuned: FINETUNED_API_URL ? 'Configured' : 'Not configured',
            local: 'Available',
            fallback: 'Ready'
        }
    });
});

// Send OTP
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

// Login with email and password
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
    
    // Get IP and device info for notification
    const clientIp = request.ip || request.connection.remoteAddress || 'Unknown';
    const userAgent = request.headers['user-agent'] || 'Unknown';
    
    // Send login notification email (don't await - let it run in background)
    sendLoginNotification(
        normalizedEmail, 
        userRecord.name || userRecord.email.split('@')[0],
        clientIp,
        userAgent
    ).catch(err => console.log('Background email error:', err.message));
    
    console.log(`✅ User logged in: ${normalizedEmail} from ${clientIp}`);
    
    response.json({ 
        success: true, 
        message: 'Login successful', 
        user: { 
            id: userRecord._id.toString(), 
            email: userRecord.email, 
            name: userRecord.name,
            phone: userRecord.phone || '',
            age: userRecord.age || '',
            gender: userRecord.gender || '',
            address: userRecord.address || ''
        }, 
        token: sessionToken 
    });
});

// Forgot Password - Send OTP
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

// Reset Password
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

// Verify OTP and create account
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

// Logout
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

// Get current user
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

// Update profile
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

// ==================== CHAT ENDPOINT WITH INDICATORS ====================
application.post('/api/chat', async (request, response) => {
    const { message, language = 'en' } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    // Set headers for server-sent events if client wants streaming
    const acceptStreaming = request.headers.accept === 'text/event-stream';
    
    if (acceptStreaming) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
    }
    
    // Function to send progress updates
    const sendProgress = (stage, message) => {
        if (acceptStreaming) {
            response.write(`data: ${JSON.stringify({ type: 'progress', stage, message })}\n\n`);
        }
    };
    
    sendProgress('start', 'Processing your message...');
    
    let userContextData = '';
    let userRecord = null;
    let sessionRecord = null;
    
    // Get user context if authenticated
    if (authToken) {
        sendProgress('auth', 'Fetching your data...');
        
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
`;
            
            sendProgress('context', 'Loading your personal context...');
            
            // Get medications
            if (databaseInstance && sessionRecord) {
                const medicationList = await databaseInstance.collection('medications')
                    .find({ userId: sessionRecord.userId, active: true })
                    .toArray();
                
                if (medicationList.length > 0) {
                    const formattedMeds = medicationList.map(med => 
                        `${med.name} (${med.dosage})`
                    ).join(', ');
                    userContextData += `\nCurrent Medications: ${formattedMeds}`;
                }
                
                // Get recent moods
                const moodEntries = await databaseInstance.collection('moods')
                    .find({ userId: sessionRecord.userId })
                    .sort({ createdAt: -1 })
                    .limit(3)
                    .toArray();
                
                if (moodEntries.length > 0) {
                    const moodEmojiMap = { 
                        great: '😄', good: '😊', okay: '😐', bad: '😔', terrible: '😢' 
                    };
                    const recentMoods = moodEntries
                        .map(entry => `${moodEmojiMap[entry.mood] || '😐'}`)
                        .join(' ');
                    userContextData += `\nRecent mood: ${recentMoods}`;
                }
            }
        }
    }
    
    // Check for crisis content
    if (containsCrisisContent(message)) {
        sendProgress('crisis', 'Detected crisis keywords - providing support resources...');
        
        if (databaseInstance && sessionRecord) {
            await databaseInstance.collection('moods').insertOne({
                userId: sessionRecord.userId,
                mood: 'terrible',
                note: 'Crisis indicators detected in conversation',
                source: 'ai_detection',
                createdAt: new Date()
            });
        }
        
        const crisisResponse = {
            response: crisisSupportMessage,
            is_crisis: true,
            crisis_resources: [
                { name: 'iCall', phone: '9152987821' }, 
                { name: 'Vandrevala', phone: '1860 2662 345' }, 
                { name: 'Emergency', phone: '112' }
            ]
        };
        
        if (acceptStreaming) {
            response.write(`data: ${JSON.stringify({ type: 'result', ...crisisResponse })}\n\n`);
            response.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            response.end();
        } else {
            response.json(crisisResponse);
        }
        return;
    }
    
    if (!message?.trim()) {
        return response.status(400).json({ 
            error: 'Message cannot be empty' 
        });
    }

    try {
        sendProgress('ai', 'Consulting NeuralCare AI...');
        
        // Get AI response with source tracking
        const aiResult = await generateAIResponse(message, userContextData, language);
        
        sendProgress('processing', 'Processing response...');
        
        // Save mood if detected
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
        
        const responseData = { 
            response: aiResult.text, 
            is_crisis: false,
            source: aiResult.source,
            timestamp: new Date().toISOString()
        };
        
        if (acceptStreaming) {
            // Send the response in chunks for streaming
            const words = aiResult.text.split(' ');
            let chunk = '';
            
            for (const word of words) {
                chunk += word + ' ';
                if (chunk.length > 50) {
                    response.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
                    chunk = '';
                    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate typing
                }
            }
            if (chunk) {
                response.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
            }
            
            response.write(`data: ${JSON.stringify({ type: 'result', ...responseData })}\n\n`);
            response.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            response.end();
        } else {
            response.json(responseData);
        }
        
        console.log(`✅ Chat response sent (source: ${aiResult.source})`);
        
    } catch (error) {
        console.error('❌ Chat error:', error);
        
        const errorResponse = { 
            response: "I'm here with you. How are you feeling right now? 💭", 
            is_crisis: false,
            source: 'error-fallback'
        };
        
        if (acceptStreaming) {
            response.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong' })}\n\n`);
            response.write(`data: ${JSON.stringify({ type: 'result', ...errorResponse })}\n\n`);
            response.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            response.end();
        } else {
            response.json(errorResponse);
        }
    }
});

// Save chat history
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

// Get chat history
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
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
    }
    
    response.json({ 
        success: true, 
        chats: chatHistory.reverse() 
    });
});

// ==================== MOOD TRACKING ====================
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
            note: note || '',
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

// ==================== JOURNAL ====================
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
            title: title || 'Journal Entry',
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

// ==================== MEDICATIONS ====================
application.post('/api/medications', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { name, dosage, frequency, time, notes } = request.body;
    
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

// ==================== ROUTINES ====================
application.post('/api/routine', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { title, time, days, enabled } = request.body;
    
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

// ==================== CLINIC REPORTS ====================
application.post('/api/clinic/report', async (request, response) => {
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    const { title, type, date, notes } = request.body;
    
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
            date: new Date(date),
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

// ==================== NOTIFICATIONS ====================
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

// ==================== PUBLIC API ====================
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
        const aiResult = await generateAIResponse(userContextForAI);
        response.json({ 
            response: aiResult.text, 
            is_crisis: false,
            source: aiResult.source
        });
    } catch (error) {
        response.json({ 
            response: "I'm here for you. How are you feeling?", 
            is_crisis: false,
            source: 'error-fallback'
        });
    }
});

// Serve static files
application.get('*', (request, response) => {
    if (request.path === '/' || request.path === '/index.html') {
        response.sendFile(path.join(__dirname, 'public', 'landing.html'));
    } else {
        const filePath = path.join(__dirname, 'public', request.path);
        response.sendFile(filePath, (err) => {
            if (err) {
                response.sendFile(path.join(__dirname, 'public', 'index.html'));
            }
        });
    }
});

// ==================== START SERVER ====================
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
        console.log('║  🤖 AI:                                                      ║');
        console.log(`║     • Fine-tuned: ${FINETUNED_API_URL ? '✅ Configured' : '⚠️ Not configured'}         ║`);
        console.log('║     • Local:     ✅ Available (neuralcare, llama3, mistral)   ║');
        console.log('║     • Fallback:  ✅ Ready                                      ║');
        console.log(`║  💾 Database: ${databaseInstance ? '✅ MongoDB' : '⚠️ In-Memory'}                                    ║`);
        console.log(`║  📧 Email:    ${emailTransporter ? '✅ Configured' : '⚠️ Not configured'}                                ║`);
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('✨ Login notifications enabled - Users will receive emails on new logins');
        console.log('✨ Chat indicators active - Shows typing status and AI source');
    });
});