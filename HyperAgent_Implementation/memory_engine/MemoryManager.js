// MemoryManager — layered memory store
const fs = require('fs');
const path = require('path');
const VectorStore = require('./VectorStore');

class MemoryManager {
    constructor(options = {}) {
        this.layers = { L0: new Map(), L1: new Map(), L2: new Map(), L3: new Map() };
        this.workingMemory = {
            activeContext: null,
            recentEntities: new Map(),
            currentGoal: null
        };

        this.storageDir = options.storageDir || 'mem_store';
        this.pageLimit = options.pageLimit || 500;
        this.accessLog = [];
        this.autoPruneEnabled = options.autoPrune !== false;
        this.llmAdapter = options.llmAdapter || null;

        // A.U.D.N. 整合器
        this._audnConsolidator = null;

        // 向量存储
        const embedConfig = options.embedding || {};
        this.vectorStore = new VectorStore({
            distanceThreshold: 0.55,
            embeddingMode: embedConfig.mode || process.env.EMBEDDING_MODE || 'hybrid',
            embeddingApiUrl: embedConfig.apiUrl || process.env.EMBEDDING_API_URL || '',
            embeddingApiKey: embedConfig.apiKey || process.env.EMBEDDING_API_KEY || '',
            embeddingModel: embedConfig.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
            dimension: embedConfig.dimension || 1536,
            embeddingBatchSize: embedConfig.batchSize || 20,
            localInference: options.localInference || null,
            cacheMaxSize: embedConfig.cacheSize || 5000
        });

        // 记忆索引缓存
        this._vectorIndexed = new Set();
        this._lastVectorIndexTime = 0;

        // 跨会话
        this._crossSessionLoaded = false;

        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // 启动时从磁盘恢复
        this._recoverFromDisk();
    }

    // 跨会话记忆加载

    /** 加载跨会话记忆到向量索引 */
    async loadCrossSessionMemories() {
        if (this._crossSessionLoaded) return;
        this._crossSessionLoaded = true;

        let loadedCount = 0;
        for (const level of ['L3', 'L2']) {
            const items = this.getLayer(level);
            for (const item of items) {
                const content = typeof item.content === 'string'
                    ? item.content
                    : JSON.stringify(item.content);

                if (content.length > 10 && content.length < 3000) {
                    this.vectorStore.add(content, {
                        memoryId: item.id,
                        level,
                        importance: level === 'L3' ? 0.9 : 0.5,
                        tags: item.tags || this._extractTags(content),
                        source: 'cross_session',
                        timestamp: item.timestamp || new Date().toISOString()
                    });
                    this._vectorIndexed.add(item.id);
                    loadedCount++;
                }
            }
        }

        console.log(`[MemoryManager] 跨会话加载 ${loadedCount} 条记忆到向量索引`);
        return loadedCount;
    }

    setLLMAdapter(adapter) {
        this.llmAdapter = adapter;
    }

    setAUDNConsolidator(consolidator) {
        this._audnConsolidator = consolidator;
    }

    // Working Memory

    setWorkingContext(key, value) {
        this.workingMemory[key] = value;
    }

    getWorkingContext(key) {
        return this.workingMemory[key];
    }

    trackEntity(name, type, metadata = {}) {
        const existing = this.workingMemory.recentEntities.get(name);
        if (existing) {
            existing.mentionCount = (existing.mentionCount || 1) + 1;
            existing.lastSeen = Date.now();
            Object.assign(existing, metadata);
        } else {
            this.workingMemory.recentEntities.set(name, {
                type, mentionCount: 1, firstSeen: Date.now(), lastSeen: Date.now(), ...metadata
            });
        }
        // 工作记忆上限50
        if (this.workingMemory.recentEntities.size > 50) {
            const oldest = [...this.workingMemory.recentEntities.entries()]
                .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
            if (oldest) this.workingMemory.recentEntities.delete(oldest[0]);
        }
    }

