import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');

class GeminiBrowser {
    constructor() {
        this.browser = null;
        this.context = null;
        this.accounts = new Map(); // accountId -> { page, isReady }
        this.isConnected = false;
    }

    static getAccounts() {
        // Return available account IDs (0, 1, 2, etc.)
        return ['0', '1', '2'];
    }

    async connect() {
        if (this.isConnected) return;

        console.log('🚀 Connecting to Chrome browser...');

        try {
            this.browser = await chromium.connectOverCDP('http://localhost:9222');
            console.log('✅ Connected to Chrome');

            const contexts = this.browser.contexts();
            if (contexts.length === 0) {
                throw new Error('No browser contexts found');
            }
            this.context = contexts[0];
            this.isConnected = true;

            // Find existing Gemini pages
            await this.discoverExistingPages();

        } catch (error) {
            console.error('❌ Failed to connect to Chrome.');
            console.error('   Make sure Chrome is running with: --remote-debugging-port=9222');
            throw error;
        }
    }

    async discoverExistingPages() {
        const pages = this.context.pages();
        for (const page of pages) {
            const url = page.url();
            // Match gemini.google.com/u/X/app patterns
            const match = url.match(/gemini\.google\.com\/u\/(\d+)/);
            if (match) {
                const accountId = match[1];
                console.log(`📄 Found existing page for account ${accountId}`);
                this.accounts.set(accountId, { page, isReady: true });
            } else if (url.includes('gemini.google.com/app')) {
                // Default account (no /u/X)
                console.log('📄 Found existing page for default account (0)');
                this.accounts.set('0', { page, isReady: true });
            }
        }
    }

    async getAccountPage(accountId = '0') {
        if (!this.isConnected) {
            await this.connect();
        }

        // Check if we already have this account's page
        if (this.accounts.has(accountId)) {
            const account = this.accounts.get(accountId);
            if (account.isReady) {
                return account.page;
            }
        }

        // Create new page for this account
        console.log(`📄 Opening Gemini for account ${accountId}...`);
        const page = await this.context.newPage();

        // Use /u/X URL for multi-account support
        const url = accountId === '0'
            ? 'https://gemini.google.com/app'
            : `https://gemini.google.com/u/${accountId}/app`;

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await page.waitForTimeout(3000);

        // Wait for input to be ready
        await this.waitForReady(page);

        this.accounts.set(accountId, { page, isReady: true });
        console.log(`✅ Account ${accountId} is ready!`);

        return page;
    }

    async waitForReady(page) {
        const selectors = [
            'div[contenteditable="true"]',
            'rich-textarea',
            '[aria-label="Enter a prompt here"]',
        ];

        for (const selector of selectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                console.log(`✅ Found input with selector: ${selector}`);
                return;
            } catch (e) {
                // Try next
            }
        }

