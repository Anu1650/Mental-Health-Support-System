const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const Razorpay = require('razorpay');
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
    patients: new Map(),
    doctors: new Map(),
    admins: new Map(),
    otps: new Map(),
    sessions: new Map(),
    medications: new Map(),
    moods: new Map(),
    journals: new Map(),
    routines: new Map(),
    clinicReports: new Map(),
    notifications: new Map(),
    chats: new Map(),
    payments: new Map(),
    appointments: new Map(),
    consultations: new Map(),
    aiConsultations: new Map(),
    transactions: new Map(),
    emailVerifications: new Map(),
    loginAttempts: new Map()
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
        
        // Create indexes for all collections
        await databaseInstance.collection('patients').createIndex({ email: 1 }, { unique: true });
        await databaseInstance.collection('doctors').createIndex({ email: 1 }, { unique: true });
        await databaseInstance.collection('doctors').createIndex({ transactionId: 1 });
        await databaseInstance.collection('admins').createIndex({ email: 1 }, { unique: true });
        
        // Email verification tracking
        await databaseInstance.collection('email_verifications').createIndex({ email: 1 });
        await databaseInstance.collection('email_verifications').createIndex({ otp: 1 });
        
        // OTP collection for forgot password
        await databaseInstance.collection('password_reset_otps').createIndex({ email: 1 });
        await databaseInstance.collection('password_reset_otps').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 }); // Auto-delete after 10 minutes
        
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
        
        // Create admin if not exists
        const adminExists = await databaseInstance.collection('admins').findOne({ email: process.env.ADMIN_EMAIL });
        if (!adminExists && process.env.ADMIN_EMAIL) {
            const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 10);
            await databaseInstance.collection('admins').insertOne({
                email: process.env.ADMIN_EMAIL,
                password: hashedPassword,
                name: 'Super Admin',
                role: 'super_admin',
                emailVerified: true,
                createdAt: new Date()
            });
            console.log('✅ Admin account created');
        } else if (!adminExists) {
            // Create default admin if no env vars
            const hashedPassword = await bcrypt.hash('Admin@123', 10);
            await databaseInstance.collection('admins').insertOne({
                email: 'admin@neuralcare.com',
                password: hashedPassword,
                name: 'Super Admin',
                role: 'super_admin',
                emailVerified: true,
                createdAt: new Date()
            });
            console.log('✅ Default admin account created (admin@neuralcare.com / Admin@123)');
        }
        
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

// Track login attempts
async function trackLoginAttempt(email, success = false) {
    const normalizedEmail = email.toLowerCase();
    const now = new Date();
    
    if (databaseInstance) {
        if (success) {
            // Clear attempts on successful login
            await databaseInstance.collection('login_attempts').deleteMany({ email: normalizedEmail });
        } else {
            // Add failed attempt
            await databaseInstance.collection('login_attempts').insertOne({
                email: normalizedEmail,
                createdAt: now
            });
        }
    } else {
        if (success) {
            memoryStorage.loginAttempts.delete(normalizedEmail);
        } else {
            const attempts = memoryStorage.loginAttempts.get(normalizedEmail) || [];
            attempts.push(now);
            memoryStorage.loginAttempts.set(normalizedEmail, attempts);
        }
    }
}

async function getLoginAttempts(email) {
    const normalizedEmail = email.toLowerCase();
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    if (databaseInstance) {
        const attempts = await databaseInstance.collection('login_attempts')
            .find({ 
                email: normalizedEmail,
                createdAt: { $gt: oneHourAgo }
            })
            .toArray();
        return attempts.length;
    } else {
        const attempts = memoryStorage.loginAttempts.get(normalizedEmail) || [];
        const recentAttempts = attempts.filter(d => d > oneHourAgo);
        memoryStorage.loginAttempts.set(normalizedEmail, recentAttempts);
        return recentAttempts.length;
    }
}

// ==================== RAZORPAY INIT ====================
let razorpay = null;
try {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('✅ Razorpay configured');
} catch (error) {
    console.log('⚠️ Razorpay not configured:', error.message);
}

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

// Send Email
async function sendEmail(to, subject, html) {
    if (!emailTransporter) {
        console.log(`📧 Email would be sent to ${to}: ${subject}`);
        return false;
    }

    if (!to) {
        console.error('❌ Email failed: No recipients defined');
        return false;
    }

    const mailOptions = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to,
        subject,
        html
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`📧 Email sent to ${to}`);
        return true;
    } catch (error) {
        console.error('❌ Email failed:', error.message);
        return false;
    }
}

// Send OTP Email for Email Verification
const sendOTPEmail = async (recipientEmail, otpCode, purpose = 'verify') => {
    if (!recipientEmail) {
        console.error('❌ Email failed: No recipient email provided');
        return false;
    }

    const purposeText = purpose === 'verify' ? 'Email Verification' : 
                        purpose === 'reset' ? 'Password Reset' : 
                        purpose === 'login' ? 'Login Verification' : 'Verification';
    
    const emailContent = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: recipientEmail,
        subject: `🔐 NeuralCare - ${purposeText} OTP`,
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
        .purpose { background: #f3f4f6; padding: 10px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🧠</div>
            <h1>NeuralCare</h1>
        </div>
        <div class="purpose">
            <strong>${purposeText}</strong>
        </div>
        <p style="color: #4b5563; text-align: center;">Your OTP code is:</p>
        <div class="otp-box">${otpCode}</div>
        <p style="text-align: center; color: #6b7280;">Valid for <strong>10 minutes</strong></p>
        <p style="text-align: center; color: #6b7280;">Please do not share this OTP with anyone.</p>
        <div class="footer">
            <p>This code was requested for your NeuralCare account.</p>
            <p>If you didn't request this, please ignore this email.</p>
        </div>
    </div>
</body>
</html>`,
        text: `Your NeuralCare OTP for ${purposeText} is: ${otpCode}. Valid for 10 minutes.`
    };

    if (emailTransporter) {
        try {
            await emailTransporter.sendMail(emailContent);
            console.log(`📧 OTP email sent to ${recipientEmail} for ${purposeText}`);
            return true;
        } catch (error) {
            console.error('❌ Email delivery failed:', error.message);
            return false;
        }
    } else {
        console.log(`📧 OTP for ${recipientEmail}: ${otpCode} (Email not configured)`);
        return true;
    }
};

// Send Welcome Email (after verification)
const sendWelcomeEmail = async (recipientEmail, userName, role) => {
    const roleText = role === 'doctor' ? 'Doctor' : 'Patient';
    
    const emailContent = {
        from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
        to: recipientEmail,
        subject: `🎉 Welcome to NeuralCare, ${userName}!`,
        html: `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Inter', Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 25px; }
        .logo { font-size: 48px; margin-bottom: 10px; }
        h1 { color: #6366f1; font-size: 28px; margin: 0; }
        .welcome-box { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 30px; border-radius: 12px; margin: 25px 0; text-align: center; }
        .features { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 30px 0; }
        .feature { background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center; }
        .btn { background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px; }
        .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🧠</div>
            <h1>NeuralCare</h1>
        </div>
        
        <div class="welcome-box">
            <h2>Welcome, ${userName}!</h2>
            <p>Your ${roleText} account has been successfully created.</p>
        </div>

        ${role === 'doctor' ? `
            <p>Thank you for registering as a doctor. Your account is now pending admin verification. You will receive another email once your account is verified and activated.</p>
        ` : `
            <p>Your mental wellness journey starts here. You can now:</p>
            <div class="features">
                <div class="feature">💬 AI Chat Support</div>
                <div class="feature">😊 Mood Tracking</div>
                <div class="feature">📝 Journal</div>
                <div class="feature">📊 Self Assessment</div>
            </div>
        `}

        <div style="text-align: center;">
            <a href="http://localhost:3000/${role === 'doctor' ? 'doctor-dashboard.html' : 'dashboard.html'}" class="btn">Go to Dashboard</a>
        </div>

        <div class="footer">
            <p>© ${new Date().getFullYear()} NeuralCare. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`
    };

    if (emailTransporter) {
        try {
            await emailTransporter.sendMail(emailContent);
            console.log(`📧 Welcome email sent to ${recipientEmail}`);
            return true;
        } catch (error) {
            console.error('❌ Welcome email failed:', error.message);
            return false;
        }
    }
    return true;
};

// Send Login Notification Email
async function sendLoginNotification(email, userName, ipAddress = 'Unknown', deviceInfo = 'Unknown', role = 'patient') {
    if (!emailTransporter || !email) {
        console.log(`📧 Login notification would be sent to ${email} (Email not configured)`);
        return;
    }

    const dashboardLink = role === 'doctor' ? 'doctor-dashboard.html' : role === 'admin' ? 'admin-dashboard.html' : 'dashboard.html';

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
        .badge { background: ${role === 'doctor' ? '#10b981' : role === 'admin' ? '#ef4444' : '#6366f1'}; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; display: inline-block; margin-top: 10px; }
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
            <div class="badge">${role.toUpperCase()}</div>
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
                    <li>Contact support at support@neuralcare.com</li>
                </ol>
            </div>
            
            <a href="http://localhost:3000/${dashboardLink}" class="btn">Go to Dashboard</a>
            
            <div class="footer">
                <p>This is an automated security notification from NeuralCare.</p>
                <p>© ${new Date().getFullYear()} NeuralCare. All rights reserved.</p>
            </div>
        </div>
    </div>
</body>
</html>`,
        text: `New login to your NeuralCare account at ${new Date().toLocaleString()}. IP: ${ipAddress}. Role: ${role}. If this wasn't you, please secure your account immediately.`
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`📧 Login notification sent to ${email}`);
    } catch (error) {
        console.error('❌ Failed to send login notification:', error.message);
    }
}

// ==================== AUTHENTICATION MIDDLEWARE ====================
async function authenticateUser(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    let session;
    if (databaseInstance) {
        session = await databaseInstance.collection('sessions').findOne({ token });
    } else {
        session = memoryStorage.sessions.get(token);
    }

    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    req.userId = session.userId;
    req.userRole = session.role;
    next();
}

