// ContinualLearner — continual learning engine
class ContinualLearner {
    constructor(options = {}) {
        this.memoryManager = options.memoryManager;
        this.localInference = options.localInference;
        this.deviceManager = options.deviceManager;

        // 时间间隔配置
        this.absorbInterval = options.absorbInterval || 60000;     // 吸收环：1分钟
        this.analyzeInterval = options.analyzeInterval || 300000;  // 分析环：5分钟
        this.evolveInterval = options.evolveInterval || 900000;    // 进化环：15分钟

        // 内部状态
        this._absorbTimer = null;
        this._analyzeTimer = null;
        this._evolveTimer = null;
        this._running = false;

        // 统计
        this.stats = {
            totalAbsorbed: 0,
            totalAnalyzed: 0,
            totalEvolved: 0,
            patternsFound: 0,
            insightsGenerated: 0,
            lastAbsorbTime: null,
            lastAnalyzeTime: null,
            lastEvolveTime: null,
            startTime: null
        };

        // 模式缓存
        this._patternCache = new Map();
        this._lastDeviceState = null;
        this._stateChangeCount = 0;
        this._absorbedKeys = new Set();

        // 学习数据存储
        this._learningDir = options.learningDir || 'learning_data';
        try {
            const fs = require('fs');
            if (!fs.existsSync(this._learningDir)) {
                fs.mkdirSync(this._learningDir, { recursive: true });
            }
        } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
    }

    /**
     * 启动三环学习
     */
    start() {
        if (this._running) return false;
        this._running = true;
        this.stats.startTime = Date.now();

        // 环1: 自动吸收 - 实时消化承载体数据
        this._absorbTimer = setInterval(() => {
            this.absorbCycle().catch(e => console.error('[ContinualLearner] Absorb error:', e.message));
        }, this.absorbInterval);

        // 环2: 自动分析 - 周期性模式挖掘
        this._analyzeTimer = setInterval(() => {
            this.analyzeCycle().catch(e => console.error('[ContinualLearner] Analyze error:', e.message));
        }, this.analyzeInterval);

        // 环3: 自动进化 - 知识升华与行为优化
        this._evolveTimer = setInterval(() => {
            this.evolveCycle().catch(e => console.error('[ContinualLearner] Evolve error:', e.message));
        }, this.evolveInterval);

        // 立即执行一次
        this.absorbCycle().catch(e => console.warn('[ContinualLearner] Initial absorb failed:', e.message));

        console.log(`[ContinualLearner] 三环学习已启动 (吸收=${this.absorbInterval/1000}s 分析=${this.analyzeInterval/60000}min 进化=${this.evolveInterval/60000}min)`);
        return true;
    }

    /**
     * 停止学习
     */
    stop() {
        this._running = false;
        if (this._absorbTimer) { clearInterval(this._absorbTimer); this._absorbTimer = null; }
        if (this._analyzeTimer) { clearInterval(this._analyzeTimer); this._analyzeTimer = null; }
        if (this._evolveTimer) { clearInterval(this._evolveTimer); this._evolveTimer = null; }
        console.log('[ContinualLearner] 学习已停止');
    }

    // 环1: 自动吸收

    async absorbCycle() {
        const start = Date.now();

        // 1. 吸收承载体状态
        if (this.deviceManager) {
            await this._absorbDeviceState();
        }

        // 2. 吸收当前对话/上下文中的新实体
        if (this.memoryManager) {
            await this._absorbNewMemories();
        }

        // 3. 自动摘要存储
        const li = this.localInference;
        if (li && li.isReady() && li.getCapabilities().chat) {
            await this._autoSummarize();
        }

        this.stats.lastAbsorbTime = new Date();
    }

    async _absorbDeviceState() {
        try {
            const report = this.deviceManager.getFullReport();
            if (!report) return;

            const stateStr = JSON.stringify(report);
            const stateHash = this._hash(stateStr);
            if (this._lastDeviceStateHash === stateHash) return; // 无变化跳过

            this._lastDeviceStateHash = stateHash;
            const prevState = this._lastDeviceState;
            this._lastDeviceState = report;
            this._stateChangeCount++;

            // 用本地小模型分析状态变化
            const li = this.localInference;
            if (li && li.isReady()) {
                let summary = null;
                let entities = null;

                try {
                    if (li.getCapabilities().chat) {
                        summary = await li.analyze(stateStr, '分析当前承载体状态，提取关键变化');
                    }
                } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }

                try {
                    if (li.getCapabilities().chat) {
                        entities = await li.extractEntities(stateStr);
                    }
                } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }

                // 存入 L1 记忆
                if (this.memoryManager) {
                    const memContent = summary
                        ? `[DeviceState] ${summary}`
                        : `[DeviceState] ${report.info?.deviceType || 'pc'} state snapshot #${this._stateChangeCount}`;
                    await this.memoryManager.pushMemory(memContent, 'L1');

                    if (entities && entities.length > 0) {
                        for (const entity of entities) {
                            this.memoryManager.trackEntity(entity.name, entity.type || 'device_entity');
                        }
                    }
                }

                // 检测与上一个状态的差异
                if (prevState && li.getCapabilities().chat && this._stateChangeCount % 3 === 0) {
                    try {
                        const diff = await li.compare(report, prevState);
                        if (diff && this.memoryManager) {
                            await this.memoryManager.pushMemory(`[StateChange] ${diff}`, 'L1');
                        }
                    } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
                }
            } else {
                // 无本地模型时的简单记录
                if (this.memoryManager) {
                    await this.memoryManager.pushMemory(
                        `[DeviceState] ${report.info?.deviceType || 'pc'} snapshot #${this._stateChangeCount}`,
                        'L1'
                    );
                }
            }

