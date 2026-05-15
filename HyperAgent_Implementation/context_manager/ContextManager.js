// ContextManager — context manager
const fs = require('fs');
const path = require('path');

class ContextManager {
    constructor(options = {}) {
        // 分段配置
        this.maxSegmentSize = options.maxSegmentSize || 3000;   // 每段最大字符数
        this.maxSegments = options.maxSegments || 10;           // 最大保留段数
        this.compressionRatio = options.compressionRatio || 0.3; // LLM压缩比例

        // 内部状态
        this.segments = [];
        this.currentSegmentId = 0;

        // 关键上下文
        this.globalSummary = null;
        this.keyFacts = [];
        this.decisions = [];
        this.userPreferences = {};

        // 话题追踪
        this.topics = [];          // { name, turnCount, lastActive, summary }
        this._topicTimeout = 600000; // 10分钟无更新视为话题过期
        this._currentTopic = null;

        // 重要性评分缓存
        this._importanceCache = new Map();

        // 跨会话持久化
        this._storageDir = path.join(process.cwd(), 'mem_store', 'context');
        this._sessionId = Date.now().toString(36);
        this._initStorage();

        // LLM适配器（可选，由外部注入）
        this.llmAdapter = null;

        // 统计
        this.stats = {
            totalMessages: 0,
            totalCompressions: 0,
            totalTopics: 0,
            totalDecisions: 0,
            keyFactsExtracted: 0
        };
    }

    // 生命周期

    setLLMAdapter(adapter) {
        this.llmAdapter = adapter;
    }

    /**
     * 从上一会话加载持久化的上下文
     */
    async loadCrossSession() {
        try {
            const files = fs.readdirSync(this._storageDir)
                .filter(f => f.startsWith('context_'))
                .sort()
                .reverse();

            if (files.length === 0) return null;

            // 加载最近3个会话文件
            const contexts = [];
            for (let i = 0; i < Math.min(3, files.length); i++) {
                try {
                    const data = JSON.parse(
                        fs.readFileSync(path.join(this._storageDir, files[i]), 'utf8')
                    );
                    contexts.push(data);
                } catch (e) { console.warn(`[context_manager] Unhandled error: ${e.message}`); }
            }

            // 合并上下文
            const merged = this._mergeCrossSessionContexts(contexts);
            if (merged) {
                console.log(`[ContextManager] 跨会话加载: ${merged.keyFacts.length}条事实, ${merged.decisions.length}条决定`);
            }
            return merged;
        } catch (e) {
            return null;
        }
    }

    /**
     * 持久化当前上下文供下个会话使用
     */
    save() {
        try {
            if (!fs.existsSync(this._storageDir)) {
                fs.mkdirSync(this._storageDir, { recursive: true });
            }
            const filePath = path.join(this._storageDir, `context_${this._sessionId}.json`);
            fs.writeFileSync(filePath, JSON.stringify({
                sessionId: this._sessionId,
                globalSummary: this.globalSummary,
                keyFacts: this.keyFacts.slice(-100),
                decisions: this.decisions.slice(-50),
                userPreferences: this.userPreferences,
                topics: this.topics.map(t => ({
                    name: t.name, turnCount: t.turnCount, summary: t.summary
                })),
                messageCount: this.stats.totalMessages,
                segmentCount: this.segments.length,
                savedAt: new Date().toISOString()
            }, null, 2));
            return filePath;
        } catch (e) {
            return null;
        }
    }

    // 核心 API

    /**
     * 添加消息到上下文
     */
    addMessage(role, content, metadata = {}) {
        this.stats.totalMessages++;

        // 创建初始段
        if (this.segments.length === 0 || !this.currentSegment()) {
            this._createSegment();
        }

        const seg = this.currentSegment();

        // 如果当前段满了，轮换段
        if (seg.getSize() + content.length > this.maxSegmentSize) {
            this._rotateSegment();
        }

        // 添加消息
        seg.addMessage(role, content, metadata);

        // 评估消息重要性
        const importance = this._evaluateImportance(role, content);
        seg.importance += importance;
        metadata.importance = importance;

        // 话题追踪
        this._trackTopic(content);

        // 关键事实提取
        this._extractKeyFacts(content);

        // 决策记录
        if (this._isDecisionStatement(content)) {
            this.decisions.push({
                decision: content.substring(0, 200),
                context: this._currentTopic || 'general',
                timestamp: new Date().toISOString()
            });
            this.stats.totalDecisions++;
        }
    }