async function authenticateDoctor(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    let session;
    if (databaseInstance) {
        session = await databaseInstance.collection('sessions').findOne({ token });
    } else {
        session = memoryStorage.sessions.get(token);
    }

    if (!session || session.role !== 'doctor') {
        return res.status(403).json({ success: false, message: 'Access denied. Doctors only.' });
    }

    // Check if doctor has paid subscription
    let doctor;
    if (databaseInstance) {
        doctor = await databaseInstance.collection('doctors').findOne({ 
            _id: new ObjectId(session.userId) 
        });
    } else {
        doctor = Array.from(memoryStorage.doctors.values()).find(d => d._id === session.userId);
    }

    if (!doctor || !doctor.subscriptionPaid) {
        return res.status(403).json({ 
            success: false, 
            message: 'Subscription required',
            requiresPayment: true,
            fee: doctor?.subscriptionFee || 1999
        });
    }

    req.doctorId = session.userId;
    req.doctor = doctor;
    next();
}

async function authenticateAdmin(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    let session;
    if (databaseInstance) {
        session = await databaseInstance.collection('sessions').findOne({ token });
    } else {
        session = memoryStorage.sessions.get(token);
    }

    if (!session || session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
    }

    req.adminId = session.userId;
    next();
}

// ==================== AI CONFIGURATION ====================
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
- If symptoms seem severe, suggest consulting a doctor
- Remember: You're here to support, not to replace professional help`;

const languagePrompts = {
    en: "Respond in English.",
    hi: "Respond in Hindi (हिंदी).",
    te: "Respond in Telugu (తెలుగు).",
    ta: "Respond in Tamil (தமிழ்).",
    bn: "Respond in Bengali (বাংলা)."
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

const generateAIResponse = async (userInput, contextData = '', language = 'en') => {
    const cleanedInput = userInput.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<img.*?>/g, '').trim();
    
    const fullPrompt = `${systemPrompt}

${languagePrompts[language] || languagePrompts.en}

User Context:
${contextData}

User: ${cleanedInput}

NeuralCare:`;

    // Try fine-tuned API first
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
            }, 45000);
            
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

    // Try local Ollama models
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
    
    // Try OpenRouter
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
    
    // Fallback responses
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

// AI Symptom Analysis
async function analyzeSymptoms(message, symptoms, duration) {
    const text = (message + ' ' + (symptoms || '')).toLowerCase();
    
    // Detect severity
    let severity = 'low';
    const severeKeywords = ['severe', 'extreme', 'unbearable', 'can\'t take', 'emergency', 'suicide', 'kill', 'end it'];
    const mediumKeywords = ['moderate', 'difficult', 'hard', 'struggling', 'bad', 'worse'];
    
    if (severeKeywords.some(k => text.includes(k))) {
        severity = 'high';
    } else if (mediumKeywords.some(k => text.includes(k))) {
        severity = 'medium';
    }
    
    // Detect specialization
    let specialization = 'General Practitioner';
    const specializationMap = {
        'anxiety': 'Psychiatrist',
        'panic': 'Psychiatrist',
        'depress': 'Psychologist',
        'sad': 'Psychologist',
        'sleep': 'Sleep Specialist',
        'insomnia': 'Sleep Specialist',
        'stress': 'Counselor',
        'work': 'Counselor',
        'trauma': 'Trauma Therapist',
        'abuse': 'Trauma Therapist',
        'addict': 'Addiction Specialist',
        'alcohol': 'Addiction Specialist',
        'eating': 'Nutritionist',
        'weight': 'Nutritionist'
    };
    
    for (const [keyword, spec] of Object.entries(specializationMap)) {
        if (text.includes(keyword)) {
            specialization = spec;
            break;
        }
    }
    
    return {
        severity,
        specialization,
        recommendation: severity === 'high' 
            ? 'Please consult a specialist immediately. Your symptoms require professional attention.'
            : severity === 'medium'
            ? 'Consider booking a consultation with a specialist. AI therapy can help in the meantime.'
            : 'Continue with AI therapy and track your symptoms. Reach out if they worsen.',
        suggestedDoctors: severity === 'high' ? 5 : severity === 'medium' ? 3 : 1,
        timestamp: new Date()
    };
}

// ==================== EMAIL VERIFICATION ROUTES ====================

