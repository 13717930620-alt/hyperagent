// CheckpointManager - persistent execution state manager
const fs = require('fs');
const path = require('path');

class CheckpointManager {
    constructor(options = {}) {
        this.stateManager = options.stateManager || null;
        this.storageDir = options.storageDir || 'checkpoints';
        this.maxCheckpoints = options.maxCheckpoints || 50;
        this.autoCompactThreshold = options.autoCompactThreshold || 20;
        this.enabled = options.enabled !== false;

        // 当前活跃的检查点链 (同一任务的所有检查点)
        this._activeTaskChain = [];
        this._taskIndex = new Map(); // taskGoal -> [{id, timestamp, step}]

        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // 启动时恢复索引
        this._recoverIndex();
    }

    // ============================================
    // Public API
    // ============================================

    /**
     * Save execution checkpoint
     */
    async save(executionContext) {
        if (!this.enabled) return null;

        const {
            goal,                // 任务目标
            status,              // 执行状态
            subtasks = [],       // 子任务列表
            completedSubtasks = [], // 已完成子任务
            currentTask = null,  // 当前执行中的子任务
            progress = null,     // 进度 "3/5"
            messages = [],       // LLM 消息历史
            toolState = {},      // 工具循环状态
            metadata = {}        // 额外元数据
        } = executionContext;

        const checkpoint = {
            id: `ckpt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            version: '5.0',
            timestamp: new Date().toISOString(),

            // 任务状态
            goal: typeof goal === 'string' ? goal.substring(0, 500) : JSON.stringify(goal).substring(0, 500),
            status: status || 'RUNNING',
            progress: progress || this._calcProgress(subtasks, completedSubtasks),

            // 执行上下文 (可恢复)
            subtasks: this._serializeSubtasks(subtasks),
            completedSubtasks: this._serializeSubtasks(completedSubtasks),
            currentTask: currentTask ? String(currentTask).substring(0, 200) : null,

            // 消息历史 (压缩存储)
            messages: this._serializeMessages(messages),
            messageCount: messages.length,

            // 工具状态
            toolState: {
                loopDepth: toolState.loopDepth || 0,
                consecutiveToolCalls: toolState.consecutiveToolCalls || 0,
                strategyBlackboard: toolState.strategyBlackboard || null,
                lastToolResults: (toolState.lastToolResults || []).slice(-5)
            },

            // 元数据
            metadata: {
                ...metadata,
                subtaskCount: subtasks.length,
                completedCount: completedSubtasks.length,
                messageCount: messages.length
            }
        };

        // 写入文件
        const filePath = path.join(this.storageDir, `${checkpoint.id}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(checkpoint, null, 2));

        // 更新索引
        this._indexCheckpoint(checkpoint);
        this._activeTaskChain.push(checkpoint.id);

        // 如果通过 StateManager 也存一份 (兼容)
        if (this.stateManager) {
            await this.stateManager.saveCheckpoint(
                { checkpointId: checkpoint.id, goal: checkpoint.goal, progress: checkpoint.progress },
                { type: 'orchestrator_checkpoint', timestamp: checkpoint.timestamp }
            );
        }

        // 自动清理
        await this._autoCompact();

        return checkpoint.id;
    }

    /**
     * Restore most recent checkpoint matching the goal
     */
    async restore(goal, options = {}) {
        if (!this.enabled) return null;

        const goalStr = typeof goal === 'string' ? goal.substring(0, 200) : '';

        // 1. 精确匹配
        let chain = this._taskIndex.get(goalStr);
        if (!chain || chain.length === 0) {
            // 2. 模糊匹配
            chain = this._fuzzyFindChain(goalStr);
        }

        if (!chain || chain.length === 0) return null;

        // 取最新的检查点
        const latest = chain.sort((a, b) => b.timestamp - a.timestamp)[0];
        return await this._loadCheckpointById(latest.id);
    }

    /**
     * Load checkpoint by ID
     */
    async loadById(checkpointId) {
        return await this._loadCheckpointById(checkpointId);
    }

    /**
     * Get checkpoint chain for a goal
     */
    getChain(goal) {
        const goalStr = typeof goal === 'string' ? goal.substring(0, 200) : '';
        return this._taskIndex.get(goalStr) || [];
    }

    /**
     * List all checkpoints
     */
    listAll(limit = 20) {
        const all = [];
        for (const [goal, chain] of this._taskIndex) {
            for (const entry of chain) {
                all.push({ goal, ...entry });
            }
        }
        return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    /**
     * Clear all checkpoints for a task
     */
    async clearTask(goal) {
        const goalStr = typeof goal === 'string' ? goal.substring(0, 200) : '';
        const chain = this._taskIndex.get(goalStr);
        if (!chain) return { deleted: 0 };

        let deleted = 0;
        for (const entry of chain) {
            try {
                await fs.promises.unlink(path.join(this.storageDir, `${entry.id}.json`));
                deleted++;
            } catch (e) { /* 文件可能已不存在 */ }
        }
        this._taskIndex.delete(goalStr);
        this._activeTaskChain = this._activeTaskChain.filter(id => !chain.some(e => e.id === id));
        return { deleted };
    }

    /**
     * Get checkpoint statistics
     */
    getStats() {
        let totalSize = 0;
        let totalFiles = 0;
        try {
            const files = fs.readdirSync(this.storageDir);
            for (const f of files) {
                if (f.endsWith('.json')) {
                    totalFiles++;
                    totalSize += fs.statSync(path.join(this.storageDir, f)).size;
                }
            }
        } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }

        return {
            enabled: this.enabled,
            totalCheckpoints: totalFiles,
            totalSizeKB: Math.round(totalSize / 1024),
            activeTasks: this._taskIndex.size,
            storageDir: this.storageDir,
            maxCheckpoints: this.maxCheckpoints,
            recentCheckpoints: this.listAll(5)
        };
    }