    getContext(options = {}) {
        const { maxTokens = 8000, includeHistory = true, compact = true } = options;
        const parts = [];
        const maxChars = maxTokens * 4;

        // 1. 全局摘要
        if (this.globalSummary) {
            parts.push(`[对话摘要] ${this.globalSummary}`);
        }

        // 2. 用户偏好
        const prefs = this._formatPreferences();
        if (prefs) parts.push(prefs);

        // 3. 活跃话题
        const topicInfo = this._formatActiveTopics();
        if (topicInfo) parts.push(topicInfo);

        // 4. 关键事实
        if (this.keyFacts.length > 0) {
            const facts = this.keyFacts.slice(-15)
                .map(f => `• ${f.substring(0, 150)}`)
                .join('\n');
            parts.push(`[已知事实]\n${facts}`);
        }

        // 5. 重要决定
        if (this.decisions.length > 0) {
            const decisions = this.decisions.slice(-8)
                .map(d => `• ${d.decision.substring(0, 150)}`)
                .join('\n');
            parts.push(`[已做决定]\n${decisions}`);
        }

        // 6. 对话历史（带重要性过滤）
        if (includeHistory) {
            const history = this._buildCompressedHistory(compact);
            if (history) {
                parts.push(`[对话历史]\n${history}`);
            }
        }

        let context = parts.join('\n\n');

        // 最终截断
        if (context.length > maxChars) {
            // 智能截断：保留开头（摘要/偏好）和结尾（最近历史），压缩中间
            const headEnd = context.indexOf('[对话历史]');
            const head = headEnd > 0 ? context.substring(0, headEnd) : '';
            const historyStart = headEnd > 0 ? headEnd : 0;

            // 保留最近的对话历史
            const recentHistory = context.substring(historyStart);
            const maxHistoryChars = maxChars - head.length - 500;

            if (head.length + 500 > maxChars) {
                context = head.substring(0, maxChars * 0.4) + '\n...[上下文过长，已截断]...\n' +
                         recentHistory.slice(-Math.max(500, maxChars * 0.5));
            } else {
                context = head + recentHistory.slice(-maxHistoryChars);
            }
        }

        return context;
    }

    getHistory(options = {}) {
        const { maxMessages = 100, minImportance = 0 } = options;
        const all = [];

        for (const seg of this.segments) {
            for (const msg of seg.messages) {
                if (msg.metadata?.importance >= minImportance || minImportance === 0) {
                    all.push(msg);
                }
            }
        }

        return all.slice(-maxMessages);
    }

    /**
     * LLM驱动的智能上下文压缩
     */
    async smartCompress(options = {}) {
        const maxSegments = options.maxSegments || 5;

        if (this.segments.length <= maxSegments + 1) return;

        // 找到低重要性且旧的段来压缩
        const compressible = this.segments.slice(0, -maxSegments)
            .filter(s => s.messages.length > 0)
            .sort((a, b) => a.importance - b.importance);

        if (compressible.length === 0) return;

        // 取最重要的段，用LLM生成摘要
        const toCompress = compressible.slice(0, 2);

        for (const seg of toCompress) {
            const summary = await this._llmCompress(seg);
            if (summary) {
                this.keyFacts.push(`[压缩摘要] ${summary}`);
                this.stats.totalCompressions++;

                // 从 segments 中移除被压缩的段
                const idx = this.segments.indexOf(seg);
                if (idx >= 0) {
                    this.segments.splice(idx, 1);
                }
            }
        }

        // 如果还是太多，用简单压缩
        if (this.segments.length > maxSegments + 2) {
            this.compress();
        }

        // 限制 keyFacts 数量
        if (this.keyFacts.length > 200) {
            this.keyFacts = this.keyFacts.slice(-200);
        }
    }