            this.stats.totalAbsorbed++;
        } catch (e) {
            console.warn('[ContinualLearner] Device state absorb error:', e.message);
        }
    }

    async _absorbNewMemories() {
        try {
            const l0Count = this.memoryManager.layers.L0?.size || 0;
            // L0 记忆自动吸收处理：提取实体和标签
            if (l0Count > 0) {
                const layer = this.memoryManager.layers.L0;
                for (const [id, item] of layer) {
                    if (this._absorbedKeys.has(id)) continue;
                    this._absorbedKeys.add(id);

                    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
                    const tags = this.memoryManager._extractTags(content);
                    if (tags.length > 0 && this.memoryManager) {
                        // 确保 item.tags 存在
                        if (!item.tags) item.tags = [];
                        for (const tag of tags) {
                            if (!item.tags.includes(tag)) item.tags.push(tag);
                        }
                    }
                }
            }
        } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
    }

    async _autoSummarize() {
        try {
            // 从 L1 找未摘要过的记忆，批量摘要
            const l1Layer = this.memoryManager.layers.L1;
            const toSummarize = [];
            for (const [id, item] of l1Layer) {
                if (!item._summarized && typeof item.content === 'string' && item.content.length > 200) {
                    toSummarize.push(item);
                    if (toSummarize.length >= 5) break;
                }
            }

            for (const item of toSummarize) {
                try {
                    const summary = await this.localInference.summarize(item.content);
                    if (summary && summary !== item.content) {
                        // 保持原文但标记摘要
                        item._summary = summary;
                        item._summarized = true;
                    }
                } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
            }
        } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
    }

    // 环2: 自动分析

    async analyzeCycle() {
        const start = Date.now();

        // 1. 模式检测 - 从记忆中发现重复模式
        await this._detectPatterns();

        // 2. 关联挖掘 - 发现实体之间的关联
        await this._mineAssociations();

        // 3. 趋势分析 - 分析承载体状态趋势
        await this._analyzeTrends();

        this.stats.lastAnalyzeTime = new Date();
        this.stats.totalAnalyzed++;
    }

    async _detectPatterns() {
        if (!this.memoryManager) return;

        const li = this.localInference;
        const l2Layer = this.memoryManager.layers.L2;
        if (!l2Layer || l2Layer.size < 2) return;

        const memories = Array.from(l2Layer.values()).slice(0, 20);
        const textBlock = memories.map((m, i) =>
            `[${i}] ${typeof m.content === 'string' ? m.content.substring(0, 150) : JSON.stringify(m.content).substring(0, 150)}`
        ).join('\n');

        if (li && li.isReady() && li.getCapabilities().chat) {
            try {
                const result = await li.chat([
                    { role: 'system', content: '你是一个模式识别引擎。从以下经验片段中发现重复出现的模式。如果有模式，输出json格式：[{"pattern":"模式描述","count":出现次数,"examples":[索引]}]. 如果没有模式,输出[]' },
                    { role: 'user', content: textBlock }
                ], { temperature: 0.1, maxTokens: 256 });

                const jsonMatch = result.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const patterns = JSON.parse(jsonMatch[0]);
                    if (patterns.length > 0) {
                        this.stats.patternsFound += patterns.length;

                        // 将新模式存入 L2
                        for (const p of patterns) {
                            if (p.count >= 2) {
                                const patternKey = `Pattern_${p.pattern.substring(0, 30).replace(/\s+/g, '_')}`;
                                await this.memoryManager.pushMemory({
                                    type: 'pattern',
                                    pattern: p.pattern,
                                    count: p.count,
                                    examples: p.examples || [],
                                    source: 'continual_learner'
                                }, 'L2', patternKey);
                            }
                        }
                    }
                }
            } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
        }
    }

    async _mineAssociations() {
        if (!this.memoryManager) return;

        const entities = this.memoryManager.getActiveEntities(2);
        if (entities.length < 2) return;

        // 实体共现分析：在同一时间段出现的实体可能有关联
        const li = this.localInference;
        if (li && li.isReady() && li.getCapabilities().chat && entities.length >= 3) {
            try {
                const entityNames = entities.map(e => e.name).join(', ');
                const result = await li.chat([
                    { role: 'system', content: '分析以下实体之间的潜在关联。输出简短的一句话描述。' },
                    { role: 'user', content: `实体: ${entityNames}\n它们之间可能有什么关联？` }
                ], { maxTokens: 100 });

                if (result && this.memoryManager) {
                    const assocKey = `Assoc_${Date.now()}`;
                    await this.memoryManager.pushMemory(
                        `[Association] ${entityNames} → ${result}`,
                        'L2', assocKey
                    );
                }
            } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
        }
    }

    async _analyzeTrends() {
        if (!this.deviceManager || !this.localInference || !this.localInference.isReady()) return;
        if (this._stateChangeCount < 3) return;

        try {
            // 收集最近N个状态快照中的数值指标
            const report = this.deviceManager.getFullReport();
            if (!report) return;

            const indicators = {};
            // CPU
            if (report.sensors?.cpu?.usagePercent !== undefined) {
                indicators.cpu = report.sensors.cpu.usagePercent;
            }
            // 内存
            if (report.sensors?.memory?.usagePercent !== undefined) {
                indicators.memory = parseFloat(report.sensors.memory.usagePercent);
            }
            // 磁盘
            if (report.sensors?.disk && report.sensors.disk.length > 0) {
                const mainDisk = report.sensors.disk[0];
                indicators.diskFree = mainDisk.freeBytes;
                indicators.diskTotal = mainDisk.totalBytes;
                indicators.diskUsage = ((mainDisk.totalBytes - mainDisk.freeBytes) / mainDisk.totalBytes * 100);
            }

            // 检测显著变化
            const changes = [];
            if (this._lastDeviceState && this._lastDeviceState.sensors) {
                const prev = this._lastDeviceState;
                if (prev.sensors?.cpu?.usagePercent !== undefined && indicators.cpu !== undefined) {
                    const delta = indicators.cpu - prev.sensors.cpu.usagePercent;
                    if (Math.abs(delta) > 20) {
                        changes.push(`CPU${delta > 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(0)}%`);
                    }
                }
                if (prev.sensors?.memory?.usagePercent !== undefined && indicators.memory !== undefined) {
                    const prevMem = parseFloat(prev.sensors.memory.usagePercent);
                    const delta = indicators.memory - prevMem;
                    if (Math.abs(delta) > 15) {
                        changes.push(`内存${delta > 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(0)}%`);
                    }
                }
            }

            // 存储趋势分析结果到记忆
            if (changes.length > 0 && this.memoryManager) {
                const trendReport = `[TrendAnalysis] 系统状态变化: ${changes.join(', ')}`;
                await this.memoryManager.pushMemory(trendReport, 'L2', `trend_${Date.now()}`);
                this.stats.patternsFound += changes.length;
            }

            // 周期性变化检测（内存持续增长 = 泄漏嫌疑）
            if (this._stateChangeCount >= 5 && this.memoryManager) {
                const l2Layer = this.memoryManager.layers.L2;
                if (l2Layer && l2Layer.size > 0) {
                    const memoryEntries = [];
                    for (const [id, item] of l2Layer) {
                        const content = typeof item.content === 'string' ? item.content : '';
                        if (content.includes('[DeviceState]') || content.includes('[StateChange]')) {
                            memoryEntries.push({ id, content, ts: item.timestamp || 0 });
                        }
                    }
                    // 检查内存使用趋势
                    if (memoryEntries.length >= 3 && indicators.memory !== undefined) {
                        const memValues = memoryEntries
                            .map(e => {
                                const match = e.content.match(/memory[:\s]*(\d+\.?\d*)/i);
                                return match ? parseFloat(match[1]) : null;
                            })
                            .filter(v => v !== null);
                        if (memValues.length >= 3) {
                            const isIncreasing = memValues.every((v, i) => i === 0 || v >= memValues[i - 1]);
                            if (isIncreasing) {
                                const insightKey = `Insight_memory_leak_${Date.now()}`;
                                await this.memoryManager.pushMemory(
                                    `[CognitiveInsight] 内存使用持续上升趋势，可能存内存泄漏风险`,
                                    'L3', insightKey
                                );
                                this.stats.insightsGenerated++;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[ContinualLearner] Trend analysis error:', e.message);
        }
    }

    // 环3: 自动进化

    async evolveCycle() {
        const start = Date.now();

        // 1. L2 → L3 知识升华
        await this._sublimateKnowledge();

        // 2. 行为校准 - 根据积累的模式优化响应
        await this._calibrateBehavior();

        // 3. 生成进化报告
        await this._generateEvolutionReport();

        this.stats.lastEvolveTime = new Date();
        this.stats.totalEvolved++;
    }

    async _sublimateKnowledge() {
        if (!this.memoryManager) return;

        const li = this.localInference;
        const l2Layer = this.memoryManager.layers.L2;
        if (!l2Layer || l2Layer.size < 2) return;

        // 找频率高的模式，升华为核心洞察
        const patterns = [];
        for (const [id, item] of l2Layer) {
            const content = typeof item.content === 'object' ? item.content : {};
            if (content.type === 'pattern' && content.count >= 2) {
                patterns.push(content);
            }
        }

        if (patterns.length === 0) return;

        // 用本地小模型做进化（原来是调云端 LLM）
        if (li && li.isReady() && li.getCapabilities().chat) {
            for (const pattern of patterns.slice(0, 3)) {
                try {
                    const insight = await li.chat([
                        { role: 'system', content: '你是一个认知进化引擎。将以下经验模式升华为一个通用的、可迁移的原则。输出一句话。' },
                        { role: 'user', content: `模式: ${pattern.pattern}\n出现次数: ${pattern.count}\n升华原则:` }
                    ], { temperature: 0.4, maxTokens: 128 });

                    if (insight && this.memoryManager) {
                        const insightKey = `Insight_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                        await this.memoryManager.pushMemory(
                            `[CognitiveInsight] ${pattern.pattern} → ${insight}`,
                            'L3', insightKey
                        );
                        this.stats.insightsGenerated++;
                    }
                } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
            }
        }
    }

    async _calibrateBehavior() {
        if (!this.memoryManager || !this.localInference || !this.localInference.isReady()) return;

        const l3Layer = this.memoryManager.layers.L3;
        if (!l3Layer || l3Layer.size < 2) return;

        // 检查是否有足够的洞察来影响行为
        const insights = Array.from(l3Layer.values())
            .filter(i => typeof i.content === 'string' && i.content.includes('[CognitiveInsight]'));

        if (insights.length >= 3) {
            // 生成行为优化建议
            const insightsText = insights.slice(-5).map(i =>
                typeof i.content === 'string' ? i.content : ''
            ).join('\n');

            try {
                const recommendation = await this.localInference.chat([
                    { role: 'system', content: '基于积累的核心洞察，给出1条行为优化建议，让智能体更高效。一句话。' },
                    { role: 'user', content: insightsText }
                ], { maxTokens: 100 });

                if (recommendation && this.memoryManager) {
                    await this.memoryManager.pushMemory(
                        `[BehaviorCalibration] ${recommendation}`,
                        'L3'
                    );
                }
            } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
        }
    }

    async _generateEvolutionReport() {
        if (this.stats.totalEvolved % 3 !== 0) return; // 每3次进化周期出一次报告

        const report = {
            timestamp: new Date().toISOString(),
            uptime: Date.now() - (this.stats.startTime || Date.now()),
            absorbed: this.stats.totalAbsorbed,
            analyzed: this.stats.totalAnalyzed,
            evolved: this.stats.totalEvolved,
            patternsFound: this.stats.patternsFound,
            insightsGenerated: this.stats.insightsGenerated,
            stateChanges: this._stateChangeCount,
            memorySize: this.memoryManager ? this.memoryManager.getMemorySize() : 0
        };

        if (this.memoryManager) {
            await this.memoryManager.pushMemory(
                `[EvolutionReport] ${JSON.stringify(report)}`,
                'L2', `report_${Date.now()}`
            );
        }

        // 持久化学习数据
        this._saveLearningData(report);
    }

    _saveLearningData(report) {
        try {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.join(this._learningDir, 'evolution.json');
            let history = [];
            try {
                history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
            history.push(report);
            if (history.length > 100) history = history.slice(-100);
            fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
        } catch (e) { console.warn(`[ContinualLearner] Error: ${e.message}`); }
    }

    async getLearningReport() {
        const l3Count = this.memoryManager ? this.memoryManager.layers.L3.size : 0;
        const l2Count = this.memoryManager ? this.memoryManager.layers.L2.size : 0;

        return {
            running: this._running,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
            ...this.stats,
            memoryL2: l2Count,
            memoryL3: l3Count,
            inferenceStats: this.localInference ? this.localInference.getStats() : null,
            inferenceReady: this.localInference ? this.localInference.isReady() : false
        };
    }

    _hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }
}

module.exports = ContinualLearner;