        throw new Error('Could not find prompt input');
    }

    async dismissOverlays(page) {
        // Check for and dismiss common overlays or popups
        const overlaySelectors = [
            'button[aria-label="No thanks"], button:has-text("No thanks")', // "No thanks" button for various popups
            'button[aria-label="Close"], button[aria-label="关闭"]', // Generic close buttons
            '.modal-dialog button[aria-label="Close"]', // Modal close buttons
            'div[role="dialog"] button:has-text("No thanks")', // Dialog with "No thanks"
            'div[role="dialog"] button:has-text("Got it")', // Dialog with "Got it"
            'div[role="dialog"] button:has-text("Continue")', // Dialog with "Continue"
        ];

        for (const selector of overlaySelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
                    console.log(`Closing overlay with selector: ${selector}`);
                    await button.click({ timeout: 1000, force: true });
                    await page.waitForTimeout(500); // Give it a moment to disappear
                }
            } catch (e) {
                // Ignore errors, element might not be present or clickable
            }
        }
    }

    async sendMessage(message, accountId = '0') {
        const page = await this.getAccountPage(accountId);

        console.log(`📤 [Account ${accountId}] Sending: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);

        // Close any overlays/popups that might block input
        await this.dismissOverlays(page);

        // Find the input field
        const inputSelector = 'rich-textarea div[contenteditable="true"], div[contenteditable="true"]';
        const input = await page.$(inputSelector);

        if (!input) {
            throw new Error('Could not find input field');
        }

        // Use force click to bypass any remaining overlays
        await input.click({ force: true });
        await page.keyboard.press('Meta+a'); // Select all
        await page.keyboard.press('Backspace'); // Delete
        await page.waitForTimeout(100);

        // Use clipboard to paste (fast and reliable)
        await page.evaluate(async (text) => {
            await navigator.clipboard.writeText(text);
        }, message);

        await page.keyboard.press('Meta+v'); // Paste
        await page.waitForTimeout(500);

        // Send message
        const sendButton = await page.$('button[aria-label="Send message"], button[aria-label="发送"]');
        if (sendButton) {
            const isEnabled = await sendButton.evaluate(btn => !btn.disabled);
            if (isEnabled) {
                await sendButton.click();
            } else {
                // Wait a bit more for the button to enable
                await page.waitForTimeout(300);
                await sendButton.click();
            }
        } else {
            await page.keyboard.press('Enter');
        }

        // Wait for response
        const response = await this.waitForResponse(page);
        console.log(`📥 [Account ${accountId}] Response received (${response.length} chars)`);

        return response;
    }

    async waitForResponse(page) {
        console.log('⏳ Waiting for response...');

        // Initial wait for response to start generating
        await page.waitForTimeout(3000);

        const maxWait = 180000; // 3 minutes max
        const startTime = Date.now();
        let lastTextLength = 0;
        let stableCount = 0;

        while (Date.now() - startTime < maxWait) {
            // Multiple methods to detect if still generating

            // Method 1: Check for stop button (response still generating)
            const stopButton = await page.$('button[aria-label="Stop response"], button[aria-label="停止回复"], button[aria-label="停止生成"]');
            if (stopButton) {
                stableCount = 0;
                await page.waitForTimeout(1000);
                continue;
            }

            // Method 2: Check for loading indicators
            const loading = await page.$('.loading, .thinking, [data-is-streaming="true"]');
            if (loading) {
                stableCount = 0;
                await page.waitForTimeout(1000);
                continue;
            }

            // Method 3: Check if text content is stable
            const currentText = await this.extractLastResponse(page);

            if (currentText.length > 0 && currentText.length === lastTextLength) {
                stableCount++;
                // Increased stability requirement: 5 checks (2.5 seconds of stable text)
                if (stableCount >= 5) {
                    console.log('✅ Response complete');
                    break;
                }
            } else {
                stableCount = 0;
                lastTextLength = currentText.length;
            }

            await page.waitForTimeout(500);
        }

        // Extra wait to ensure rendering is complete
        await page.waitForTimeout(2000);

        return await this.extractLastResponse(page);
    }

    async extractLastResponse(page) {
        // Try multiple selector strategies
        const strategies = [
            // Strategy 1: Direct message content selector
            async () => {
                const elements = await page.$$('message-content');
                if (elements.length > 0) {
                    const text = await elements[elements.length - 1].innerText();
                    return text?.trim() || '';
                }
                return '';
            },
            // Strategy 2: Model response role
            async () => {
                const elements = await page.$$('[data-message-author-role="model"]');
                if (elements.length > 0) {
                    const text = await elements[elements.length - 1].innerText();
                    return text?.trim() || '';
                }
                return '';
            },
            // Strategy 3: Look for markdown rendered content
            async () => {
                const elements = await page.$$('.markdown-main-panel, .response-container, .model-response');
                if (elements.length > 0) {
                    const text = await elements[elements.length - 1].innerText();
                    return text?.trim() || '';
                }
                return '';
            },
            // Strategy 4: Get all text from conversation area
            async () => {
                const container = await page.$('.conversation-container, [role="main"]');
                if (container) {
                    const allMessages = await container.$$('[data-message-author-role="model"]');
                    if (allMessages.length > 0) {
                        const text = await allMessages[allMessages.length - 1].innerText();
                        return text?.trim() || '';
                    }
                }
                return '';
            }
        ];

        for (const strategy of strategies) {
            try {
                const text = await strategy();
                if (text && text.length > 10 && !text.includes('你已让系统停止')) {
                    return text;
                }
            } catch (e) {
                // Try next strategy
            }
        }

        return '[响应提取失败]';
    }

    async startNewChat(accountId = '0') {
        const page = await this.getAccountPage(accountId);

        console.log(`🔄 [Account ${accountId}] Starting new chat...`);

        const url = accountId === '0'
            ? 'https://gemini.google.com/app'
            : `https://gemini.google.com/u/${accountId}/app`;

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await page.waitForTimeout(3000);
        await this.waitForReady(page);

        console.log(`✅ [Account ${accountId}] New chat ready`);
    }

    getActiveAccounts() {
        return Array.from(this.accounts.keys());
    }

    async close() {
        this.accounts.clear();
        this.isConnected = false;
        // Don't close the browser - user's Chrome should stay open
    }
}

export default GeminiBrowser;
