import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');

// Parse command line arguments
function getProfileName() {
    const args = process.argv.slice(2);
    for (const arg of args) {
        if (arg.startsWith('--profile=')) {
            return arg.split('=')[1];
        }
    }
    return 'default';
}

async function saveAuth() {
    const profileName = getProfileName();
    const authFile = path.join(AUTH_DIR, `${profileName}.json`);

    console.log(`🚀 Opening browser for profile: ${profileName}`);
    console.log('📝 Please log in to your Google account in the browser window.\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100,
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to Gemini
    await page.goto('https://gemini.google.com/app');

    console.log('⏳ Waiting for you to complete login...');
    console.log('   (The script will detect when you reach the chat interface)\n');

    // Wait for the user to log in - look for the prompt input
    const inputSelectors = [
        'div[contenteditable="true"]',
        'rich-textarea',
        '[aria-label="Enter a prompt here"]',
    ];

    try {
        await page.waitForFunction(
            (selectors) => selectors.some(s => document.querySelector(s)),
            inputSelectors,
            { timeout: 300000 } // 5 minutes to log in
        );

        console.log('✅ Login detected!');

        // Create auth directory if needed
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        // Save the authentication state
        await context.storageState({ path: authFile });

        console.log(`✅ Authentication saved for profile "${profileName}"`);
        console.log(`   File: ${authFile}`);
        console.log('\n🎉 You can now run: npm start');
        console.log(`   Then use: curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"Hello","profile":"${profileName}"}'`);

    } catch (error) {
        console.error('❌ Login timed out or failed:', error.message);
    } finally {
        await browser.close();
    }
}

saveAuth().catch(console.error);
