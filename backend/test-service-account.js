#!/usr/bin/env node

/**
 * Test script to verify Google Cloud service account authentication
 * Run with: node test-service-account.js
 */

import 'dotenv/config';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';

async function testServiceAccount() {
  console.log('🔍 Testing Google Cloud Service Account Authentication\n');

  try {
    // Test 1: Check environment variables
    console.log('1️⃣  Checking environment variables...');
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('   ✅ GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.log('   ✅ GOOGLE_APPLICATION_CREDENTIALS_JSON: [JSON string detected]');
    } else {
      throw new Error('No Google Cloud credentials found in environment');
    }

    // Test 2: Initialize Storage client
    console.log('\n2️⃣  Initializing Google Cloud Storage client...');
    const storage = new Storage();
    console.log('   ✅ Storage client initialized');

    // Test 3: Initialize Auth client
    console.log('\n3️⃣  Initializing Google Auth client...');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const projectId = await auth.getProjectId();
    console.log('   ✅ Auth client initialized');
    console.log('   📋 Project ID:', projectId);

    // Test 4: Get access token
    console.log('\n4️⃣  Obtaining access token...');
    const accessToken = await client.getAccessToken();
    if (accessToken.token) {
      console.log('   ✅ Access token obtained');
      console.log('   🔑 Token preview:', accessToken.token.substring(0, 30) + '...');
    } else {
      throw new Error('Failed to obtain access token');
    }

    // Test 5: Test bucket write access (most important for our use case)
    const bucketName = process.env.GCS_BUCKET_NAME || 'itaytevel-hearandthere';
    console.log('\n5️⃣  Testing bucket write access:', bucketName);
    const bucket = storage.bucket(bucketName);

    try {
      // Try to upload a test file
      const testFileName = `test-${Date.now()}.txt`;
      const file = bucket.file(testFileName);
      await file.save('Test file from service account authentication', {
        metadata: {
          contentType: 'text/plain',
        },
      });
      console.log('   ✅ Successfully uploaded test file');

      // Clean up test file
      await file.delete();
      console.log('   ✅ Successfully deleted test file');
      console.log('   ✅ Bucket write access confirmed!');
    } catch (err) {
      console.log('   ⚠️  Bucket write test failed:', err.message);
      throw err;
    }

    console.log('\n🎉 All tests passed! Service account authentication is working correctly.\n');
    console.log('✨ You can now:');
    console.log('   1. Use this service account for TTS API calls');
    console.log('   2. Upload audio files to Google Cloud Storage');
    console.log('   3. Deploy to Railway with GOOGLE_APPLICATION_CREDENTIALS_JSON\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Make sure .env file has GOOGLE_APPLICATION_CREDENTIALS set');
    console.error('   2. Verify the JSON file exists at the specified path');
    console.error('   3. Check that the service account has the correct permissions');
    console.error('   4. Ensure Text-to-Speech API and Cloud Storage API are enabled\n');
    process.exit(1);
  }
}

testServiceAccount();

