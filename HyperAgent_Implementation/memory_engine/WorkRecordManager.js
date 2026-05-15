// WorkRecordManager — work record manager
const fs = require('fs');
const path = require('path');

class WorkRecordManager {
    constructor(options = {}) {
        this.storageDir = options.storageDir || path.join(process.cwd(), 'work_records');
        this.maxRecords = options.maxRecords || 30;
        this.autoSaveInterval = options.autoSaveInterval || 15000; // 15秒
        this.mergeWindowMs = options.mergeWindowMs || 60000;       // 1分钟内合并

        // 当前工作记录（内存态）
        this.currentRecord = this._createEmptyRecord();
        this._lastSaveTime = 0;
        this._saveTimer = null;
        this._dirty = false;

        // 外部组件引用（可选注入）
        this.memoryPipeline = options.memoryPipeline || null;
        this.contextManager = options.contextManager || null;
        this.llmAdapter = options.llmAdapter || null;

        // 会话历史追踪
        this._sessionHistory = [];

        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
    }

    // 生命周期

    async init() {
        const latest = await this._loadLatest();

        if (latest) {
            this.currentRecord = {
                ...this._createEmptyRecord(),
                previousGoal: latest.currentGoal || null,
                previousSummary: latest.summary || null,
                previousProgress: latest.progress || null,
                previousTimestamp: latest.timestamp || null,
                sessionCount: (latest.sessionCount || 0) + 1,
                // 携带上次的重要上下文
                keyFindings: latest.keyFindings || [],
                pendingTasks: latest.pendingTasks || [],
                activeContext: latest.activeContext || null
            };

            console.log(`[WorkRecord] 发现上次工作记录 (${latest.timestamp})`);
            console.log(`[WorkRecord] 上次目标: ${(latest.currentGoal || '无').substring(0, 80)}`);
            if (latest.progress) console.log(`[WorkRecord] 上次进度: ${latest.progress}`);
        } else {
            console.log('[WorkRecord] 未找到历史工作记录，首次启动');
        }

        this._startAutoSave();
        return latest;
    }

    async destroy() {
        this._stopAutoSave();
        if (this._dirty) {
            await this.save();
        }
    }

    // 工作记录更新 API

    /**
     * 更新当前工作目标
     */
    setGoal(goal) {
        if (!goal || typeof goal !== 'string') return;
        goal = goal.substring(0, 500);
        // 如果目标变了，把旧目标归档到历史
        if (this.currentRecord.currentGoal && this.currentRecord.currentGoal !== goal) {
            this.currentRecord.goalHistory.push({
                goal: this.currentRecord.currentGoal,
                progress: this.currentRecord.progress,
                timestamp: new Date().toISOString()
            });
        }
        this.currentRecord.currentGoal = goal;
        this._markDirty();
    }

    /**
     * 更新进度描述
     */
    setProgress(progress) {
        if (!progress) return;
        this.currentRecord.progress = String(progress).substring(0, 300);
        this._markDirty();
    }

    /**
     * 更新摘要（由外部定期生成或由LLM生成）
     */
    setSummary(summary) {
        if (!summary) return;
        this.currentRecord.summary = String(summary).substring(0, 2000);
        this._markDirty();
    }

    /**
     * 添加关键发现
     */
    addFinding(finding) {
        if (!finding) return;
        const entry = {
            text: String(finding).substring(0, 300),
            timestamp: new Date().toISOString()
        };
        this.currentRecord.keyFindings.push(entry);
        if (this.currentRecord.keyFindings.length > 20) {
            this.currentRecord.keyFindings = this.currentRecord.keyFindings.slice(-20);
        }
        this._markDirty();
    }

    /**
     * 添加待办任务
     */
    addPendingTask(task) {
        if (!task) return;
        this.currentRecord.pendingTasks.push({
            task: String(task).substring(0, 200),
            timestamp: new Date().toISOString(),
            done: false
        });
        if (this.currentRecord.pendingTasks.length > 15) {
            this.currentRecord.pendingTasks = this.currentRecord.pendingTasks.slice(-15);
        }
        this._markDirty();
    }