    getActiveEntities(minMentions = 1) {
        const result = [];
        const now = Date.now();
        for (const [name, data] of this.workingMemory.recentEntities) {
            if (data.mentionCount >= minMentions && (now - data.lastSeen) < 600000) {
                result.push({ name, ...data });
            }
        }
        return result;
    }

    // 核心记忆操作

    async pushMemory(content, level = 'L1', id = null) {
        const memId = id || `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

        const item = {
            id: memId,
            content,
            level,
            timestamp: new Date().toISOString(),
            accessCount: 0,
            promoted: false,
            tags: this._extractTags(contentStr),
            importance: this._assessImportance(contentStr),
            entities: {}
        };

        this.layers[level].set(memId, item);
        await this._managePage(level);
        await this._persist(memId, item, level);

        // 推送至 A.U.D.N. 整合器
        if (this._audnConsolidator && level === 'L0') {
            this._audnConsolidator.addItem(contentStr, { memoryId: memId, level });
        }

        // 自动索引到向量存储
        if (contentStr.length > 10 && contentStr.length < 3000 && level !== 'L0') {
            this.vectorStore.add(contentStr, {
                memoryId: memId,
                level,
                importance: item.importance,
                tags: item.tags,
                source: 'memory',
                timestamp: item.timestamp
            });
            this._vectorIndexed.add(memId);
        }

        return memId;
    }

    /**
     * 增强检索：关键词 + 语义 + 时间衰减
     */
    async retrieve(query, options = {}) {
        const {
            caseSensitive = false,
            searchLevels = ['L3', 'L2', 'L1', 'L0'],
            limit = 50,
            useRelevance = false,
            useSemantic = true
        } = options;

        const results = [];
        const queryStr = caseSensitive ? query : query.toLowerCase();

        // 语义搜索

        if (useSemantic && this.vectorStore.entries.size > 0) {
            try {
                const semanticResults = this.vectorStore.search(query, limit * 2);
                for (const r of semanticResults) {
                    if (r.distance < 0.7) {
                        results.push({
                            id: r.metadata?.memoryId || `vec_${Date.now()}`,
                            content: r.text,
                            level: r.metadata?.level || 'L1',
                            score: (1 - r.distance) * 10,
                            relevanceScore: (1 - r.distance) * 10,
                            source: 'semantic',
                            tags: r.metadata?.tags || [],
                            timestamp: r.metadata?.timestamp || new Date().toISOString(),
                            accessCount: 0
                        });
                    }
                }
            } catch (e) {
                // 向量搜索失败，降级到关键词
            }
        }

        // 关键词搜索

        const keywordResults = [];
        for (const level of searchLevels) {
            const layer = this.layers[level];
            for (const [, item] of layer) {
                const content = (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).toLowerCase();
                if (content.includes(queryStr)) {
                    item.accessCount = (item.accessCount || 0) + 1;
                    keywordResults.push({ ...item, score: item.accessCount, source: 'keyword' });
                }
            }
            if (keywordResults.length < 10 && level !== 'L0') {
                await this._loadFromDisk(level);
            }
        }

        // 合并结果

        const seen = new Set();
        const merged = [];

        // 语义结果优先
        for (const r of results) {
            const key = typeof r.content === 'string' ? r.content.substring(0, 50) : r.id;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(r);
            }
        }

        // 补充关键词结果
        for (const r of keywordResults) {
            const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
            const key = content.substring(0, 50);
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({
                    ...r,
                    score: (r.score || 0) / 2, // 关键词分减半
                    relevanceScore: (r.relevanceScore || 0) / 2
                });
            }
        }

        // 排序

        if (useRelevance) {
            const now = Date.now();
            return merged.map(r => {
                const age = r.timestamp ? (now - new Date(r.timestamp).getTime()) : 86400000;
                const recencyBoost = Math.max(0, 1 - age / 604800000); // 7天衰减
                const freqScore = Math.min((r.accessCount || 0) / 10, 1);
                const semanticBoost = r.source === 'semantic' ? 2 : 1;
                r.relevanceScore = (freqScore * 0.3 + recencyBoost * 0.3 + (r.score || 0) / 10 * 0.4) * semanticBoost * 5;
                return r;
            }).sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
        }

        return merged.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    async retrieveByTag(tag, options = {}) {
        const { searchLevels = ['L3', 'L2', 'L1'], limit = 50 } = options;
        const results = [];
        for (const level of searchLevels) {
            for (const [, item] of this.layers[level]) {
                if (item.tags && item.tags.includes(tag)) results.push(item);
            }
        }
        return results.slice(0, limit);
    }

    /**
     * 多维度检索
     */
    async smartRetrieve(criteria, options = {}) {
        const { limit = 20, levels = ['L3', 'L2', 'L1'] } = options;
        let results = [];

        if (criteria.text) {
            results = await this.retrieve(criteria.text, {
                searchLevels: levels,
                limit: limit * 2,
                useRelevance: true,
                useSemantic: true
            });
        }

        if (criteria.tags && criteria.tags.length > 0) {
            for (const tag of criteria.tags) {
                const tagged = await this.retrieveByTag(tag, { searchLevels: levels });
                for (const item of tagged) {
                    if (!results.find(r => r.id === item.id)) results.push(item);
                }
            }
        }

        if (criteria.since) {
            const sinceTime = new Date(criteria.since).getTime();
            results = results.filter(r => r.timestamp && new Date(r.timestamp).getTime() >= sinceTime);
        }
        if (criteria.until) {
            const untilTime = new Date(criteria.until).getTime();
            results = results.filter(r => r.timestamp && new Date(r.timestamp).getTime() <= untilTime);
        }

        return results.slice(0, limit);
    }

    // 记忆管理

    async _managePage(level) {
        const layer = this.layers[level];
        if (layer.size > this.pageLimit) {
            const items = Array.from(layer.entries());
            items.sort((a, b) => (a[1].importance || 0) - (b[1].importance || 0));
            const coldCount = layer.size - this.pageLimit;
            for (let i = 0; i < coldCount && i < items.length; i++) {
                await this._persist(items[i][0], items[i][1], level);
                layer.delete(items[i][0]);
            }
        }
    }

    async autoPrune() {
        if (!this.autoPruneEnabled) return;
        const now = Date.now();
        const ttl = { L0: 7 * 86400000, L1: 30 * 86400000, L2: 90 * 86400000 }; // L3永久
        let pruned = 0;

        for (const [level, ttl_ms] of Object.entries(ttl)) {
            const layer = this.layers[level];
            if (!layer) continue;

            const toDelete = [];
            for (const [id, item] of layer) {
                const age = item.timestamp ? now - new Date(item.timestamp).getTime() : 0;
                if (age > ttl_ms && (item.importance || 0) < 0.6) {
                    toDelete.push(id);
                }
            }

            for (const id of toDelete) {
                layer.delete(id);
                // 从向量存储移除
                for (const [vecId, entry] of this.vectorStore.entries) {
                    if (entry.metadata?.memoryId === id) {
                        this.vectorStore.remove(vecId);
                        break;
                    }
                }
                pruned++;
            }

            // 删除持久化文件
            for (const id of toDelete) {
                const filePath = path.join(this.storageDir, `${level}_${id}.json`);
                try { fs.unlinkSync(filePath); } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }
            }
        }

        if (pruned > 0) {
            console.log(`[MemoryManager] 自动剪枝: 移除了 ${pruned} 条过期记忆`);
        }
    }

    // 持久化

    async _loadFromDisk(level) {
        try {
            const files = await fs.promises.readdir(this.storageDir);
            for (const file of files.filter(f => f.startsWith(`${level}_`))) {
                const data = JSON.parse(await fs.promises.readFile(path.join(this.storageDir, file), 'utf8'));
                if (!this.layers[level].has(data.id)) {
                    this.layers[level].set(data.id, data);
                }
            }
        } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }
    }

    async _persist(id, item, level) {
        await fs.promises.writeFile(
            path.join(this.storageDir, `${level}_${item.id || id}.json`),
            JSON.stringify(item)
        );
    }

    async _recoverFromDisk() {
        let recovered = 0;
        for (const level of ['L1', 'L2', 'L3']) {
            try {
                const files = await fs.promises.readdir(this.storageDir);
                for (const file of files.filter(f => f.startsWith(`${level}_`))) {
                    const data = JSON.parse(await fs.promises.readFile(path.join(this.storageDir, file), 'utf8'));
                    if (!this.layers[level].has(data.id)) {
                        this.layers[level].set(data.id, data);
                        recovered++;
                    }
                }
            } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }
        }
        if (recovered > 0) {
            console.log(`[MemoryManager] 从磁盘恢复 ${recovered} 条记忆`);
        }
    }

    // 工具方法

    _extractTags(content) {
        const str = typeof content === 'string' ? content : JSON.stringify(content);
        const matches = str.match(/#(\w+)/g);
        const hashtags = matches ? [...new Set(matches.map(t => t.slice(1)))] : [];

        // 内容关键词标签
        const tagMap = {
            '文件': ['文件', '文档', '目录', '路径'],
            '代码': ['代码', '程序', '脚本', '函数', 'API'],
            '系统': ['系统', '进程', '服务', '配置'],
            '网络': ['网络', 'HTTP', 'URL', '请求'],
            '数据': ['数据', '分析', '统计', '报告'],
            '对话': ['对话', '聊天', '用户'],
            '工具': ['工具', '命令', '执行'],
            '设备': ['设备', 'CPU', '内存', '磁盘'],
            '错误': ['错误', '失败', '异常'],
        };

        const contentTags = [];
        for (const [tag, keywords] of Object.entries(tagMap)) {
            if (keywords.some(k => str.includes(k))) contentTags.push(tag);
        }

        return [...new Set([...hashtags, ...contentTags])];
    }

    _assessImportance(content) {
        const str = typeof content === 'string' ? content : JSON.stringify(content);

        const highSignal = [
            '记住', '重要', '必须', '核心', '关键', '永远', '规则',
            '决定', '偏好', '喜欢', '不喜欢', '禁止',
            '[失败模式]', '[认知洞察]', '[核心洞察]',
            '[失败]', '[经验]', '[教训]', '[行为校准]',
            'important', 'critical', 'essential', 'must', 'always', 'never',
        ];

        for (const s of highSignal) {
            if (str.includes(s)) return 0.8 + Math.random() * 0.15;
        }

        const baseScore = Math.min(0.6, str.length / 500 * 0.5);
        return baseScore;
    }

    // 统计 & 管理

    getMemorySize() {
        return Object.values(this.layers).reduce((sum, m) => sum + m.size, 0);
    }

    getStats() {
        const stats = {};
        for (const [level, map] of Object.entries(this.layers)) {
            stats[level] = { count: map.size };
        }
        stats.total = this.getMemorySize();
        stats.vectorIndex = this.vectorStore.entries.size;
        stats.workingMemory = {
            entityCount: this.workingMemory.recentEntities.size,
            activeContext: !!this.workingMemory.activeContext,
            currentGoal: this.workingMemory.currentGoal
        };
        return stats;
    }

    clearLevel(level) {
        if (this.layers[level]) { this.layers[level].clear(); return true; }
        return false;
    }

    exportAll() {
        const data = {};
        for (const [level, map] of Object.entries(this.layers)) {
            data[level] = Array.from(map.values());
        }
        return data;
    }

    async import(data) {
        for (const [level, items] of Object.entries(data)) {
            if (this.layers[level]) {
                for (const item of items) {
                    this.layers[level].set(item.id, item);
                    await this._persist(item.id, item, level);
                }
            }
        }
    }

    getLayer(level) {
        const layer = this.layers[level];
        return layer ? Array.from(layer.values()) : [];
    }
}

module.exports = MemoryManager;
