const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function resetAdmin() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    if (!uri) {
        console.log('❌ No MongoDB URI found in .env file');
        return;
    }

    const client = new MongoClient(uri);
    
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');
        
        const db = client.db();
        
        // 1. Delete existing admin
        const deleteResult = await db.collection('admins').deleteOne({ 
            email: 'admin@neuralcare.com' 
        });
        console.log(`✅ Deleted ${deleteResult.deletedCount} existing admin`);
        
        // 2. Delete any sessions for admin
        await db.collection('sessions').deleteMany({});
        console.log('✅ Cleared all sessions');
        
        // 3. Create new admin with fresh password
        const hashedPassword = await bcrypt.hash('Admin@123', 10);
        
        const newAdmin = {
            email: 'admin@neuralcare.com',
            password: hashedPassword,
            name: 'Super Admin',
            role: 'super_admin',
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        const insertResult = await db.collection('admins').insertOne(newAdmin);
        console.log('✅ New admin created with ID:', insertResult.insertedId);
        
        // 4. Verify the admin was created
        const admin = await db.collection('admins').findOne({ 
            email: 'admin@neuralcare.com' 
        });
        
        if (admin) {
            console.log('\n✅ Admin reset successfully!');
            console.log('📧 Email: admin@neuralcare.com');
            console.log('🔑 Password: Admin@123');
            console.log('⚠️  Please change this password after first login');
        } else {
            console.log('❌ Failed to create admin');
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await client.close();
    }
}

resetAdmin();