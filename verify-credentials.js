require('dotenv').config();

console.log('='.repeat(50));
console.log('M-PESA CREDENTIAL VERIFICATION');
console.log('='.repeat(50));

console.log('\n📋 Environment Variables:');
console.log('MPESA_ENVIRONMENT:', process.env.MPESA_ENVIRONMENT);
console.log('MPESA_BUSINESS_SHORTCODE:', process.env.MPESA_BUSINESS_SHORTCODE);
console.log('MPESA_CALLBACK_URL:', process.env.MPESA_CALLBACK_URL);

console.log('\n🔑 Key Lengths (should NOT be 0):');
console.log('MPESA_CONSUMER_KEY length:', process.env.MPESA_CONSUMER_KEY?.length || 0);
console.log('MPESA_CONSUMER_SECRET length:', process.env.MPESA_CONSUMER_SECRET?.length || 0);
console.log('MPESA_PASSKEY length:', process.env.MPESA_PASSKEY?.length || 0);

console.log('\n✅ First 10 chars of each (for verification):');
console.log('CONSUMER_KEY:', process.env.MPESA_CONSUMER_KEY?.substring(0, 10) + '...');
console.log('CONSUMER_SECRET:', process.env.MPESA_CONSUMER_SECRET?.substring(0, 10) + '...');
console.log('PASSKEY:', process.env.MPESA_PASSKEY?.substring(0, 10) + '...');

console.log('\n' + '='.repeat(50));