    /**
     * 简单压缩（无LLM时的降级方案）
     */
    compress() {
        const targetSegments = 5;
        if (this.segments.length <= targetSegments) return;

        const toRemove = this.segments.slice(0, -(targetSegments));
        for (const seg of toRemove) {
            if (seg.messages.length > 0) {
                const lastMsgs = seg.messages.slice(-3).map(m =>
                    `${m.role}: ${m.content.substring(0, 80)}`
                ).join(' | ');
                this.keyFacts.push(`[段${seg.id}] ${seg.messages.length}条消息: ${lastMsgs}`);
            }
        }

        this.segments = this.segments.slice(-targetSegments);
    }

    // 分析方法

    /** LLM驱动的对话分析 */
    async analyzeConversation(llmAdapter) {
        const llm = llmAdapter || this.llmAdapter;
        if (!llm || typeof llm.chat !== 'function') return null;

        const recentMessages = this.getHistory({ maxMessages: 15 });
        if (recentMessages.length < 3) return null;

        const text = recentMessages.map(m =>
            `${m.role}: ${m.content.substring(0, 250)}`
        ).join('\n');

        try {
            const response = await llm.chat([
                {
                    role: 'system',
                    content: `你是一个对话分析专家。分析以下对话，返回JSON（不要代码块）：
{
  "topic": "当前话题",
  "userPreferences": {"key": "value"},
  "keyPoints": ["..."],
  "decisions": ["..."],
  "actionItems": ["..."],
  "sentiment": "positive/neutral/negative"
}`
                },
                { role: 'user', content: `对话:\n${text}` }
            ]);

            const cleaned = response.replace(/```json|```/g, '').trim();
            const analysis = JSON.parse(cleaned);

            if (analysis.userPreferences) {
                Object.assign(this.userPreferences, analysis.userPreferences);
            }
            if (analysis.keyPoints) {
                for (const point of analysis.keyPoints.slice(0, 5)) {
                    const entry = `[AI提取] ${point}`;
                    if (!this.keyFacts.includes(entry)) {
                        this.keyFacts.push(entry);
                        this.stats.keyFactsExtracted++;
                    }
                }
            }
            if (analysis.decisions) {
                for (const d of analysis.decisions) {
                    this.decisions.push({
                        decision: d, context: 'AI分析',
                        timestamp: new Date().toISOString()
                    });
                }
            }

            return analysis;
        } catch (e) {
            return null;
        }
    }

    // 记录方法

    recordDecision(decision, context = '') {
        this.decisions.push({
            decision,
            context: context || this._currentTopic || 'general',
            timestamp: new Date().toISOString()
        });
        this.stats.totalDecisions++;
    }

    updatePreference(key, value) {
        // 合并偏好
        if (typeof value === 'object' && value !== null) {
            if (!this.userPreferences[key]) this.userPreferences[key] = {};
            Object.assign(this.userPreferences[key], value);
        } else {
            this.userPreferences[key] = value;
        }
    }

    // 内部方法

    _createSegment() {
        this.segments.push(new ContextSegment(++this.currentSegmentId));
    }

    currentSegment() {
        return this.segments[this.segments.length - 1];
    }

    _rotateSegment() {
        const oldSeg = this.currentSegment();
        if (oldSeg && oldSeg.messages.length > 0) {
            oldSeg.summary = this._simpleSummarizeSegment(oldSeg);
        }
        this._createSegment();
    }

    _evaluateImportance(role, content) {
        const str = content.toLowerCase();

        // 用户消息比助手消息重要
        let base = role === 'user' ? 0.6 : 0.3;

        // 长度加分
        base += Math.min(0.3, str.length / 500 * 0.2);

        // 关键词加分
        const importantKeywords = [
            '记住', '重要', '关键', '必须', '核心', '决定',
            'remember', 'important', 'critical', 'must', 'decide',
            '创建', '删除', '修改', '写一个', '开发',
            'create', 'delete', 'write', 'build', 'develop'
        ];
        for (const kw of importantKeywords) {
            if (str.includes(kw)) {
                base += 0.2;
                break;
            }
        }

        // 指令模式加分
        if (role === 'user' && (
            str.startsWith('帮我') || str.startsWith('请') ||
            /^(create|delete|write|run|execute|start|stop)/i.test(str.trim())
        )) {
            base += 0.2;
        }

        return Math.min(1.0, base);
    }

