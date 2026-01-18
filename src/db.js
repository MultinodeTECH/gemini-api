import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'gemini.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
    -- Chat rooms table
    CREATE TABLE IF NOT EXISTS chat_rooms (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent conversations table (each agent's Gemini conversation in a room)
    CREATE TABLE IF NOT EXISTS agent_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        gemini_url TEXT,
        gemini_conv_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
        UNIQUE(room_id, agent_id)
    );

    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        target TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
    );

    -- Create indexes for faster queries
    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_agent_conversations_room_id ON agent_conversations(room_id);
`);

console.log('📦 Database initialized: data/gemini.db');

// ============== Chat Room Operations ==============

export function createRoom(name = null) {
    const id = randomUUID();
    const roomName = name || `聊天室 ${new Date().toLocaleString('zh-CN')}`;

    const stmt = db.prepare(`
        INSERT INTO chat_rooms (id, name) VALUES (?, ?)
    `);
    stmt.run(id, roomName);

    console.log(`📝 Created room: ${id} (${roomName})`);
    return { id, name: roomName, created_at: new Date().toISOString() };
}

export function getRooms() {
    const stmt = db.prepare(`
        SELECT r.*, 
               (SELECT COUNT(*) FROM messages WHERE room_id = r.id) as message_count
        FROM chat_rooms r 
        ORDER BY r.updated_at DESC
    `);
    return stmt.all();
}

export function getRoom(roomId) {
    const stmt = db.prepare(`SELECT * FROM chat_rooms WHERE id = ?`);
    return stmt.get(roomId);
}

export function updateRoomTimestamp(roomId) {
    const stmt = db.prepare(`
        UPDATE chat_rooms SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(roomId);
}

export function deleteRoom(roomId) {
    const stmt = db.prepare(`DELETE FROM chat_rooms WHERE id = ?`);
    stmt.run(roomId);
    console.log(`🗑️ Deleted room: ${roomId}`);
}

// ============== Agent Conversation Operations ==============

export function saveAgentConversation(roomId, agentId, geminiUrl) {
    // Extract conversation ID from URL
    const match = geminiUrl.match(/\/app\/([a-zA-Z0-9]+)/);
    const geminiConvId = match ? match[1] : null;

    const stmt = db.prepare(`
        INSERT INTO agent_conversations (room_id, agent_id, gemini_url, gemini_conv_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id, agent_id) DO UPDATE SET
            gemini_url = excluded.gemini_url,
            gemini_conv_id = excluded.gemini_conv_id,
            updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(roomId, agentId, geminiUrl, geminiConvId);

    console.log(`💾 Saved agent ${agentId} conversation: ${geminiConvId}`);
}

export function getAgentConversations(roomId) {
    const stmt = db.prepare(`
        SELECT * FROM agent_conversations WHERE room_id = ?
    `);
    return stmt.all(roomId);
}

export function getAgentConversation(roomId, agentId) {
    const stmt = db.prepare(`
        SELECT * FROM agent_conversations WHERE room_id = ? AND agent_id = ?
    `);
    return stmt.get(roomId, agentId);
}

// ============== Message Operations ==============

export function saveMessage(roomId, sender, content, target = null) {
    const stmt = db.prepare(`
        INSERT INTO messages (room_id, sender, content, target)
        VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(roomId, sender, content, target);

    // Update room timestamp
    updateRoomTimestamp(roomId);

    return result.lastInsertRowid;
}

export function getMessages(roomId, limit = 100) {
    const stmt = db.prepare(`
        SELECT * FROM messages 
        WHERE room_id = ? 
        ORDER BY created_at ASC
        LIMIT ?
    `);
    return stmt.all(roomId, limit);
}

export function getRoomWithDetails(roomId) {
    const room = getRoom(roomId);
    if (!room) return null;

    return {
        ...room,
        agents: getAgentConversations(roomId),
        messages: getMessages(roomId)
    };
}

// ============== Cleanup ==============

export function closeDatabase() {
    db.close();
    console.log('📦 Database connection closed');
}

export default {
    createRoom,
    getRooms,
    getRoom,
    deleteRoom,
    saveAgentConversation,
    getAgentConversations,
    getAgentConversation,
    saveMessage,
    getMessages,
    getRoomWithDetails,
    closeDatabase
};
