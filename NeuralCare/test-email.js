const nodemailer = require('nodemailer');
require('dotenv').config();

async function testEmail() {
    console.log('Testing email configuration...');
    console.log('EMAIL_USER:', process.env.EMAIL_USER);
    console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? '✅ Set' : '❌ Not set');
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log('❌ Email credentials not found in .env file');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        }
    });

    try {
        await transporter.verify();
        console.log('✅ Email transporter verified successfully');

        // Send a test email
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
            to: process.env.EMAIL_USER, // Send to yourself for testing
            subject: '🔐 NeuralCare Test Email',
            html: '<h1>Test Email</h1><p>If you receive this, your email configuration is working!</p>'
        });

        console.log('✅ Test email sent:', info.messageId);
    } catch (error) {
        console.error('❌ Email error:', error.message);
    }
}

testEmail();