    // ============================================
    // Internal methods
    // ============================================

    async _loadCheckpointById(id) {
        const filePath = path.join(this.storageDir, `${id}.json`);
        try {
            if (!fs.existsSync(filePath)) return null;
            const data = await fs.promises.readFile(filePath, 'utf8');
            const checkpoint = JSON.parse(data);

            // 反序列化
            return {
                ...checkpoint,
                subtasks: this._deserializeSubtasks(checkpoint.subtasks),
                completedSubtasks: this._deserializeSubtasks(checkpoint.completedSubtasks),
                messages: checkpoint.messages || [],
                toolState: checkpoint.toolState || {}
            };
        } catch (e) {
            console.warn(`[CheckpointManager] Failed to load checkpoint ${id}: ${e.message}`);
            return null;
        }
    }

    _indexCheckpoint(checkpoint) {
        const goalKey = checkpoint.goal.substring(0, 200);
        if (!this._taskIndex.has(goalKey)) {
            this._taskIndex.set(goalKey, []);
        }

        const chain = this._taskIndex.get(goalKey);
        // 去重
        const existing = chain.findIndex(e => e.id === checkpoint.id);
        if (existing >= 0) {
            chain[existing] = this._makeIndexEntry(checkpoint);
        } else {
            chain.push(this._makeIndexEntry(checkpoint));
        }

        // 只保留最新的 N 个
        if (chain.length > this.maxCheckpoints) {
            const toRemove = chain.sort((a, b) => a.timestamp - b.timestamp).slice(0, chain.length - this.maxCheckpoints);
            for (const entry of toRemove) {
                const idx = chain.indexOf(entry);
                if (idx >= 0) {
                    const removed = chain.splice(idx, 1)[0];
                    try { fs.unlinkSync(path.join(this.storageDir, `${removed.id}.json`)); } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
                }
            }
        }
    }

    _makeIndexEntry(checkpoint) {
        return {
            id: checkpoint.id,
            timestamp: new Date(checkpoint.timestamp).getTime(),
            step: checkpoint.metadata?.completedCount || 0,
            total: checkpoint.metadata?.subtaskCount || 0,
            status: checkpoint.status
        };
    }

    _fuzzyFindChain(goalStr) {
        const words = goalStr.toLowerCase().split(/[\s,，。、；：]+/).filter(w => w.length > 2);
        if (words.length === 0) return null;

        let bestMatch = null;
        let bestScore = 0;

        for (const [goal, chain] of this._taskIndex) {
            const goalLower = goal.toLowerCase();
            const matchCount = words.filter(w => goalLower.includes(w)).length;
            const score = matchCount / words.length;
            if (score > bestScore && score >= 0.3) {
                bestScore = score;
                bestMatch = chain;
            }
        }

        return bestMatch;
    }

    _calcProgress(subtasks, completedSubtasks) {
        const total = subtasks.length;
        const done = completedSubtasks.length;
        return total > 0 ? `${done}/${total}` : null;
    }

    _serializeSubtasks(subtasks) {
        return (subtasks || []).map(s => ({
            id: s.id,
            goal: typeof s.goal === 'string' ? s.goal.substring(0, 300) : String(s.goal || '').substring(0, 300),
            status: s.status || 'pending',
            result: s.result ? (typeof s.result === 'string' ? s.result.substring(0, 500) : JSON.stringify(s.result).substring(0, 500)) : null,
            error: s.error ? String(s.error).substring(0, 200) : null,
            checkpoint: !!s.checkpoint,
            retries: s.retries || 0
        }));
    }

    _deserializeSubtasks(serialized) {
        return (serialized || []).map(s => ({
            ...s,
            status: s.status || 'pending',
            result: s.result || null,
            error: s.error || null
        }));
    }

    _serializeMessages(messages) {
        if (!messages || messages.length === 0) return [];

        // 压缩消息: 保留 system 和最近的 user/assistant 消息
        const maxMessages = 100;
        const serialized = [];

        // 总是保留 system prompt
        for (const m of messages) {
            if (m.role === 'system') {
                serialized.push({ role: 'system', content: typeof m.content === 'string' ? m.content.substring(0, 2000) : '[complex]' });
            }
        }

        // 保留最近的 user/assistant 消息 (最多 maxMessages 条)
        const recent = messages.filter(m => m.role !== 'system').slice(-maxMessages);
        for (const m of recent) {
            serialized.push({
                role: m.role,
                content: typeof m.content === 'string' ? m.content.substring(0, 1000) : '[complex]'
            });
        }

        return serialized;
    }

    async _autoCompact() {
        try {
            const files = await fs.promises.readdir(this.storageDir);
            const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

            if (jsonFiles.length > this.maxCheckpoints) {
                const toDelete = jsonFiles.slice(0, jsonFiles.length - this.maxCheckpoints);
                for (const f of toDelete) {
                    await fs.promises.unlink(path.join(this.storageDir, f));
                }
                console.log(`[CheckpointManager] Compacted ${toDelete.length} old checkpoints`);
            }
        } catch (e) {
            // 清理失败不影响主流程
        }
    }

    _recoverIndex() {
        try {
            const files = fs.readdirSync(this.storageDir);
            for (const file of files.filter(f => f.endsWith('.json'))) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.storageDir, file), 'utf8'));
                    if (data.id && data.goal) {
                        this._indexCheckpoint(data);
                    }
                } catch (e) { /* 损坏的文件跳过 */ }
            }
            console.log(`[CheckpointManager] Recovered index from ${files.length} checkpoint files`);
        } catch (e) {
            // 首次启动无文件
        }
    }
}

module.exports = CheckpointManager;