// Send OTP for email verification
application.post('/api/auth/send-verification-otp', async (request, response) => {
    const { email } = request.body;
    
    if (!email || !email.includes('@')) {
        return response.status(400).json({ 
            success: false, 
            message: 'A valid email address is required' 
        });
    }

    const normalizedEmail = email.toLowerCase();
    const otpCode = generateSecureOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    try {
        // Store OTP in database
        if (databaseInstance) {
            // Delete any existing OTPs for this email
            await databaseInstance.collection('otps').deleteMany({ email: normalizedEmail });
            
            // Insert new OTP
            await databaseInstance.collection('otps').insertOne({
                email: normalizedEmail,
                otp: otpCode,
                purpose: 'email_verification',
                expiresAt: expiresAt,
                attempts: 0,
                createdAt: new Date()
            });
        } else {
            memoryStorage.otps.set(normalizedEmail, {
                otp: otpCode,
                purpose: 'email_verification',
                expiresAt: expiresAt,
                attempts: 0,
                createdAt: Date.now()
            });
        }

        // Send OTP email
        await sendOTPEmail(normalizedEmail, otpCode, 'verify');

        const isDevelopment = process.env.NODE_ENV !== 'production';
        response.json({ 
            success: true, 
            message: isDevelopment ? `OTP sent (check server console): ${otpCode}` : 'OTP sent to your email',
            devOTP: isDevelopment ? otpCode : undefined
        });

    } catch (error) {
        console.error('Error sending OTP:', error);
        response.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
});

// Verify OTP for email
application.post('/api/auth/verify-email-otp', async (request, response) => {
    const { email, otp } = request.body;

    if (!email || !otp) {
        return response.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const normalizedEmail = email.toLowerCase();

    try {
        let storedOTP;
        if (databaseInstance) {
            storedOTP = await databaseInstance.collection('otps').findOne({ 
                email: normalizedEmail,
                purpose: 'email_verification'
            });
        } else {
            storedOTP = memoryStorage.otps.get(normalizedEmail);
        }

        if (!storedOTP) {
            return response.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
        }

        // Check if OTP is expired
        const expiresAt = storedOTP.expiresAt?.getTime?.() || storedOTP.expiresAt;
        if (expiresAt && Date.now() > expiresAt) {
            if (databaseInstance) {
                await databaseInstance.collection('otps').deleteOne({ email: normalizedEmail });
            } else {
                memoryStorage.otps.delete(normalizedEmail);
            }
            return response.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
        }

        // Check if OTP matches
        if (storedOTP.otp !== String(otp)) {
            // Increment attempts
            if (databaseInstance) {
                await databaseInstance.collection('otps').updateOne(
                    { email: normalizedEmail },
                    { $inc: { attempts: 1 } }
                );
            } else {
                storedOTP.attempts = (storedOTP.attempts || 0) + 1;
            }

            // Check if too many attempts
            if ((storedOTP.attempts || 0) >= 5) {
                if (databaseInstance) {
                    await databaseInstance.collection('otps').deleteOne({ email: normalizedEmail });
                } else {
                    memoryStorage.otps.delete(normalizedEmail);
                }
                return response.status(400).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
            }

            return response.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        // OTP is valid - delete it
        if (databaseInstance) {
            await databaseInstance.collection('otps').deleteOne({ email: normalizedEmail });
        } else {
            memoryStorage.otps.delete(normalizedEmail);
        }

        // Mark email as verified in a temporary store (will be used during registration)
        if (databaseInstance) {
            await databaseInstance.collection('email_verifications').insertOne({
                email: normalizedEmail,
                verified: true,
                verifiedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes to complete registration
            });
        } else {
            memoryStorage.emailVerifications.set(normalizedEmail, {
                verified: true,
                verifiedAt: Date.now(),
                expiresAt: Date.now() + 30 * 60 * 1000
            });
        }

        response.json({ 
            success: true, 
            message: 'Email verified successfully' 
        });

    } catch (error) {
        console.error('Error verifying OTP:', error);
        response.status(500).json({ success: false, message: 'Failed to verify OTP' });
    }
});

// Check if email is verified
async function isEmailVerified(email) {
    const normalizedEmail = email.toLowerCase();

    if (databaseInstance) {
        const verification = await databaseInstance.collection('email_verifications').findOne({ 
            email: normalizedEmail,
            verified: true
        });
        
        if (!verification) return false;
        
        // Check if verification is still valid (within 30 minutes)
        if (verification.expiresAt && verification.expiresAt.getTime() < Date.now()) {
            await databaseInstance.collection('email_verifications').deleteOne({ email: normalizedEmail });
            return false;
        }
        
        return true;
    } else {
        const verification = memoryStorage.emailVerifications.get(normalizedEmail);
        if (!verification || !verification.verified) return false;
        if (verification.expiresAt < Date.now()) {
            memoryStorage.emailVerifications.delete(normalizedEmail);
            return false;
        }
        return true;
    }
}

// Clear email verification after successful registration
async function clearEmailVerification(email) {
    const normalizedEmail = email.toLowerCase();

    if (databaseInstance) {
        await databaseInstance.collection('email_verifications').deleteOne({ email: normalizedEmail });
    } else {
        memoryStorage.emailVerifications.delete(normalizedEmail);
    }
}

// ==================== FORGOT PASSWORD ROUTES ====================

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
    
    // Check if user exists in any collection
    let user = null;
    let userCollection = null;
    
    if (databaseInstance) {
        // Check in patients
        user = await databaseInstance.collection('patients').findOne({ email: normalizedEmail });
        if (user) userCollection = 'patients';
        
        // Check in doctors if not found
        if (!user) {
            user = await databaseInstance.collection('doctors').findOne({ email: normalizedEmail });
            if (user) userCollection = 'doctors';
        }
        
        // Check in admins if not found
        if (!user) {
            user = await databaseInstance.collection('admins').findOne({ email: normalizedEmail });
            if (user) userCollection = 'admins';
        }
    } else {
        // Check in-memory storage
        user = memoryStorage.patients.get(normalizedEmail) || 
               memoryStorage.doctors.get(normalizedEmail) || 
               memoryStorage.admins.get(normalizedEmail);
    }

    if (!user) {
        // Don't reveal that user doesn't exist for security reasons
        return response.json({ 
            success: true, 
            message: 'If an account exists with this email, you will receive an OTP.' 
        });
    }

    const otpCode = generateSecureOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    try {
        // Store OTP in database
        if (databaseInstance) {
            // Delete any existing OTPs for this email
            await databaseInstance.collection('password_reset_otps').deleteMany({ email: normalizedEmail });
            
            // Insert new OTP
            await databaseInstance.collection('password_reset_otps').insertOne({
                email: normalizedEmail,
                otp: otpCode,
                attempts: 0,
                expiresAt: expiresAt,
                createdAt: new Date()
            });
        } else {
            // In-memory storage
            const resetOtps = memoryStorage.otps.get('password_reset') || new Map();
            resetOtps.set(normalizedEmail, {
                otp: otpCode,
                attempts: 0,
                expiresAt: expiresAt,
                createdAt: Date.now()
            });
            memoryStorage.otps.set('password_reset', resetOtps);
        }

        // Send OTP email
        await sendOTPEmail(normalizedEmail, otpCode, 'reset');

        const isDevelopment = process.env.NODE_ENV !== 'production';
        response.json({ 
            success: true, 
            message: isDevelopment ? `OTP sent (check server console): ${otpCode}` : 'OTP sent to your email',
            devOTP: isDevelopment ? otpCode : undefined
        });

    } catch (error) {
        console.error('Error sending OTP:', error);
        response.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
});

// Verify OTP for password reset
application.post('/api/auth/verify-otp', async (request, response) => {
    const { email, otp } = request.body;

    if (!email || !otp) {
        return response.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const normalizedEmail = email.toLowerCase();

    try {
        let storedOTP;
        
        if (databaseInstance) {
            storedOTP = await databaseInstance.collection('password_reset_otps').findOne({ 
                email: normalizedEmail
            });
        } else {
            const resetOtps = memoryStorage.otps.get('password_reset') || new Map();
            storedOTP = resetOtps.get(normalizedEmail);
        }

        if (!storedOTP) {
            return response.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
        }

        // Check if OTP is expired
        const expiresAt = storedOTP.expiresAt?.getTime?.() || storedOTP.expiresAt;
        if (expiresAt && Date.now() > expiresAt) {
            if (databaseInstance) {
                await databaseInstance.collection('password_reset_otps').deleteOne({ email: normalizedEmail });
            } else {
                const resetOtps = memoryStorage.otps.get('password_reset') || new Map();
                resetOtps.delete(normalizedEmail);
                memoryStorage.otps.set('password_reset', resetOtps);
            }
            return response.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
        }

        // Check if OTP matches
        if (storedOTP.otp !== String(otp)) {
            // Increment attempts
            if (databaseInstance) {
                await databaseInstance.collection('password_reset_otps').updateOne(
                    { email: normalizedEmail },
                    { $inc: { attempts: 1 } }
                );
            } else {
                storedOTP.attempts = (storedOTP.attempts || 0) + 1;
            }

            // Check if too many attempts
            if ((storedOTP.attempts || 0) >= 5) {
                if (databaseInstance) {
                    await databaseInstance.collection('password_reset_otps').deleteOne({ email: normalizedEmail });
                } else {
                    const resetOtps = memoryStorage.otps.get('password_reset') || new Map();
                    resetOtps.delete(normalizedEmail);
                    memoryStorage.otps.set('password_reset', resetOtps);
                }
                return response.status(400).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
            }

            return response.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        // OTP is valid - keep it for password reset (will be deleted after reset)
        response.json({ 
            success: true, 
            message: 'OTP verified successfully' 
        });

    } catch (error) {
        console.error('Error verifying OTP:', error);
        response.status(500).json({ success: false, message: 'Failed to verify OTP' });
    }
});

// Reset Password
application.post('/api/auth/reset-password', async (request, response) => {
    const { email, password } = request.body;

    if (!email || !password) {
        return response.status(400).json({ success: false, message: 'Email and password are required' });
    }

    if (password.length < 6) {
        return response.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = email.toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        // Find which collection the user belongs to
        let updated = false;
        
        if (databaseInstance) {
            // Try patients first
            let result = await databaseInstance.collection('patients').updateOne(
                { email: normalizedEmail },
                { $set: { password: hashedPassword, updatedAt: new Date() } }
            );
            
            if (result.matchedCount > 0) {
                updated = true;
            } else {
                // Try doctors
                result = await databaseInstance.collection('doctors').updateOne(
                    { email: normalizedEmail },
                    { $set: { password: hashedPassword, updatedAt: new Date() } }
                );
                
                if (result.matchedCount > 0) {
                    updated = true;
                } else {
                    // Try admins
                    result = await databaseInstance.collection('admins').updateOne(
                        { email: normalizedEmail },
                        { $set: { password: hashedPassword, updatedAt: new Date() } }
                    );
                    
                    if (result.matchedCount > 0) {
                        updated = true;
                    }
                }
            }
        } else {
            // In-memory storage
            const patient = memoryStorage.patients.get(normalizedEmail);
            if (patient) {
                patient.password = hashedPassword;
                updated = true;
            } else {
                const doctor = memoryStorage.doctors.get(normalizedEmail);
                if (doctor) {
                    doctor.password = hashedPassword;
                    updated = true;
                } else {
                    const admin = memoryStorage.admins.get(normalizedEmail);
                    if (admin) {
                        admin.password = hashedPassword;
                        updated = true;
                    }
                }
            }
        }

        if (!updated) {
            return response.status(404).json({ success: false, message: 'User not found' });
        }

        // Delete the OTP after successful password reset
        if (databaseInstance) {
            await databaseInstance.collection('password_reset_otps').deleteMany({ email: normalizedEmail });
        } else {
            const resetOtps = memoryStorage.otps.get('password_reset') || new Map();
            resetOtps.delete(normalizedEmail);
            memoryStorage.otps.set('password_reset', resetOtps);
        }

        // Send confirmation email
        const html = `
            <h2>Password Reset Successful</h2>
            <p>Your NeuralCare account password has been successfully reset.</p>
            <p>If you did not perform this action, please contact support immediately.</p>
            <a href="http://localhost:3000/index.html" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">Login Now</a>
        `;
        sendEmail(normalizedEmail, 'Password Reset Successful', html);

        response.json({ 
            success: true, 
            message: 'Password reset successful' 
        });

    } catch (error) {
        console.error('Error resetting password:', error);
        response.status(500).json({ success: false, message: 'Failed to reset password' });
    }
});

// ==================== AUTH ROUTES ====================

// Health check
application.get('/api/health', (request, response) => {
    response.json({ 
        status: 'operational', 
        service: 'NeuralCare', 
        version: '3.0.0', 
        database: databaseInstance ? 'Connected' : 'In-Memory',
        ai: {
            finetuned: FINETUNED_API_URL ? 'Configured' : 'Not configured',
            local: 'Available',
            fallback: 'Ready'
        },
        payments: razorpay ? 'Configured' : 'Not configured',
        email: emailTransporter ? 'Configured' : 'Not configured'
    });
});

// Send OTP (legacy)
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
    
    await sendOTPEmail(normalizedEmail, otpCode, 'legacy');
    
    const isDevelopment = process.env.NODE_ENV !== 'production';
    response.json({ 
        success: true, 
        message: isDevelopment ? 'OTP sent (check server console)' : 'OTP sent to your email',
        devOTP: isDevelopment ? otpCode : undefined 
    });
});

// PATIENT SIGNUP with email verification
application.post('/api/auth/patient-signup', async (request, response) => {
    const { email, password, name, phone, age, gender, address } = request.body;

    if (!email || !password || !name) {
        return response.status(400).json({ success: false, message: 'Name, email and password are required' });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email is verified
    const verified = await isEmailVerified(normalizedEmail);
    if (!verified) {
        return response.status(400).json({ 
            success: false, 
            message: 'Email not verified. Please verify your email first.',
            requiresVerification: true
        });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        // Check if patient exists
        let existingPatient;
        if (databaseInstance) {
            existingPatient = await databaseInstance.collection('patients').findOne({ email: normalizedEmail });
        } else {
            existingPatient = memoryStorage.patients.get(normalizedEmail);
        }

        if (existingPatient) {
            return response.status(400).json({ success: false, message: 'Email already registered' });
        }

        const patientData = {
            email: normalizedEmail,
            password: hashedPassword,
            name,
            phone: phone || '',
            age: age || '',
            gender: gender || '',
            address: address || '',
            role: 'patient',
            emailVerified: true,
            verifiedAt: new Date(),
            createdAt: new Date(),
            consultations: [],
            doctors: []
        };

        let patientId;
        if (databaseInstance) {
            const result = await databaseInstance.collection('patients').insertOne(patientData);
            patientId = result.insertedId.toString();
        } else {
            patientId = 'pat_' + Date.now();
            memoryStorage.patients.set(normalizedEmail, { _id: patientId, ...patientData });
        }

        // Clear email verification
        await clearEmailVerification(normalizedEmail);

        // Send welcome email
        await sendWelcomeEmail(normalizedEmail, name, 'patient');

        return response.json({ 
            success: true, 
            message: 'Patient account created successfully', 
            role: 'patient',
            userId: patientId
        });

    } catch (error) {
        console.error('Patient signup error:', error);
        response.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// DOCTOR REGISTRATION WITH PAYMENT AND EMAIL VERIFICATION
application.post('/api/auth/doctor-register', async (request, response) => {
    const { 
        email, password, name, phone, age, gender, address,
        specialization, experience, qualification, consultationFee,
        transactionId, paymentAmount = 1999
    } = request.body;

    if (!email || !password || !name || !specialization || !transactionId) {
        return response.status(400).json({ 
            success: false, 
            message: 'All fields including transaction ID are required' 
        });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email is verified
    const verified = await isEmailVerified(normalizedEmail);
    if (!verified) {
        return response.status(400).json({ 
            success: false, 
            message: 'Email not verified. Please verify your email first.',
            requiresVerification: true
        });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        // Check if doctor already exists
        let existingDoctor;
        if (databaseInstance) {
            existingDoctor = await databaseInstance.collection('doctors').findOne({ email: normalizedEmail });
        } else {
            existingDoctor = memoryStorage.doctors.get(normalizedEmail);
        }

        if (existingDoctor) {
            return response.status(400).json({ success: false, message: 'Email already registered' });
        }

        // Check if transaction ID already used
        if (databaseInstance) {
            const existingTransaction = await databaseInstance.collection('doctors').findOne({ transactionId: transactionId.toUpperCase() });
            if (existingTransaction) {
                return response.status(400).json({ success: false, message: 'Transaction ID already used' });
            }
        }

        // Create doctor document with pending status
        const doctorData = {
            email: normalizedEmail,
            password: hashedPassword,
            name,
            phone: phone || '',
            age: age || '',
            gender: gender || '',
            address: address || '',
            specialization: specialization,
            experience: parseInt(experience) || 0,
            qualification: qualification || '',
            consultationFee: parseInt(consultationFee) || 500,
            role: 'doctor',
            
            // Email verification
            emailVerified: true,
            verifiedAt: new Date(),
            
            // Payment & Verification fields
            transactionId: transactionId.toUpperCase(),
            paymentStatus: 'pending',
            verificationStatus: 'pending',
            paymentAmount: paymentAmount,
            paymentDate: new Date(),
            
            // Account validity (will be set after verification)
            verified: false,
            subscriptionPaid: false,
            subscriptionFee: 1999,
            validUntil: null,
            
            // Admin tracking
            rejectionReason: null,
            verifiedBy: null,
            adminVerifiedAt: null,
            
            // Metadata
            patients: [],
            earnings: 0,
            rating: 0,
            reviews: [],
            available: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        let doctorId;
        if (databaseInstance) {
            const result = await databaseInstance.collection('doctors').insertOne(doctorData);
            doctorId = result.insertedId.toString();
        } else {
            doctorId = 'doc_' + Date.now();
            memoryStorage.doctors.set(normalizedEmail, { _id: doctorId, ...doctorData });
        }

        // Clear email verification
        await clearEmailVerification(normalizedEmail);

        // Send confirmation email to doctor
        const doctorEmailHtml = `
            <h2>Registration Received!</h2>
            <p>Dear Dr. ${name},</p>
            <p>Thank you for registering with NeuralCare.</p>
            <p>Your email has been verified successfully.</p>
            <p>Your payment transaction ID <strong>${transactionId}</strong> has been received and is pending verification.</p>
            <p>Our admin team will verify your payment within 24 hours. You will receive an email once your account is activated.</p>
            <p><strong>Subscription Amount:</strong> ₹${paymentAmount}</p>
            <p><strong>Valid for:</strong> 1 year after activation</p>
            <p>If you have any questions, please contact support@neuralcare.com</p>
        `;
        sendEmail(normalizedEmail, 'NeuralCare Doctor Registration Received', doctorEmailHtml);

        // Notify admin about new registration
        const adminHtml = `
            <h2>New Doctor Registration Pending Verification</h2>
            <p><strong>Name:</strong> Dr. ${name}</p>
            <p><strong>Email:</strong> ${normalizedEmail}</p>
            <p><strong>Specialization:</strong> ${specialization}</p>
            <p><strong>Experience:</strong> ${experience} years</p>
            <p><strong>Qualification:</strong> ${qualification}</p>
            <p><strong>Transaction ID:</strong> ${transactionId}</p>
            <p><strong>Amount:</strong> ₹${paymentAmount}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            <a href="http://localhost:3000/admin-dashboard.html" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">Review Registration</a>
        `;
        sendEmail(process.env.ADMIN_EMAIL || 'admin@neuralcare.com', 'New Doctor Registration - Action Required', adminHtml);

        response.json({ 
            success: true, 
            message: 'Registration submitted. Pending admin verification.',
            doctorId
        });

    } catch (error) {
        console.error('Doctor registration error:', error);
        response.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// Legacy signup endpoint (for backward compatibility)
application.post('/api/auth/signup', async (request, response) => {
    const { email, password, name, role, phone, age, gender, address, specialization, experience, qualification, consultationFee } = request.body;

    if (!email || !password || !name || !role) {
        return response.status(400).json({ success: false, message: 'All fields required' });
    }

    if (role === 'patient') {
        // Forward to patient signup
        const patientData = { email, password, name, phone, age, gender, address };
        request.body = patientData;
        return application._router.handle(request, response, () => {
            request.url = '/api/auth/patient-signup';
        });
    } else if (role === 'doctor') {
        // Forward to doctor registration
        const doctorData = { email, password, name, phone, age, gender, address, specialization, experience, qualification, consultationFee };
        request.body = doctorData;
        return application._router.handle(request, response, () => {
            request.url = '/api/auth/doctor-register';
        });
    } else {
        return response.status(400).json({ success: false, message: 'Invalid role' });
    }
});

// Login with role
application.post('/api/auth/login', async (request, response) => {
    const { email, password, role } = request.body;

    if (!email || !password || !role) {
        return response.status(400).json({ success: false, message: 'Email, password and role required' });
    }

    const normalizedEmail = email.toLowerCase();

    // Check login attempts
    const attempts = await getLoginAttempts(normalizedEmail);
    if (attempts >= 5) {
        return response.status(429).json({ 
            success: false, 
            message: 'Too many failed attempts. Please try again after 1 hour.' 
        });
    }

    let user = null;
    let collection = role === 'patient' ? 'patients' : role === 'doctor' ? 'doctors' : 'admins';

    try {
        if (databaseInstance) {
            user = await databaseInstance.collection(collection).findOne({ email: normalizedEmail });
        } else {
            user = memoryStorage[collection]?.get(normalizedEmail);
        }

        if (!user) {
            await trackLoginAttempt(normalizedEmail, false);
            return response.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Check if email is verified (for patients and doctors)
        if (role !== 'admin' && !user.emailVerified) {
            return response.status(403).json({ 
                success: false, 
                message: 'Email not verified. Please verify your email first.',
                requiresVerification: true
            });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            await trackLoginAttempt(normalizedEmail, false);
            return response.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Check doctor verification and subscription
        if (role === 'doctor') {
            if (user.verificationStatus === 'pending') {
                return response.status(403).json({ 
                    success: false, 
                    message: 'Your account is pending verification by admin. You will receive an email once verified.',
                    pendingVerification: true
                });
            }
            if (user.verificationStatus === 'rejected') {
                return response.status(403).json({ 
                    success: false, 
                    message: user.rejectionReason || 'Your account has been rejected. Please contact support.',
                    rejected: true
                });
            }
            if (!user.subscriptionPaid) {
                return response.json({ 
                    success: false, 
                    requiresPayment: true,
                    fee: user.subscriptionFee || 1999,
                    message: 'Please pay subscription fee to access doctor dashboard' 
                });
            }
        }

        // Clear login attempts on successful login
        await trackLoginAttempt(normalizedEmail, true);

        const sessionToken = generateSessionToken();
        const sessionData = {
            token: sessionToken,
            userId: user._id?.toString() || user.email,
            role,
            createdAt: new Date()
        };

        if (databaseInstance) {
            await databaseInstance.collection('sessions').insertOne(sessionData);
        } else {
            memoryStorage.sessions.set(sessionToken, sessionData);
        }

        // Get IP and device info for notification
        const clientIp = request.ip || request.connection.remoteAddress || 'Unknown';
        const userAgent = request.headers['user-agent'] || 'Unknown';
        
        // Send login notification
        sendLoginNotification(
            normalizedEmail, 
            user.name || user.email.split('@')[0],
            clientIp,
            userAgent,
            role
        ).catch(err => console.log('Background email error:', err.message));

        // Remove password from response
        delete user.password;

        console.log(`✅ ${role} logged in: ${normalizedEmail} from ${clientIp}`);

        response.json({
            success: true,
            message: 'Login successful',
            token: sessionToken,
            role,
            user: {
                id: user._id?.toString() || user.email,
                email: user.email,
                name: user.name,
                phone: user.phone || '',
                age: user.age || '',
                gender: user.gender || '',
                address: user.address || '',
                ...user
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
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
application.get('/api/auth/me', authenticateUser, async (request, response) => {
    try {
        let userRecord;
        const collection = request.userRole === 'patient' ? 'patients' : 
                          request.userRole === 'doctor' ? 'doctors' : 'admins';

        if (databaseInstance) {
            userRecord = await databaseInstance.collection(collection).findOne({ 
                _id: new ObjectId(request.userId) 
            });
        } else {
            const users = Array.from(memoryStorage[collection].values());
            userRecord = users.find(user => user._id === request.userId);
        }

        if (!userRecord) {
            return response.status(401).json({ success: false });
        }

        delete userRecord.password;

        response.json({ 
            success: true, 
            user: {
                ...userRecord,
                id: userRecord._id?.toString() || userRecord.email
            }
        });
    } catch (error) {
        console.error('Auth me error:', error);
        response.status(500).json({ success: false });
    }
});

// ==================== ADMIN ROUTES FOR DOCTOR VERIFICATION ====================

// Get all pending doctors
application.get('/api/admin/doctors/pending', authenticateAdmin, async (request, response) => {
    try {
        let doctors = [];
        
        if (databaseInstance) {
            doctors = await databaseInstance.collection('doctors')
                .find({ 
                    $or: [
                        { verificationStatus: 'pending' },
                        { verificationStatus: 'verified' },
                        { verificationStatus: 'rejected' }
                    ]
                })
                .project({ password: 0 })
                .sort({ createdAt: -1 })
                .toArray();
        } else {
            doctors = Array.from(memoryStorage.doctors.values())
                .map(({ password, ...rest }) => rest);
        }

        response.json({
            success: true,
            doctors
        });
    } catch (error) {
        console.error('Error fetching doctors:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Verify doctor and activate account for 1 year
application.post('/api/admin/verify-doctor/:id', authenticateAdmin, async (request, response) => {
    const doctorId = request.params.id;

    try {
        if (databaseInstance) {
            // Set validity for 1 year
            const validUntil = new Date();
            validUntil.setFullYear(validUntil.getFullYear() + 1);

            await databaseInstance.collection('doctors').updateOne(
                { _id: new ObjectId(doctorId) },
                { 
                    $set: { 
                        verificationStatus: 'verified',
                        verified: true,
                        subscriptionPaid: true,
                        validUntil: validUntil,
                        adminVerifiedAt: new Date(),
                        verifiedBy: request.adminId,
                        paymentStatus: 'completed',
                        updatedAt: new Date()
                    } 
                }
            );

            // Get doctor details for email
            const doctor = await databaseInstance.collection('doctors').findOne({ 
                _id: new ObjectId(doctorId) 
            });

            if (doctor) {
                // Send activation email to doctor
                const activationHtml = `
                    <h2>✅ Your NeuralCare Doctor Account is Verified!</h2>
                    <p>Dear Dr. ${doctor.name},</p>
                    <p>Congratulations! Your payment has been verified and your account is now active.</p>
                    
                    <div style="background: #f3f4f6; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h3>Account Details:</h3>
                        <p><strong>Account Type:</strong> Doctor Premium</p>
                        <p><strong>Valid Until:</strong> ${validUntil.toLocaleDateString()}</p>
                        <p><strong>Transaction ID:</strong> ${doctor.transactionId}</p>
                    </div>

                    <p>You can now log in and start accepting patients:</p>
                    <a href="http://localhost:3000/doctor-dashboard.html" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">Go to Dashboard</a>
                `;
                sendEmail(doctor.email, '✅ Doctor Account Verified - NeuralCare', activationHtml);
            }

            response.json({ success: true, message: 'Doctor verified and account activated for 1 year' });
        } else {
            response.status(500).json({ success: false, message: 'Database not available' });
        }
    } catch (error) {
        console.error('Verify doctor error:', error);
        response.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// Reject doctor with reason
application.post('/api/admin/reject-doctor/:id', authenticateAdmin, async (request, response) => {
    const doctorId = request.params.id;
    const { reason } = request.body;

    if (!reason) {
        return response.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    try {
        if (databaseInstance) {
            await databaseInstance.collection('doctors').updateOne(
                { _id: new ObjectId(doctorId) },
                { 
                    $set: { 
                        verificationStatus: 'rejected',
                        rejectionReason: reason,
                        adminVerifiedAt: new Date(),
                        verifiedBy: request.adminId,
                        updatedAt: new Date()
                    } 
                }
            );

            // Get doctor details for email
            const doctor = await databaseInstance.collection('doctors').findOne({ 
                _id: new ObjectId(doctorId) 
            });

            if (doctor) {
                // Send rejection email to doctor
                const rejectionHtml = `
                    <h2>⚠️ Doctor Registration Update</h2>
                    <p>Dear Dr. ${doctor.name},</p>
                    <p>We regret to inform you that your doctor registration could not be verified.</p>
                    
                    <div style="background: #fee2e2; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h3>Reason for Rejection:</h3>
                        <p>${reason}</p>
                    </div>

                    <p>If you believe this is a mistake or need assistance, please contact our support team at support@neuralcare.com</p>
                `;
                sendEmail(doctor.email, '⚠️ Doctor Registration Update', rejectionHtml);
            }

            response.json({ success: true, message: 'Doctor rejected' });
        } else {
            response.status(500).json({ success: false, message: 'Database not available' });
        }
    } catch (error) {
        console.error('Reject doctor error:', error);
        response.status(500).json({ success: false, message: 'Rejection failed' });
    }
});

// ==================== PAYMENT ROUTES ====================

// Create payment order
application.post('/api/payment/create-order', authenticateUser, async (request, response) => {
    const { amount, type, doctorId } = request.body;

    if (!razorpay) {
        return response.status(500).json({ success: false, message: 'Payment gateway not configured' });
    }

    try {
        const options = {
            amount: amount * 100, // Razorpay expects amount in paise
            currency: 'INR',
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1
        };

        const order = await razorpay.orders.create(options);

        // Save order to database
        const paymentData = {
            orderId: order.id,
            userId: request.userId,
            userRole: request.userRole,
            amount,
            type,
            doctorId,
            status: 'created',
            createdAt: new Date()
        };

        if (databaseInstance) {
            await databaseInstance.collection('payments').insertOne(paymentData);
        } else {
            const paymentId = 'pay_' + Date.now();
            memoryStorage.payments.set(order.id, { _id: paymentId, ...paymentData });
        }

        response.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency
        });

    } catch (error) {
        console.error('Payment error:', error);
        response.status(500).json({ success: false, message: 'Payment failed' });
    }
});

// Verify payment
application.post('/api/payment/verify', authenticateUser, async (request, response) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, type, doctorId } = request.body;

    try {
        // Verify payment signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return response.status(400).json({ success: false, message: 'Invalid signature' });
        }

        // Update payment status
        if (databaseInstance) {
            await databaseInstance.collection('payments').updateOne(
                { orderId: razorpay_order_id },
                { 
                    $set: { 
                        status: 'completed',
                        paymentId: razorpay_payment_id,
                        completedAt: new Date()
                    } 
                }
            );
        }

        // Handle different payment types
        if (type === 'doctor_subscription') {
            // Update doctor subscription
            if (databaseInstance) {
                await databaseInstance.collection('doctors').updateOne(
                    { _id: new ObjectId(request.userId) },
                    { 
                        $set: { 
                            subscriptionPaid: true,
                            subscriptionStart: new Date(),
                            subscriptionEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
                        } 
                    }
                );

                // Get doctor for notification
                const doctor = await databaseInstance.collection('doctors').findOne({ 
                    _id: new ObjectId(request.userId) 
                });

                if (doctor) {
                    const html = `
                        <h2>Payment Successful!</h2>
                        <p>Thank you for subscribing to NeuralCare Premium.</p>
                        <p>Your subscription is active for 30 days.</p>
                        <p>You can now start accepting patients.</p>
                        <a href="http://localhost:3000/doctor-dashboard.html" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">Go to Dashboard</a>
                    `;
                    sendEmail(doctor.email, 'Subscription Activated', html);
                }
            }
        } else if (type === 'consultation') {
            // Create consultation
            const consultationData = {
                patientId: request.userId,
                doctorId,
                paymentId: razorpay_payment_id,
                status: 'confirmed',
                createdAt: new Date(),
                scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000) // Next day
            };

            let consultationId;
            if (databaseInstance) {
                const result = await databaseInstance.collection('consultations').insertOne(consultationData);
                consultationId = result.insertedId.toString();

                // Notify doctor
                const doctor = await databaseInstance.collection('doctors').findOne({ 
                    _id: new ObjectId(doctorId) 
                });

                if (doctor) {
                    const patient = await databaseInstance.collection('patients').findOne({ 
                        _id: new ObjectId(request.userId) 
                    });

                    const doctorHtml = `
                        <h2>New Consultation Booked</h2>
                        <p><strong>Patient:</strong> ${patient?.name || 'Patient'}</p>
                        <p><strong>Date:</strong> ${new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString()}</p>
                        <p><strong>Time:</strong> To be scheduled</p>
                        <a href="http://localhost:3000/doctor-dashboard.html" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">View Details</a>
                    `;
                    sendEmail(doctor.email, 'New Consultation Booked', doctorHtml);
                }

                const patientHtml = `
                    <h2>Consultation Confirmed</h2>
                    <p>Your consultation with Dr. ${doctor?.name || 'Specialist'} has been confirmed.</p>
                    <p><strong>Date:</strong> ${new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString()}</p>
                    <p>You will receive a meeting link 1 hour before the session.</p>
                `;
                sendEmail(request.userId.includes('@') ? request.userId : patient?.email, 'Consultation Confirmed', patientHtml);
            }

            response.json({ 
                success: true, 
                message: 'Payment verified and consultation booked',
                consultationId
            });
            return;
        }

        response.json({ success: true, message: 'Payment verified' });

    } catch (error) {
        console.error('Payment verification error:', error);
        response.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// ==================== DOCTOR ROUTES ====================

// Get all verified doctors (for patients)
application.get('/api/doctors', async (request, response) => {
    try {
        let doctors = [];
        if (databaseInstance) {
            doctors = await databaseInstance.collection('doctors')
                .find({ verified: true, available: true, subscriptionPaid: true })
                .project({ password: 0 })
                .sort({ rating: -1 })
                .toArray();
        } else {
            doctors = Array.from(memoryStorage.doctors.values())
                .filter(d => d.verified && d.available && d.subscriptionPaid)
                .map(({ password, ...rest }) => rest);
        }

        response.json({ success: true, doctors });
    } catch (error) {
        console.error('Get doctors error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get doctor by ID
application.get('/api/doctors/:id', async (request, response) => {
    try {
        let doctor;
        if (databaseInstance) {
            doctor = await databaseInstance.collection('doctors')
                .findOne({ _id: new ObjectId(request.params.id) }, { projection: { password: 0 } });
        } else {
            doctor = Array.from(memoryStorage.doctors.values()).find(d => d._id === request.params.id);
            if (doctor) {
                const { password, ...rest } = doctor;
                doctor = rest;
            }
        }

        if (!doctor) {
            return response.status(404).json({ success: false, message: 'Doctor not found' });
        }

        response.json({ success: true, doctor });
    } catch (error) {
        console.error('Get doctor error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get doctor's patients
application.get('/api/doctor/patients', authenticateDoctor, async (request, response) => {
    try {
        let consultations = [];
        let patients = [];

        if (databaseInstance) {
            // Get all consultations for this doctor
            consultations = await databaseInstance.collection('consultations')
                .find({ doctorId: request.doctorId })
                .sort({ createdAt: -1 })
                .toArray();

            // Get unique patient IDs
            const patientIds = [...new Set(consultations.map(c => c.patientId))];
            
            // Get patient details
            patients = await databaseInstance.collection('patients')
                .find({ _id: { $in: patientIds.map(id => new ObjectId(id)) } })
                .project({ password: 0 })
                .toArray();

            // Get AI consultations that need doctor review
            const aiConsultations = await databaseInstance.collection('ai_consultations')
                .find({ 
                    status: 'needs_doctor',
                    assignedDoctor: request.doctorId 
                })
                .toArray();
            
            response.json({ 
                success: true, 
                consultations,
                patients,
                aiConsultations,
                totalPatients: patients.length,
                totalConsultations: consultations.length,
                pendingAI: aiConsultations.length
            });
        }
    } catch (error) {
        console.error('Get doctor patients error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Update doctor profile
application.put('/api/doctor/profile', authenticateDoctor, async (request, response) => {
    const updates = request.body;
    delete updates.password;
    delete updates._id;
    delete updates.verified;
    delete updates.subscriptionPaid;

    try {
        if (databaseInstance) {
            await databaseInstance.collection('doctors').updateOne(
                { _id: new ObjectId(request.doctorId) },
                { $set: updates }
            );
        }

        response.json({ success: true, message: 'Profile updated' });
    } catch (error) {
        console.error('Update doctor error:', error);
        response.status(500).json({ success: false, message: 'Update failed' });
    }
});

// Add review for doctor
application.post('/api/doctors/:id/review', authenticateUser, async (request, response) => {
    const { rating, comment } = request.body;
    const doctorId = request.params.id;

    try {
        if (databaseInstance) {
            const review = {
                patientId: request.userId,
                rating: parseInt(rating),
                comment,
                createdAt: new Date()
            };

            await databaseInstance.collection('doctors').updateOne(
                { _id: new ObjectId(doctorId) },
                { 
                    $push: { reviews: review },
                    $inc: { ratingTotal: rating, reviewCount: 1 }
                }
            );

            // Recalculate average rating
            const doctor = await databaseInstance.collection('doctors').findOne({ _id: new ObjectId(doctorId) });
            const newRating = (doctor.ratingTotal || rating) / (doctor.reviewCount || 1);
            
            await databaseInstance.collection('doctors').updateOne(
                { _id: new ObjectId(doctorId) },
                { $set: { rating: newRating } }
            );
        }

        response.json({ success: true, message: 'Review added' });
    } catch (error) {
        console.error('Add review error:', error);
        response.status(500).json({ success: false, message: 'Failed to add review' });
    }
});

// ==================== PATIENT ROUTES ====================

// Book consultation
application.post('/api/patient/book-consultation', authenticateUser, async (request, response) => {
    const { doctorId, date, time, symptoms } = request.body;

    try {
        // Check doctor availability
        let doctor;
        if (databaseInstance) {
            doctor = await databaseInstance.collection('doctors').findOne({ 
                _id: new ObjectId(doctorId),
                verified: true,
                available: true
            });
        }

        if (!doctor) {
            return response.status(404).json({ success: false, message: 'Doctor not available' });
        }

        // Create appointment
        const appointmentData = {
            patientId: request.userId,
            doctorId,
            date: new Date(date),
            time,
            symptoms,
            status: 'pending',
            paymentStatus: 'pending',
            createdAt: new Date()
        };

        let appointmentId;
        if (databaseInstance) {
            const result = await databaseInstance.collection('appointments').insertOne(appointmentData);
            appointmentId = result.insertedId.toString();
        }

        response.json({ 
            success: true, 
            message: 'Appointment requested. Please complete payment.',
            appointmentId,
            fee: doctor.consultationFee
        });
    } catch (error) {
        console.error('Book consultation error:', error);
        response.status(500).json({ success: false, message: 'Booking failed' });
    }
});

// Get patient's consultations
application.get('/api/patient/consultations', authenticateUser, async (request, response) => {
    try {
        let consultations = [];
        let doctors = [];

        if (databaseInstance) {
            consultations = await databaseInstance.collection('consultations')
                .find({ patientId: request.userId })
                .sort({ createdAt: -1 })
                .toArray();

            // Get doctor details
            const doctorIds = [...new Set(consultations.map(c => c.doctorId))];
            doctors = await databaseInstance.collection('doctors')
                .find({ _id: { $in: doctorIds.map(id => new ObjectId(id)) } })
                .project({ password: 0 })
                .toArray();

            // Get pending appointments
            const appointments = await databaseInstance.collection('appointments')
                .find({ patientId: request.userId, paymentStatus: 'pending' })
                .toArray();

            response.json({ 
                success: true, 
                consultations,
                doctors,
                appointments,
                totalConsultations: consultations.length,
                pendingAppointments: appointments.length
            });
        }
    } catch (error) {
        console.error('Get patient consultations error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==================== AI CONSULTATION ROUTES ====================

// AI consultation
application.post('/api/ai/consult', authenticateUser, async (request, response) => {
    const { message, symptoms, duration } = request.body;

    try {
        // AI analysis based on symptoms
        const aiAnalysis = await analyzeSymptoms(message, symptoms, duration);
        
        // Save consultation for doctor review if needed
        if (aiAnalysis.severity === 'high' || aiAnalysis.severity === 'medium') {
            const consultationData = {
                patientId: request.userId,
                message,
                symptoms,
                duration,
                aiAnalysis,
                status: 'needs_doctor',
                createdAt: new Date()
            };

            let consultationId;
            if (databaseInstance) {
                const result = await databaseInstance.collection('ai_consultations').insertOne(consultationData);
                consultationId = result.insertedId.toString();
                
                // Find relevant doctors based on specialization
                const relevantDoctors = await databaseInstance.collection('doctors')
                    .find({ 
                        specialization: aiAnalysis.specialization,
                        verified: true,
                        available: true,
                        subscriptionPaid: true
                    })
                    .limit(3)
                    .toArray();

                // Assign to first available doctor
                if (relevantDoctors.length > 0) {
                    const assignedDoctor = relevantDoctors[0];
                    await databaseInstance.collection('ai_consultations').updateOne(
                        { _id: result.insertedId },
                        { $set: { assignedDoctor: assignedDoctor._id.toString() } }
                    );

                    // Notify doctor
                    const doctorHtml = `
                        <h2>Patient Needs Consultation</h2>
                        <p>A patient requires consultation for: ${aiAnalysis.specialization}</p>
                        <p><strong>Symptoms:</strong> ${symptoms || message}</p>
                        <p><strong>Severity:</strong> ${aiAnalysis.severity}</p>
                        <a href="http://localhost:3000/doctor-dashboard.html?consultation=${consultationId}" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">Review Case</a>
                    `;
                    sendEmail(assignedDoctor.email, 'Patient Needs Consultation', doctorHtml);
                }
            }

            response.json({
                success: true,
                analysis: aiAnalysis,
                recommendation: aiAnalysis.recommendation,
                needsDoctor: true,
                consultationId
            });
        } else {
            response.json({
                success: true,
                analysis: aiAnalysis,
                recommendation: aiAnalysis.recommendation,
                needsDoctor: false
            });
        }

    } catch (error) {
        console.error('AI consultation error:', error);
        response.status(500).json({ success: false, message: 'AI analysis failed' });
    }
});

// Get AI consultations for doctor
application.get('/api/doctor/ai-consultations', authenticateDoctor, async (request, response) => {
    try {
        let consultations = [];
        if (databaseInstance) {
            consultations = await databaseInstance.collection('ai_consultations')
                .find({ 
                    assignedDoctor: request.doctorId,
                    status: 'needs_doctor'
                })
                .sort({ createdAt: -1 })
                .toArray();

            // Get patient details
            const patientIds = [...new Set(consultations.map(c => c.patientId))];
            const patients = await databaseInstance.collection('patients')
                .find({ _id: { $in: patientIds.map(id => new ObjectId(id)) } })
                .project({ password: 0 })
                .toArray();

            response.json({ 
                success: true, 
                consultations,
                patients,
                totalPending: consultations.length
            });
        }
    } catch (error) {
        console.error('Get AI consultations error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Doctor responds to AI consultation
application.post('/api/doctor/respond-consultation/:id', authenticateDoctor, async (request, response) => {
    const { response: doctorResponse, prescription, followUp } = request.body;
    const consultationId = request.params.id;

    try {
        if (databaseInstance) {
            const consultation = await databaseInstance.collection('ai_consultations').findOne({ 
                _id: new ObjectId(consultationId) 
            });

            if (!consultation) {
                return response.status(404).json({ success: false, message: 'Consultation not found' });
            }

            await databaseInstance.collection('ai_consultations').updateOne(
                { _id: new ObjectId(consultationId) },
                { 
                    $set: { 
                        status: 'responded',
                        doctorResponse,
                        prescription,
                        followUp,
                        respondedAt: new Date()
                    } 
                }
            );

            // Notify patient
            const patient = await databaseInstance.collection('patients').findOne({ 
                _id: new ObjectId(consultation.patientId) 
            });

            if (patient) {
                const patientHtml = `
                    <h2>Doctor's Response to Your Consultation</h2>
                    <p><strong>Message from Dr. ${request.doctor.name}:</strong></p>
                    <p>${doctorResponse}</p>
                    ${prescription ? `<p><strong>Prescription:</strong> ${prescription}</p>` : ''}
                    ${followUp ? `<p><strong>Follow-up:</strong> ${followUp}</p>` : ''}
                    <a href="http://localhost:3000/patient-dashboard.html" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 20px;">View Details</a>
                `;
                sendEmail(patient.email, 'Doctor Responded to Your Consultation', patientHtml);
            }
        }

        response.json({ success: true, message: 'Response sent' });
    } catch (error) {
        console.error('Respond to consultation error:', error);
        response.status(500).json({ success: false, message: 'Failed to send response' });
    }
});

// ==================== ADMIN ROUTES ====================

// Get all users (patients + doctors)
application.get('/api/admin/users', authenticateAdmin, async (request, response) => {
    try {
        let patients = [], doctors = [];
        
        if (databaseInstance) {
            patients = await databaseInstance.collection('patients')
                .find({})
                .project({ password: 0 })
                .sort({ createdAt: -1 })
                .toArray();
            
            doctors = await databaseInstance.collection('doctors')
                .find({})
                .project({ password: 0 })
                .sort({ createdAt: -1 })
                .toArray();
        }

        response.json({
            success: true,
            patients,
            doctors,
            totalPatients: patients.length,
            totalDoctors: doctors.length,
            pendingDoctors: doctors.filter(d => d.verificationStatus === 'pending').length
        });
    } catch (error) {
        console.error('Get users error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get all payments
application.get('/api/admin/payments', authenticateAdmin, async (request, response) => {
    try {
        let payments = [];
        if (databaseInstance) {
            payments = await databaseInstance.collection('payments')
                .find({})
                .sort({ createdAt: -1 })
                .toArray();
        }

        const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const completedPayments = payments.filter(p => p.status === 'completed');

        response.json({
            success: true,
            payments,
            totalRevenue,
            totalPayments: payments.length,
            completedPayments: completedPayments.length,
            pendingPayments: payments.length - completedPayments.length
        });
    } catch (error) {
        console.error('Get payments error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get all consultations
application.get('/api/admin/consultations', authenticateAdmin, async (request, response) => {
    try {
        let consultations = [], aiConsultations = [];
        
        if (databaseInstance) {
            consultations = await databaseInstance.collection('consultations')
                .find({})
                .sort({ createdAt: -1 })
                .toArray();

            aiConsultations = await databaseInstance.collection('ai_consultations')
                .find({})
                .sort({ createdAt: -1 })
                .toArray();
        }

        response.json({
            success: true,
            consultations,
            aiConsultations,
            totalConsultations: consultations.length,
            totalAIConsultations: aiConsultations.length,
            pendingAI: aiConsultations.filter(c => c.status === 'needs_doctor').length
        });
    } catch (error) {
        console.error('Get consultations error:', error);
        response.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete user
application.delete('/api/admin/user/:role/:id', authenticateAdmin, async (request, response) => {
    const { role, id } = request.params;
    const collection = role === 'patient' ? 'patients' : 'doctors';

    try {
        if (databaseInstance) {
            await databaseInstance.collection(collection).deleteOne({ _id: new ObjectId(id) });
        }

        response.json({ success: true, message: 'User deleted' });
    } catch (error) {
        console.error('Delete user error:', error);
        response.status(500).json({ success: false, message: 'Delete failed' });
    }
});

// Update user (admin)
application.put('/api/admin/user/:role/:id', authenticateAdmin, async (request, response) => {
    const { role, id } = request.params;
    const collection = role === 'patient' ? 'patients' : 'doctors';
    const updates = request.body;
    
    delete updates.password;
    delete updates._id;

    try {
        if (databaseInstance) {
            await databaseInstance.collection(collection).updateOne(
                { _id: new ObjectId(id) },
                { $set: updates }
            );
        }

        response.json({ success: true, message: 'User updated' });
    } catch (error) {
        console.error('Update user error:', error);
        response.status(500).json({ success: false, message: 'Update failed' });
    }
});

// ==================== CHAT ROUTES ====================

// Chat endpoint
application.post('/api/chat', async (request, response) => {
    const { message, language = 'en' } = request.body;
    const authToken = request.headers.authorization?.replace('Bearer ', '');
    
    const acceptStreaming = request.headers.accept === 'text/event-stream';
    
    if (acceptStreaming) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
    }
    
    const sendProgress = (stage, message) => {
        if (acceptStreaming) {
            response.write(`data: ${JSON.stringify({ type: 'progress', stage, message })}\n\n`);
        }
    };
    
    sendProgress('start', 'Processing your message...');
    
    let userContextData = '';
    let userRecord = null;
    let sessionRecord = null;
    let userRole = 'guest';
    
    // Get user context if authenticated
    if (authToken) {
        sendProgress('auth', 'Fetching your data...');
        
        if (databaseInstance) {
            sessionRecord = await databaseInstance.collection('sessions').findOne({ token: authToken });
            if (sessionRecord) {
                const collection = sessionRecord.role === 'patient' ? 'patients' : 
                                  sessionRecord.role === 'doctor' ? 'doctors' : 'users';
                
                userRecord = await databaseInstance.collection(collection).findOne({ 
                    _id: new ObjectId(sessionRecord.userId) 
                });
                userRole = sessionRecord.role;
            }
        } else {
            sessionRecord = memoryStorage.sessions.get(authToken);
            if (sessionRecord) {
                const collection = sessionRecord.role === 'patient' ? memoryStorage.patients :
                                  sessionRecord.role === 'doctor' ? memoryStorage.doctors : memoryStorage.users;
                const users = Array.from(collection.values());
                userRecord = users.find(u => u._id === sessionRecord.userId);
                userRole = sessionRecord.role;
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
- Role: ${userRole}
- Email: ${userRecord.email || 'Not specified'}
- Email Verified: ${userRecord.emailVerified ? 'Yes' : 'No'}
`;
            
            sendProgress('context', 'Loading your personal context...');
            
            // Get medications if patient
            if (userRole === 'patient' && databaseInstance && sessionRecord) {
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
        
        if (databaseInstance && sessionRecord && userRole === 'patient') {
            await databaseInstance.collection('moods').insertOne({
                userId: sessionRecord.userId,
                mood: 'terrible',
                note: 'Crisis indicators detected in conversation',
                source: 'ai_detection',
                createdAt: new Date()
            });

            // Notify admin about crisis
            const adminHtml = `
                <h2>Crisis Alert</h2>
                <p>A patient has used crisis keywords in chat.</p>
                <p><strong>Patient:</strong> ${userRecord?.name || 'Unknown'}</p>
                <p><strong>Message:</strong> ${message}</p>
                <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            `;
            sendEmail(process.env.ADMIN_EMAIL || 'admin@neuralcare.com', 'Crisis Alert - Immediate Attention', adminHtml);
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
        
        const aiResult = await generateAIResponse(message, userContextData, language);
        
        sendProgress('processing', 'Processing response...');
        
        // Save mood if detected and user is patient
        if (databaseInstance && sessionRecord && userRole === 'patient') {
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
            const words = aiResult.text.split(' ');
            let chunk = '';
            
            for (const word of words) {
                chunk += word + ' ';
                if (chunk.length > 50) {
                    response.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
                    chunk = '';
                    await new Promise(resolve => setTimeout(resolve, 50));
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
application.post('/api/chat/save', authenticateUser, async (request, response) => {
    const { message, response: aiResponse } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('chats').insertOne({
                userId: request.userId,
                userRole: request.userRole,
                message,
                response: aiResponse,
                createdAt: new Date()
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Save chat error:', error);
        response.status(500).json({ success: false, message: 'Failed to save chat' });
    }
});

// Get chat history
application.get('/api/chat/history', authenticateUser, async (request, response) => {
    try {
        let chatHistory = [];
        
        if (databaseInstance) {
            chatHistory = await databaseInstance.collection('chats')
                .find({ userId: request.userId })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
        }

        response.json({ 
            success: true, 
            chats: chatHistory.reverse() 
        });
    } catch (error) {
        console.error('Get chat history error:', error);
        response.status(500).json({ success: false, message: 'Failed to load chat history' });
    }
});

// ==================== MOOD ROUTES ====================

// Save mood
application.post('/api/mood', authenticateUser, async (request, response) => {
    const { mood, note } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('moods').insertOne({ 
                userId: request.userId,
                userRole: request.userRole,
                mood, 
                note: note || '',
                date: new Date().toISOString().split('T')[0], 
                createdAt: new Date() 
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Save mood error:', error);
        response.status(500).json({ success: false, message: 'Failed to save mood' });
    }
});

// Get moods
application.get('/api/mood', authenticateUser, async (request, response) => {
    try {
        let moodEntries = [];
        
        if (databaseInstance) {
            moodEntries = await databaseInstance.collection('moods')
                .find({ userId: request.userId })
                .sort({ createdAt: -1 })
                .limit(30)
                .toArray();
        }

        response.json({ 
            success: true, 
            moods: moodEntries 
        });
    } catch (error) {
        console.error('Get moods error:', error);
        response.status(500).json({ success: false, message: 'Failed to load moods' });
    }
});

// ==================== JOURNAL ROUTES ====================

// Save journal
application.post('/api/journal', authenticateUser, async (request, response) => {
    const { title, content } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('journals').insertOne({ 
                userId: request.userId,
                userRole: request.userRole,
                title: title || 'Journal Entry',
                content, 
                createdAt: new Date() 
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Save journal error:', error);
        response.status(500).json({ success: false, message: 'Failed to save journal' });
    }
});

// Get journals
application.get('/api/journal', authenticateUser, async (request, response) => {
    try {
        let journalEntries = [];
        
        if (databaseInstance) {
            journalEntries = await databaseInstance.collection('journals')
                .find({ userId: request.userId })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
        }

        response.json({ 
            success: true, 
            entries: journalEntries 
        });
    } catch (error) {
        console.error('Get journals error:', error);
        response.status(500).json({ success: false, message: 'Failed to load journals' });
    }
});

// ==================== MEDICATION ROUTES ====================

// Save medication
application.post('/api/medications', authenticateUser, async (request, response) => {
    const { name, dosage, frequency, time, notes } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('medications').insertOne({
                userId: request.userId,
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
    } catch (error) {
        console.error('Save medication error:', error);
        response.status(500).json({ success: false, message: 'Failed to save medication' });
    }
});

// Get medications
application.get('/api/medications', authenticateUser, async (request, response) => {
    try {
        let medicationList = [];
        
        if (databaseInstance) {
            medicationList = await databaseInstance.collection('medications')
                .find({ userId: request.userId, active: true })
                .toArray();
        }

        response.json({ 
            success: true, 
            medications: medicationList 
        });
    } catch (error) {
        console.error('Get medications error:', error);
        response.status(500).json({ success: false, message: 'Failed to load medications' });
    }
});

// Delete medication
application.delete('/api/medications/:id', authenticateUser, async (request, response) => {
    try {
        if (databaseInstance) {
            await databaseInstance.collection('medications').deleteOne({ 
                _id: new ObjectId(request.params.id),
                userId: request.userId
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Delete medication error:', error);
        response.status(500).json({ success: false, message: 'Failed to delete medication' });
    }
});

// Mark medication as taken
application.post('/api/medications/:id/take', authenticateUser, async (request, response) => {
    try {
        if (databaseInstance) {
            await databaseInstance.collection('medications').updateOne(
                { _id: new ObjectId(request.params.id) },
                { $set: { lastTaken: new Date() } }
            );
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Take medication error:', error);
        response.status(500).json({ success: false, message: 'Failed to update medication' });
    }
});

// ==================== ROUTINE ROUTES ====================

// Save routine
application.post('/api/routine', authenticateUser, async (request, response) => {
    const { title, time, days, enabled } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('routines').insertOne({
                userId: request.userId,
                title,
                time,
                days,
                enabled: enabled !== false,
                createdAt: new Date()
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Save routine error:', error);
        response.status(500).json({ success: false, message: 'Failed to save routine' });
    }
});

// Get routines
application.get('/api/routine', authenticateUser, async (request, response) => {
    try {
        let routineItems = [];
        
        if (databaseInstance) {
            routineItems = await databaseInstance.collection('routines')
                .find({ userId: request.userId })
                .toArray();
        }

        response.json({ 
            success: true, 
            routines: routineItems 
        });
    } catch (error) {
        console.error('Get routines error:', error);
        response.status(500).json({ success: false, message: 'Failed to load routines' });
    }
});

// Update routine
application.put('/api/routine/:id', authenticateUser, async (request, response) => {
    const { enabled } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('routines').updateOne(
                { _id: new ObjectId(request.params.id), userId: request.userId },
                { $set: { enabled } }
            );
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Update routine error:', error);
        response.status(500).json({ success: false, message: 'Failed to update routine' });
    }
});

// Delete routine
application.delete('/api/routine/:id', authenticateUser, async (request, response) => {
    try {
        if (databaseInstance) {
            await databaseInstance.collection('routines').deleteOne({ 
                _id: new ObjectId(request.params.id),
                userId: request.userId
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Delete routine error:', error);
        response.status(500).json({ success: false, message: 'Failed to delete routine' });
    }
});

// ==================== CLINIC REPORT ROUTES ====================

// Save clinic report
application.post('/api/clinic/report', authenticateUser, async (request, response) => {
    const { title, type, date, notes } = request.body;
    
    try {
        if (databaseInstance) {
            await databaseInstance.collection('clinic_reports').insertOne({
                userId: request.userId,
                title,
                type,
                date: new Date(date),
                notes,
                createdAt: new Date()
            });
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Save clinic report error:', error);
        response.status(500).json({ success: false, message: 'Failed to save report' });
    }
});

// Get clinic reports
application.get('/api/clinic/reports', authenticateUser, async (request, response) => {
    try {
        let clinicReports = [];
        
        if (databaseInstance) {
            clinicReports = await databaseInstance.collection('clinic_reports')
                .find({ userId: request.userId })
                .sort({ date: -1 })
                .toArray();
        }

        response.json({ 
            success: true, 
            reports: clinicReports 
        });
    } catch (error) {
        console.error('Get clinic reports error:', error);
        response.status(500).json({ success: false, message: 'Failed to load reports' });
    }
});

// ==================== NOTIFICATION ROUTES ====================

// Get notifications
application.get('/api/notifications', authenticateUser, async (request, response) => {
    try {
        let notificationList = [];
        let unreadCount = 0;
        
        if (databaseInstance) {
            notificationList = await databaseInstance.collection('notifications')
                .find({ userId: request.userId })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
                
            unreadCount = await databaseInstance.collection('notifications')
                .countDocuments({ 
                    userId: request.userId, 
                    read: false 
                });
        }

        response.json({ 
            success: true, 
            notifications: notificationList, 
            unreadCount 
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        response.status(500).json({ success: false, message: 'Failed to load notifications' });
    }
});

// Mark notification as read
application.post('/api/notifications/read', authenticateUser, async (request, response) => {
    const { notificationId } = request.body;
    
    try {
        if (databaseInstance) {
            if (notificationId) {
                await databaseInstance.collection('notifications').updateOne(
                    { _id: new ObjectId(notificationId), userId: request.userId },
                    { $set: { read: true, readAt: new Date() } }
                );
            } else {
                await databaseInstance.collection('notifications').updateMany(
                    { userId: request.userId, read: false },
                    { $set: { read: true, readAt: new Date() } }
                );
            }
        }

        response.json({ success: true });
    } catch (error) {
        console.error('Mark notification read error:', error);
        response.status(500).json({ success: false, message: 'Failed to update notifications' });
    }
});

// Create notification (internal)
async function createNotification(userId, title, message, type = 'info') {
    if (!databaseInstance) return;
    
    try {
        await databaseInstance.collection('notifications').insertOne({
            userId,
            title,
            message,
            type,
            read: false,
            createdAt: new Date()
        });
    } catch (error) {
        console.error('Create notification error:', error);
    }
}

// ==================== PUBLIC API ====================

// Public chat API for external apps
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
    let userRecord;
    
    if (databaseInstance) {
        sessionRecord = await databaseInstance.collection('sessions').findOne({ token: userToken });
        if (sessionRecord) {
            const collection = sessionRecord.role === 'patient' ? 'patients' : 'users';
            userRecord = await databaseInstance.collection(collection).findOne({ 
                _id: new ObjectId(sessionRecord.userId) 
            });
        }
    } else {
        sessionRecord = memoryStorage.sessions.get(userToken);
        if (sessionRecord) {
            const collection = sessionRecord.role === 'patient' ? memoryStorage.patients : memoryStorage.users;
            const users = Array.from(collection.values());
            userRecord = users.find(u => u._id === sessionRecord.userId);
        }
    }
    
    if (!userRecord) {
        return response.status(404).json({ 
            error: 'User not found' 
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

// ==================== SERVE STATIC FILES ====================

application.get('*', (request, response) => {
    const publicPath = path.join(__dirname, 'public');
    const filePath = path.join(publicPath, request.path);
    
    response.sendFile(filePath, (err) => {
        if (err) {
            // Serve appropriate landing page based on path or default to landing.html
            if (request.path.includes('doctor')) {
                response.sendFile(path.join(publicPath, 'doctor-dashboard.html'));
            } else if (request.path.includes('admin')) {
                response.sendFile(path.join(publicPath, 'admin-dashboard.html'));
            } else if (request.path.includes('patient')) {
                response.sendFile(path.join(publicPath, 'patient-dashboard.html'));
            } else {
                response.sendFile(path.join(publicPath, 'landing.html'));
            }
        }
    });
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
        console.log('║         NEURAL CARE PREMIUM - Complete Mental Health        ║');
        console.log('╠═══════════════════════════════════════════════════════════════╣');
        console.log(`║  🌐 Local:    http://localhost:${PORT}                            ║`);
        console.log(`║  📱 Network:  http://${localIP}:${PORT}                           ║`);
        console.log('║  👨‍⚕️ Doctors:  Premium Access (₹1999/year)                      ║');
        console.log('║  👤 Patients:  Free + Paid Consultations                        ║');
        console.log('║  👑 Admin:    Complete Control                                  ║');
        console.log('║  🤖 AI:       Fine-tuned + Local + Fallback                    ║');
        console.log(`║  📧 Email:    ${emailTransporter ? '✅ Configured' : '⚠️ Not configured'}                                ║`);
        console.log(`║  💾 Database: ${databaseInstance ? '✅ MongoDB' : '⚠️ In-Memory'}                                    ║`);
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('✨ Forgot Password Flow Enabled:');
        console.log('   • Send OTP to email for password reset');
        console.log('   • 10-minute OTP expiry');
        console.log('   • Max 5 attempts per OTP');
        console.log('   • Works for patients, doctors, and admins');
        console.log('');
        console.log('✨ Email Verification Enabled:');
        console.log('   • OTP sent to email for verification');
        console.log('   • 10-minute OTP expiry');
        console.log('   • Max 5 attempts per OTP');
        console.log('   • Verified emails required for registration');
        console.log('');
        console.log('✨ Login Attempt Protection:');
        console.log('   • Max 5 failed attempts per hour');
        console.log('   • Automatic reset after successful login');
        console.log('   • Clear attempts after 1 hour');
        console.log('');
        console.log('✨ Features Enabled:');
        console.log('   • Patient Registration (Free) with Email Verification');
        console.log('   • Doctor Registration with QR Payment (₹1999/year)');
        console.log('   • Admin Verification with Transaction ID Check');
        console.log('   • Email notifications for all activities');
        console.log('   • Multi-role authentication (Patient/Doctor/Admin)');
        console.log('   • Patient-doctor consultations');
        console.log('   • AI-powered chat with crisis detection');
        console.log('   • Admin dashboard with full control');
        console.log('   • Mood tracking, Journal, Medications, Routines');
        console.log('   • Clinic reports management');
        console.log('');
        console.log('📧 Test Admin Login:');
        console.log(`   Email: ${process.env.ADMIN_EMAIL || 'admin@neuralcare.com'}`);
        console.log(`   Password: ${process.env.ADMIN_PASSWORD || 'Admin@123'}`);
    });
});