import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import GeminiBrowser from './gemini-browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files (mobile web UI)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Single shared browser instance
let gemini = null;

async function getBrowser() {
    if (!gemini) {
        gemini = new GeminiBrowser();
        await gemini.connect();
    }
    return gemini;
}

// Health check
app.get('/health', async (req, res) => {
    try {
        const browser = await getBrowser();
        res.json({
            status: 'ok',
            connected: browser.isConnected,
            activeAccounts: browser.getActiveAccounts(),
            availableAccounts: GeminiBrowser.getAccounts(),
        });
    } catch (e) {
        res.json({
            status: 'error',
            error: e.message,
            availableAccounts: GeminiBrowser.getAccounts(),
        });
    }
});

// List accounts
app.get('/accounts', async (req, res) => {
    try {
        const browser = await getBrowser();
        res.json({
            available: GeminiBrowser.getAccounts(),
            active: browser.getActiveAccounts(),
        });
    } catch (e) {
        res.json({
            available: GeminiBrowser.getAccounts(),
            active: [],
            error: e.message,
        });
    }
});

// Send a message
app.post('/chat', async (req, res) => {
    try {
        const { message, account = '0' } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const browser = await getBrowser();
        const response = await browser.sendMessage(message, account);

        res.json({
            success: true,
            account,
            message,
            response,
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start a new chat
app.post('/new-chat', async (req, res) => {
    try {
        const { account = '0' } = req.body;

        const browser = await getBrowser();
        await browser.startNewChat(account);

        res.json({ success: true, message: 'New chat started', account });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Multi-account collaborative discussion
app.post('/discuss', async (req, res) => {
    try {
        const { question, rounds = 1 } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        const browser = await getBrowser();
        const discussion = [];

        // Define roles for each participant
        const roles = [
            { account: '0', name: '专家A', role: '分析师 - 负责分析问题和提供初步思路' },
            { account: '1', name: '专家B', role: '评审员 - 负责评估和改进方案' },
            { account: '2', name: '专家C', role: '总结者 - 负责整合意见给出最终答案' }
        ];

        console.log(`\n🎯 开始协作讨论: "${question.substring(0, 50)}..."`);
        console.log(`📢 参与者: ${roles.map(r => r.name).join(', ')}`);
        console.log(`🔄 讨论轮数: ${rounds}\n`);

        // Start new chats for all accounts
        for (const r of roles) {
            try {
                await browser.startNewChat(r.account);
            } catch (e) {
                console.log(`⚠️ 账号 ${r.account} 新对话失败，继续...`);
            }
        }

        for (let round = 0; round < rounds; round++) {
            console.log(`\n--- 第 ${round + 1} 轮讨论 ---\n`);

            for (let i = 0; i < roles.length; i++) {
                const { account, name, role } = roles[i];
                let prompt;

                if (round === 0 && i === 0) {
                    // First message - ask the question
                    prompt = `你是${name}(${role})。请就以下问题给出你的分析和见解：\n\n问题: ${question}\n\n请给出你的专业分析。`;
                } else if (i === roles.length - 1 && round === rounds - 1) {
                    // Last expert in last round - summarize
                    const prevResponses = discussion.slice(-2).map(d => `${d.name}: ${d.response}`).join('\n\n');
                    prompt = `你是${name}(${role})。以下是其他专家的讨论：\n\n${prevResponses}\n\n原始问题是: ${question}\n\n请综合所有意见，给出最终的、可执行的答案。`;
                } else {
                    // Middle experts - continue discussion
                    const lastResponse = discussion[discussion.length - 1];
                    prompt = `你是${name}(${role})。\n\n原始问题: ${question}\n\n上一位专家(${lastResponse.name})的观点:\n${lastResponse.response}\n\n请评估这个观点，提出改进建议或补充你的专业见解。`;
                }

                console.log(`🎤 ${name} 发言中...`);

                try {
                    const response = await browser.sendMessage(prompt, account);
                    discussion.push({
                        round: round + 1,
                        account,
                        name,
                        role,
                        response
                    });
                    console.log(`✅ ${name} 完成 (${response.length} 字)`);
                } catch (e) {
                    console.log(`❌ ${name} 发言失败: ${e.message}`);
                    discussion.push({
                        round: round + 1,
                        account,
                        name,
                        role,
                        response: `[发言失败: ${e.message}]`
                    });
                }
            }
        }

        console.log(`\n✅ 讨论完成！共 ${discussion.length} 条发言\n`);

        // Get final answer (last response)
        const finalAnswer = discussion[discussion.length - 1]?.response || '';

        res.json({
            success: true,
            question,
            rounds,
            discussion,
            finalAnswer,
            summary: `${roles.length} 位专家讨论了 ${rounds} 轮`
        });
    } catch (error) {
        console.error('Discussion error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (gemini) {
        await gemini.close();
    }
    process.exit(0);
});

// Start server
const localIP = getLocalIP();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║          Gemini Browser API Server                     ║
╠════════════════════════════════════════════════════════╣
║  Local:    http://localhost:${PORT}                       ║
║  Network:  http://${localIP}:${PORT}                    ║
╚════════════════════════════════════════════════════════╝

📱 手机访问: http://${localIP}:${PORT}

📚 API:
   POST /chat        - 发送消息 { message, account: "0"|"1"|"2" }
   POST /new-chat    - 新对话 { account: "0"|"1"|"2" }
   GET  /accounts    - 查看账号列表
   GET  /health      - 服务状态
`);
});