    /**
     * 标记待办任务完成
     */
    completePendingTask(taskIndex) {
        if (this.currentRecord.pendingTasks[taskIndex]) {
            this.currentRecord.pendingTasks[taskIndex].done = true;
            this._markDirty();
        }
    }

    /**
     * 记录重要的上下文信息（用户偏好、决定等）
     */
    setActiveContext(context) {
        if (!context) return;
        this.currentRecord.activeContext = String(context).substring(0, 1000);
        this._markDirty();
    }

    /**
     * 添加对话轮次摘要到会话历史
     */
    addSessionTurn(userMessage, assistantResponse) {
        this._sessionHistory.push({
            user: (userMessage || '').substring(0, 200),
            assistant: (assistantResponse || '').substring(0, 200),
            timestamp: new Date().toISOString()
        });
        // 只保留最近10轮
        if (this._sessionHistory.length > 10) {
            this._sessionHistory = this._sessionHistory.slice(-10);
        }
    }

    // 持久化

    /**
     * 保存当前工作记录到磁盘
     */
    async save() {
        try {
            // 更新时间戳
            const now = Date.now();
            this.currentRecord.lastUpdated = new Date(now).toISOString();

            // 合并模式：如果距离上次保存 < mergeWindowMs, 更新已有文件而非创建新文件
            if (this._lastSaveTime > 0 && (now - this._lastSaveTime) < this.mergeWindowMs) {
                const latestFile = this._getLatestFilePath();
                if (latestFile && fs.existsSync(latestFile)) {
                    await fs.promises.writeFile(latestFile, JSON.stringify(this.currentRecord, null, 2));
                    this._lastSaveTime = now;
                    this._dirty = false;
                    return latestFile;
                }
            }

            // 正常模式：创建新文件
            const filePath = path.join(this.storageDir, `work_record_${now}.json`);
            await fs.promises.writeFile(filePath, JSON.stringify(this.currentRecord, null, 2));
            this._lastSaveTime = now;
            this._dirty = false;

            // 清理旧记录
            this._cleanOldRecords();

            return filePath;
        } catch (e) {
            console.warn(`[WorkRecord] 保存失败: ${e.message}`);
            return null;
        }
    }

    /**
     * 获取格式化的恢复上下文（供注入到 system prompt）
     * @param {boolean} includeDetail 是否包含详细内容（关键发现、待办等）
     * @returns {string|null} 格式化的恢复文本
     */
    getFormattedResume(includeDetail = true) {
        const r = this.currentRecord;
        if (!r.previousGoal && !r.previousSummary) return null;

        const lines = [];
        lines.push('=== 工作记录恢复 ===');

        if (r.sessionCount && r.sessionCount > 1) {
            lines.push(`会话 #${r.sessionCount}`);
        }

        if (r.previousTimestamp) {
            lines.push(`上次活动: ${r.previousTimestamp}`);
        }

        if (r.previousGoal) {
            lines.push(`之前的目标: ${r.previousGoal}`);
        }

        if (r.previousProgress) {
            lines.push(`之前的进度: ${r.previousProgress}`);
        }

        if (r.previousSummary) {
            lines.push(`之前的摘要: ${r.previousSummary}`);
        }

        if (includeDetail) {
            if (r.keyFindings && r.keyFindings.length > 0) {
                lines.push('关键发现:');
                r.keyFindings.slice(-5).forEach(f => {
                    lines.push(`  - ${f.text}`);
                });
            }

            if (r.pendingTasks && r.pendingTasks.length > 0) {
                const pending = r.pendingTasks.filter(t => !t.done);
                if (pending.length > 0) {
                    lines.push('待办事项:');
                    pending.slice(-5).forEach(t => {
                        lines.push(`  - [ ] ${t.task}`);
                    });
                }
            }

            if (r.activeContext) {
                lines.push(`活跃上下文: ${r.activeContext}`);
            }
        }

        lines.push('====================');
        return lines.join('\n');
    }

