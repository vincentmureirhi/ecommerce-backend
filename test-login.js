const axios = require('axios');

async function testLogin() {
  try {
    console.log('🔐 Testing SuperUser login...\n');

    const response = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'superadmin@lazarous.com',
      password: 'SuperAdmin@2025#Lazarous',
    });

    console.log('✅ Login Response:');
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.success) {
      const token = response.data.data.token;
      const user = response.data.data.user;

      console.log('\n📋 User Info:');
      console.log(`   Email: ${user.email}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Token: ${token.substring(0, 20)}...`);

      // Test token verification
      console.log('\n🔍 Verifying token...');
      const verifyResponse = await axios.post('http://localhost:5000/api/auth/verify-token', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });

      console.log('✅ Token verified!');
      console.log(JSON.stringify(verifyResponse.data, null, 2));
    }
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
}

testLogin();