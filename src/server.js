import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import GeminiBrowser from './gemini-browser.js';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5666;

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

// Helper to save agent conversation URL
async function saveAgentUrl(roomId, accountId) {
    try {
        const browser = await getBrowser();
        const url = await browser.getCurrentUrl(accountId);
        if (url && url.includes('gemini.google.com')) {
            db.saveAgentConversation(roomId, accountId, url);
        }
    } catch (e) {
        console.error(`Failed to save agent ${accountId} URL:`, e.message);
    }
}

// ============== Health & Status ==============

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

// ============== Room Management ==============

// List all rooms
app.get('/rooms', (req, res) => {
    try {
        const rooms = db.getRooms();
        res.json({ success: true, rooms });
    } catch (error) {
        console.error('Error listing rooms:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create a new room
app.post('/rooms', (req, res) => {
    try {
        const { name } = req.body;
        const room = db.createRoom(name);
        res.json({ success: true, room });
    } catch (error) {
        console.error('Error creating room:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get room details with messages
app.get('/rooms/:id', (req, res) => {
    try {
        const room = db.getRoomWithDetails(req.params.id);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        res.json({ success: true, room });
    } catch (error) {
        console.error('Error getting room:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a room
app.delete('/rooms/:id', (req, res) => {
    try {
        db.deleteRoom(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting room:', error);
        res.status(500).json({ error: error.message });
    }
});

// Restore a room (navigate agents to saved conversations)
app.post('/rooms/:id/restore', async (req, res) => {
    try {
        const room = db.getRoomWithDetails(req.params.id);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const browser = await getBrowser();
        const restored = [];

        for (const agent of room.agents) {
            if (agent.gemini_url) {
                try {
                    await browser.navigateToConversation(agent.agent_id, agent.gemini_url);
                    restored.push(agent.agent_id);
                } catch (e) {
                    console.error(`Failed to restore agent ${agent.agent_id}:`, e.message);
                }
            }
        }

        res.json({
            success: true,
            room,
            restored,
            message: `Restored ${restored.length} agent conversations`
        });
    } catch (error) {
        console.error('Error restoring room:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============== Chat ==============

// Send a message (with room tracking)
app.post('/chat', async (req, res) => {
    try {
        const { message, account = '0', roomId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const browser = await getBrowser();
        const response = await browser.sendMessage(message, account);

        // Save to database if room is specified
        if (roomId) {
            db.saveMessage(roomId, 'user', message, account);
            db.saveMessage(roomId, account, response);
            await saveAgentUrl(roomId, account);
        }

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

// ============== Discussion ==============

app.post('/discuss', async (req, res) => {
    try {
        const { question, rounds = 1, newChat = false, roomId } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        const browser = await getBrowser();
        const discussion = [];

        // Define roles for each participant
        const roles = [
            { account: '1', name: '专家A', role: '分析师 - 负责分析问题和提供初步思路' },
            { account: '2', name: '专家B', role: '评审员 - 负责评估和改进方案' },
            { account: '3', name: '专家C', role: '总结者 - 负责整合意见给出最终答案' }
        ];

        console.log(`\n🎯 开始协作讨论: "${question.substring(0, 50)}..."`);
        console.log(`📢 参与者: ${roles.map(r => r.name).join(', ')}`);
        console.log(`🔄 讨论轮数: ${rounds}`);
        console.log(`📝 新对话: ${newChat ? '是' : '否（继续当前对话）'}`);
        if (roomId) console.log(`🏠 聊天室: ${roomId}`);
        console.log('');

        // Save user question to database
        if (roomId) {
            db.saveMessage(roomId, 'user', question, 'all');
        }

        // Only start new chats if explicitly requested
        if (newChat) {
            for (const r of roles) {
                try {
                    await browser.startNewChat(r.account);
                } catch (e) {
                    console.log(`⚠️ 账号 ${r.account} 新对话失败，继续...`);
                }
            }
        }

        for (let round = 0; round < rounds; round++) {
            console.log(`\n--- 第 ${round + 1} 轮讨论 ---\n`);

            for (let i = 0; i < roles.length; i++) {
                const { account, name, role } = roles[i];
                let prompt;

                if (round === 0 && i === 0) {
                    prompt = `你是${name}(${role})。请就以下问题给出你的分析和见解：\n\n问题: ${question}\n\n请给出你的专业分析。`;
                } else if (i === roles.length - 1 && round === rounds - 1) {
                    const prevResponses = discussion.slice(-2).map(d => `${d.name}: ${d.response}`).join('\n\n');
                    prompt = `你是${name}(${role})。以下是其他专家的讨论：\n\n${prevResponses}\n\n原始问题是: ${question}\n\n请综合所有意见，给出最终的、可执行的答案。`;
                } else {
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

                    // Save agent response to database
                    if (roomId) {
                        db.saveMessage(roomId, account, response);
                        await saveAgentUrl(roomId, account);
                    }
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

// ============== Parallel Discussion V2 ==============

app.post('/discuss-v2', async (req, res) => {
    try {
        const { question, roomId } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        const browser = await getBrowser();
        const phases = [];
        const accounts = ['1', '2', '3'];

        console.log(`\n🚀 开始并行讨论 V2: "${question.substring(0, 50)}..."`);
        if (roomId) console.log(`🏠 聊天室: ${roomId}`);

        // Save user question
        if (roomId) {
            db.saveMessage(roomId, 'user', question, 'all');
        }

        // ========== Phase 1: Task Splitting (Serial) ==========
        console.log('\n📋 阶段1: 任务拆分...');
        const splitPrompt = `作为任务规划者，请将以下问题拆分成3个独立的子任务，每个子任务应该从不同角度分析问题。

问题: ${question}

请严格按以下JSON格式输出，不要有其他内容:
{
  "subtasks": [
    {"id": 1, "task": "子任务1的描述", "focus": "关注点1"},
    {"id": 2, "task": "子任务2的描述", "focus": "关注点2"},
    {"id": 3, "task": "子任务3的描述", "focus": "关注点3"}
  ]
}`;

        const splitResponse = await browser.sendMessage(splitPrompt, '1');
        console.log('✅ 任务拆分完成');

        let subtasks;
        try {
            // Extract JSON from response
            const jsonMatch = splitResponse.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
            if (jsonMatch) {
                subtasks = JSON.parse(jsonMatch[0]).subtasks;
            } else {
                // Fallback: create default subtasks
                subtasks = [
                    { id: 1, task: '从技术可行性角度分析', focus: '技术' },
                    { id: 2, task: '从实际应用角度分析', focus: '应用' },
                    { id: 3, task: '从潜在风险角度分析', focus: '风险' }
                ];
            }
        } catch (e) {
            console.log('⚠️ JSON解析失败，使用默认子任务');
            subtasks = [
                { id: 1, task: '从技术可行性角度分析', focus: '技术' },
                { id: 2, task: '从实际应用角度分析', focus: '应用' },
                { id: 3, task: '从潜在风险角度分析', focus: '风险' }
            ];
        }

        phases.push({
            phase: 1,
            name: '任务拆分',
            result: { subtasks, rawResponse: splitResponse }
        });

        if (roomId) {
            db.saveMessage(roomId, '1', `[任务拆分]\n${JSON.stringify(subtasks, null, 2)}`);
        }

        // ========== Phase 2: Parallel Execution ==========
        console.log('\n⚡ 阶段2: 并行执行子任务...');
        const startTime2 = Date.now();

        const executionPromises = subtasks.map((subtask, i) => {
            const account = accounts[i];
            const prompt = `你是专家${i + 1}，专注于"${subtask.focus}"方面。

原始问题: ${question}

你的子任务: ${subtask.task}

请针对你的子任务给出详细、专业的分析和建议。`;

            console.log(`   🎤 Agent ${account} 开始并行处理...`);
            return browser.sendMessage(prompt, account).then(response => {
                console.log(`   ✅ Agent ${account} 完成 (${response.length} 字)`);
                return { account, subtask, response };
            }).catch(e => {
                console.log(`   ❌ Agent ${account} 失败: ${e.message}`);
                return { account, subtask, response: `[执行失败: ${e.message}]` };
            });
        });

        const executionResults = await Promise.all(executionPromises);
        const elapsed2 = Date.now() - startTime2;
        console.log(`✅ 阶段2完成 (耗时 ${elapsed2}ms - 并行执行)`);

        phases.push({
            phase: 2,
            name: '并行执行',
            elapsed: elapsed2,
            results: executionResults
        });

        for (const result of executionResults) {
            if (roomId) {
                db.saveMessage(roomId, result.account, result.response);
                await saveAgentUrl(roomId, result.account);
            }
        }

        // ========== Phase 3: Parallel Cross-Review ==========
        console.log('\n🔍 阶段3: 并行交叉评审...');
        const startTime3 = Date.now();

        // Agent 1 reviews Agent 2's work, Agent 2 reviews Agent 3's, Agent 3 reviews Agent 1's
        const reviewAssignments = [
            { reviewer: '1', target: executionResults[1], targetAgent: '2' },
            { reviewer: '2', target: executionResults[2], targetAgent: '3' },
            { reviewer: '3', target: executionResults[0], targetAgent: '1' }
        ];

        const reviewPromises = reviewAssignments.map(assignment => {
            const prompt = `作为评审专家，请评估以下专家${assignment.targetAgent}的分析：

原始问题: ${question}

专家${assignment.targetAgent}的分析:
${assignment.target.response}

请从以下角度进行评审：
1. 分析的准确性和完整性
2. 是否有遗漏的重要观点
3. 具体的改进建议

请给出简洁的评审意见。`;

            console.log(`   🔍 Agent ${assignment.reviewer} 评审 Agent ${assignment.targetAgent}...`);
            return browser.sendMessage(prompt, assignment.reviewer).then(response => {
                console.log(`   ✅ Agent ${assignment.reviewer} 评审完成`);
                return { reviewer: assignment.reviewer, targetAgent: assignment.targetAgent, review: response };
            }).catch(e => {
                console.log(`   ❌ Agent ${assignment.reviewer} 评审失败`);
                return { reviewer: assignment.reviewer, targetAgent: assignment.targetAgent, review: `[评审失败: ${e.message}]` };
            });
        });

        const reviewResults = await Promise.all(reviewPromises);
        const elapsed3 = Date.now() - startTime3;
        console.log(`✅ 阶段3完成 (耗时 ${elapsed3}ms - 并行评审)`);

        phases.push({
            phase: 3,
            name: '交叉评审',
            elapsed: elapsed3,
            results: reviewResults
        });

        for (const result of reviewResults) {
            if (roomId) {
                db.saveMessage(roomId, result.reviewer, `[评审 Agent ${result.targetAgent}]\n${result.review}`);
            }
        }

        // ========== Phase 4: Summarization (Serial) ==========
        console.log('\n📝 阶段4: 综合汇总...');

        const executionSummary = executionResults.map(r =>
            `【专家${r.account}的分析】\n${r.response}`
        ).join('\n\n');

        const reviewSummary = reviewResults.map(r =>
            `【专家${r.reviewer}对专家${r.targetAgent}的评审】\n${r.review}`
        ).join('\n\n');

        const summaryPrompt = `作为总结专家，请综合以下所有分析和评审，给出一个完整、全面的最终答案。

原始问题: ${question}

== 各专家的分析 ==
${executionSummary}

== 交叉评审意见 ==
${reviewSummary}

请综合以上所有信息，给出：
1. 问题的完整答案
2. 关键要点总结
3. 实践建议`;

        const finalAnswer = await browser.sendMessage(summaryPrompt, '1');
        console.log('✅ 阶段4完成');

        phases.push({
            phase: 4,
            name: '综合汇总',
            result: finalAnswer
        });

        if (roomId) {
            db.saveMessage(roomId, '1', `[最终汇总]\n${finalAnswer}`);
        }

        console.log(`\n✅ 并行讨论完成！共4个阶段`);
        console.log(`   阶段2耗时: ${elapsed2}ms (并行执行)`);
        console.log(`   阶段3耗时: ${elapsed3}ms (并行评审)`);

        res.json({
            success: true,
            question,
            phases,
            finalAnswer,
            timing: {
                phase2: elapsed2,
                phase3: elapsed3,
                total: elapsed2 + elapsed3
            }
        });
    } catch (error) {
        console.error('Discuss V2 error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============== Graceful Shutdown ==============

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (gemini) {
        await gemini.close();
    }
    db.closeDatabase();
    process.exit(0);
});

// ============== Start Server ==============

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
   POST /chat        - 发送消息 { message, account, roomId? }
   POST /new-chat    - 新对话 { account }
   POST /discuss     - 专家讨论 { question, rounds?, roomId? }
   POST /discuss-v2  - 并行讨论 { question, roomId? }
   GET  /rooms       - 聊天室列表
   POST /rooms       - 创建聊天室 { name? }
   GET  /rooms/:id   - 聊天室详情
   POST /rooms/:id/restore - 恢复聊天室
   GET  /health      - 服务状态
`);
});