    /**
     * 获取简短的恢复摘要（一行）
     */
    getShortResume() {
        const r = this.currentRecord;
        if (!r.previousGoal && !r.previousSummary) return null;
        const goal = r.previousGoal || '无记录';
        return `[恢复] ${goal} | ${r.previousTimestamp || '?'}`;
    }

    // 内部方法

    _createEmptyRecord() {
        return {
            version: '1.0',
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            sessionCount: 0,

            // 当前状态
            currentGoal: null,
            progress: null,
            summary: null,

            // 前一会话的信息（启动时从磁盘加载）
            previousGoal: null,
            previousSummary: null,
            previousProgress: null,
            previousTimestamp: null,

            // 关键发现 & 待办
            keyFindings: [],
            pendingTasks: [],
            activeContext: null,

            // 目标变更历史
            goalHistory: []
        };
    }

    async _loadLatest() {
        try {
            const files = fs.readdirSync(this.storageDir)
                .filter(f => f.startsWith('work_record_') && f.endsWith('.json'))
                .sort()
                .reverse();

            if (files.length === 0) return null;

            // 加载最近的文件
            const data = JSON.parse(
                fs.readFileSync(path.join(this.storageDir, files[0]), 'utf8')
            );
            return data;
        } catch (e) {
            return null;
        }
    }

    _getLatestFilePath() {
        try {
            const files = fs.readdirSync(this.storageDir)
                .filter(f => f.startsWith('work_record_') && f.endsWith('.json'))
                .sort()
                .reverse();
            return files.length > 0 ? path.join(this.storageDir, files[0]) : null;
        } catch (e) {
            return null;
        }
    }

    _cleanOldRecords() {
        try {
            const files = fs.readdirSync(this.storageDir)
                .filter(f => f.startsWith('work_record_') && f.endsWith('.json'))
                .sort();

            // 保留最近的 N 条
            if (files.length > this.maxRecords) {
                const toDelete = files.slice(0, files.length - this.maxRecords);
                for (const f of toDelete) {
                    fs.unlinkSync(path.join(this.storageDir, f));
                }
            }
        } catch (e) {
            // 清理失败不影响主流程
        }
    }

    _markDirty() {
        this._dirty = true;
    }

    _startAutoSave() {
        if (this._saveTimer) return;
        this._saveTimer = setInterval(() => {
            if (this._dirty) {
                this.save().catch(e => console.warn(`[memory_engine] Caught: ${e.message}`));
            }
        }, this.autoSaveInterval);
        // 不让定时器阻止进程退出
        if (this._saveTimer.unref) {
            this._saveTimer.unref();
        }
    }

    _stopAutoSave() {
        if (this._saveTimer) {
            clearInterval(this._saveTimer);
            this._saveTimer = null;
        }
    }

    // 统计 & 管理

    getStats() {
        let fileCount = 0;
        let totalSize = 0;
        try {
            const files = fs.readdirSync(this.storageDir);
            for (const f of files) {
                if (f.endsWith('.json')) {
                    fileCount++;
                    totalSize += fs.statSync(path.join(this.storageDir, f)).size;
                }
            }
        } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }

        return {
            storageDir: this.storageDir,
            fileCount,
            totalSizeKB: Math.round(totalSize / 1024),
            maxRecords: this.maxRecords,
            hasPreviousRecord: !!this.currentRecord.previousGoal,
            currentGoal: this.currentRecord.currentGoal,
            keyFindings: this.currentRecord.keyFindings.length,
            pendingTasks: this.currentRecord.pendingTasks.length,
            goalHistoryCount: this.currentRecord.goalHistory.length,
            autoSaveInterval: this.autoSaveInterval,
            dirty: this._dirty
        };
    }

    /**
     * 获取当前工作记录（内存中的完整数据）
     */
    getCurrentRecord() {
        return { ...this.currentRecord };
    }
}

module.exports = WorkRecordManager;
