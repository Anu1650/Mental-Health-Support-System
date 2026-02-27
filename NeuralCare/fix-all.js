const { MongoClient } = require('mongodb');
require('dotenv').config();

async function fixAll() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const client = new MongoClient(uri);
    
    try {
        await client.connect();
        const db = client.db();
        console.log('🔧 Fixing database indexes...');
        
        // Fix OTP index
        try {
            await db.collection('otps').dropIndex('email_1');
            console.log('✅ Fixed OTP index');
        } catch (e) {
            console.log('✅ OTP index already fixed');
        }
        
        // Fix Sessions index
        try {
            await db.collection('sessions').dropIndex('token_1');
            console.log('✅ Fixed Sessions index');
        } catch (e) {
            console.log('✅ Sessions index already fixed');
        }
        
        // Recreate both indexes with correct settings
        await db.collection('otps').createIndex({ email: 1 }, { expireAfterSeconds: 1800 });
        await db.collection('sessions').createIndex({ token: 1 }, { expireAfterSeconds: 86400 });
        
        console.log('🎉 All indexes fixed! You can now restart your server.');
        
    } catch (error) {
        console.log('Error:', error);
    } finally {
        await client.close();
    }
}

fixAll();