    _trackTopic(content) {
        // 检测话题切换信号
        const topicTriggers = [
            /我们(来|要|聊聊|讨论|说下|谈谈)\s*(.*?)(?:吧|？|\.|$)/,
            /关于\s*(.*?)(?:的|：|:|,|，)/,
            /切换(话题|主题|到)/i,
            /换个话题/i,
            /对了[，,]\s*(.*)/,
            /说到\s*(.*?)[，,]/,
            /话说\s*(.*?)[，,]/,
        ];

        let newTopic = null;
        for (const pattern of topicTriggers) {
            const match = content.match(pattern);
            if (match) {
                newTopic = (match[1] || match[2] || '').trim().substring(0, 40);
                if (newTopic.length > 1) break;
            }
        }

        if (newTopic) {
            // 检查是否已有此话题
            const existing = this.topics.find(t =>
                t.name.includes(newTopic) || newTopic.includes(t.name)
            );
            if (existing) {
                existing.turnCount++;
                existing.lastActive = Date.now();
                this._currentTopic = existing.name;
            } else {
                this.topics.push({
                    name: newTopic,
                    turnCount: 1,
                    lastActive: Date.now(),
                    summary: null
                });
                this._currentTopic = newTopic;
                this.stats.totalTopics++;
                if (this.topics.length > 20) this.topics = this.topics.slice(-20);
            }
        } else if (this._currentTopic) {
            // 延续当前话题
            const topic = this.topics.find(t => t.name === this._currentTopic);
            if (topic) {
                topic.turnCount++;
                topic.lastActive = Date.now();
            }
        }
    }

