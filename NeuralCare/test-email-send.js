const nodemailer = require('nodemailer');
require('dotenv').config();

async function testEmailSend() {
    console.log('📧 Testing email send functionality...');
    console.log('=================================');
    console.log('EMAIL_USER:', process.env.EMAIL_USER);
    console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? '✅ Set' : '❌ Not set');
    console.log('EMAIL_FROM:', process.env.EMAIL_FROM || 'Not set (will use default)');
    console.log('=================================\n');

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log('❌ Email credentials not found in .env file');
        return;
    }

    // Create transporter
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { 
            user: process.env.EMAIL_USER, 
            pass: process.env.EMAIL_PASS 
        }
    });

    try {
        // Verify transporter
        console.log('🔍 Verifying email transporter...');
        await transporter.verify();
        console.log('✅ Email transporter verified successfully\n');

        // Send a test email
        console.log('📤 Sending test email...');
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM || '"NeuralCare" <noreply@neuralcare.com>',
            to: process.env.EMAIL_USER, // Send to yourself
            subject: '🔐 NeuralCare - Test Email',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
                        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
                        .header { text-align: center; margin-bottom: 25px; }
                        .logo { font-size: 48px; margin-bottom: 10px; }
                        h1 { color: #6366f1; font-size: 28px; margin: 0; }
                        .success-box { background: #d1fae5; border: 1px solid #a7f3d0; color: #059669; padding: 20px; border-radius: 12px; margin: 25px 0; text-align: center; }
                        .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 12px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="logo">🧠</div>
                            <h1>NeuralCare</h1>
                        </div>
                        <div class="success-box">
                            <h2>✅ Test Email Successful!</h2>
                            <p>Your email configuration is working correctly.</p>
                        </div>
                        <p style="color: #4b5563;">If you received this email, your NeuralCare application can now send:</p>
                        <ul style="color: #4b5563;">
                            <li>OTP verification emails</li>
                            <li>Password reset emails</li>
                            <li>Welcome emails</li>
                            <li>Login notifications</li>
                        </ul>
                        <div class="footer">
                            <p>This is a test email from NeuralCare.</p>
                            <p>© ${new Date().getFullYear()} NeuralCare. All rights reserved.</p>
                        </div>
                    </div>
                </body>
                </html>
            `,
            text: 'Test email from NeuralCare. If you received this, your email configuration is working!'
        });

        console.log('✅ Test email sent successfully!');
        console.log('📧 Message ID:', info.messageId);
        console.log('📨 Sent to:', process.env.EMAIL_USER);
        console.log('\n🎉 Email configuration is working! Your forgot password emails should now send.');
        
    } catch (error) {
        console.error('\n❌ Email error:', error.message);
        
        if (error.message.includes('Invalid login')) {
            console.log('\n🔧 Fix: You need to use an "App Password" for Gmail:');
            console.log('   1. Go to https://myaccount.google.com/security');
            console.log('   2. Enable 2-Factor Authentication');
            console.log('   3. Go to "App Passwords"');
            console.log('   4. Generate a new app password for "Mail"');
            console.log('   5. Use that 16-character password in your .env file');
        } else if (error.message.includes('connect ETIMEDOUT')) {
            console.log('\n🔧 Fix: Check your internet connection');
        } else if (error.message.includes('No recipients defined')) {
            console.log('\n🔧 Fix: The "to" email address is missing');
        }
    }
}

testEmailSend();