    _extractKeyFacts(content) {
        const str = content;

        // 显式记忆指令
        const rememberPatterns = [
            /记住[：:]\s*(.+)/i,
            /请记住[：:]\s*(.+)/i,
            /别忘了[：:]\s*(.+)/i,
            /重要[：:]\s*(.+)/i,
            /请记录[：:]\s*(.+)/i,
            /remember[：:]\s*(.+)/i,
            /important[：:]\s*(.+)/i,
        ];

        for (const pattern of rememberPatterns) {
            const match = str.match(pattern);
            if (match && match[1].trim().length > 3) {
                const fact = match[1].trim().substring(0, 200);
                if (!this.keyFacts.includes(fact)) {
                    this.keyFacts.push(fact);
                    this.stats.keyFactsExtracted++;
                }
            }
        }

        // 用户偏好检测
        const prefPatterns = [
            /我喜欢\s*(.+)/i,
            /我(不)?喜欢\s*(.+)/i,
            /我习惯\s*(.+)/i,
            /我更[偏向喜欢愿意].*?(?:用|使用)\s*(.+)/i,
            /不要\s*(.+)/i,
            /i (don't )?like\s*(.+)/i,
            /i prefer\s*(.+)/i,
        ];
        for (const pattern of prefPatterns) {
            const match = str.match(pattern);
            if (match) {
                const pref = match[0].substring(0, 100);
                this.userPreferences[`auto_${Date.now()}`] = pref;
            }
        }
    }

    _isDecisionStatement(content) {
        const decisionPatterns = [
            /我决定了|我决定|就这么办|就这样|就这个方案/i,
            /选[择]?\s*(方案|A|B|第一个|第二个)/i,
            /我选|我挑|就用/i,
            /let's do it|go with|decided|decision|i'll go with/i,
            /^好[的罢]?\s*[,，]?\s*(就|用|使用|开始)/i,
        ];
        return decisionPatterns.some(p => p.test(content));
    }

    _buildCompressedHistory(compact) {
        // 获取最近的段
        const recentSegs = this.segments.slice(-5);
        if (recentSegs.length === 0) return null;

        const lines = [];

        for (const seg of recentSegs) {
            // 带重要性显示的格式化
            for (const msg of seg.messages) {
                const prefix = msg.role === 'user' ? '用户' : '助手';
                const content = msg.content.length > 500 && compact
                    ? msg.content.substring(0, 500) + '...'
                    : msg.content;
                lines.push(`${prefix}: ${content}`);
            }
        }

        return lines.join('\n');
    }

    _formatPreferences() {
        const entries = Object.entries(this.userPreferences);
        if (entries.length === 0) return null;

        const lines = entries.map(([k, v]) =>
            `• ${typeof v === 'string' ? v : JSON.stringify(v)}`
        );
        return `[用户偏好]\n${lines.slice(-8).join('\n')}`;
    }

    _formatActiveTopics() {
        const now = Date.now();
        const active = this.topics.filter(t =>
            (now - t.lastActive) < this._topicTimeout
        );
        if (active.length === 0) return null;

        const lines = active.map(t => `• ${t.name} (${t.turnCount}轮)`);
        return `[活跃话题]\n${lines.join('\n')}`;
    }

    /**
     * LLM驱动的段压缩
     */
    async _llmCompress(segment) {
        const llm = this.llmAdapter;
        if (!llm || typeof llm.chat !== 'function') return null;

        const text = segment.messages.map(m =>
            `${m.role}: ${m.content.substring(0, 200)}`
        ).join('\n');

        if (text.length < 100) return null;

        try {
            const response = await llm.chat([
                {
                    role: 'system',
                    content: `你是一个对话压缩专家。用1-2句话总结以下对话片段，保留关键信息、决定和用户偏好。仅输出摘要，不要前缀。`
                },
                { role: 'user', content: text.substring(0, 3000) }
            ]);
            return response.replace(/```/g, '').trim().substring(0, 300);
        } catch (e) {
            return this._simpleSummarizeSegment(segment);
        }
    }

    _simpleSummarizeSegment(segment) {
        const count = segment.messages.length;
        if (count === 0) return '';
        const last = segment.messages[segment.messages.length - 1];
        return `[${count}条消息] 最近: ${last.role}: ${last.content.substring(0, 100)}`;
    }

    _mergeCrossSessionContexts(contexts) {
        if (contexts.length === 0) return null;

        // 合并关键事实（去重）
        const allFacts = new Set();
        const allDecisions = new Set();
        const prefs = {};

        for (const ctx of contexts) {
            for (const f of ctx.keyFacts || []) {
                if (f.length > 5) allFacts.add(f.substring(0, 200));
            }
            for (const d of ctx.decisions || []) {
                const text = typeof d === 'string' ? d : d.decision || '';
                if (text.length > 5) allDecisions.add(text.substring(0, 200));
            }
            if (ctx.userPreferences) {
                Object.assign(prefs, ctx.userPreferences);
            }
        }

        return {
            keyFacts: Array.from(allFacts).slice(-100),
            decisions: Array.from(allDecisions).slice(-50),
            userPreferences: prefs
        };
    }

    _initStorage() {
        try {
            if (!fs.existsSync(this._storageDir)) {
                fs.mkdirSync(this._storageDir, { recursive: true });
            }
        } catch (e) { console.warn(`[context_manager] Unhandled error: ${e.message}`); }
    }

    // 统计

    getStats() {
        return {
            totalSegments: this.segments.length,
            totalMessages: this.stats.totalMessages,
            totalCompressions: this.stats.totalCompressions,
            globalSummaryLength: this.globalSummary?.length || 0,
            keyFactsCount: this.keyFacts.length,
            decisionsCount: this.decisions.length,
            preferencesCount: Object.keys(this.userPreferences).length,
            activeTopics: this.topics.filter(t =>
                (Date.now() - t.lastActive) < this._topicTimeout
            ).length
        };
    }
}

// 上下文段

class ContextSegment {
    constructor(id, messages = []) {
        this.id = id;
        this.messages = messages;
        this.summary = null;
        this.importance = 0;
        this.timestamp = new Date();
    }

    addMessage(role, content, metadata = {}) {
        this.messages.push({
            role,
            content,
            metadata,
            ts: new Date().toISOString()
        });
    }

    isEmpty() { return this.messages.length === 0; }

    getSize() {
        // 近似计算字符数
        return this.messages.reduce((sum, m) => sum + m.content.length, 0);
    }
}

module.exports = ContextManager;
