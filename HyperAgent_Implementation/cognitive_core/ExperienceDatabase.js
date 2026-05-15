/**
 * ExperienceDatabase — persistent knowledge store for all carrier experience data with multi-index retrieval.
 */

const fs = require('fs');
const path = require('path');

class ExperienceDatabase {
    constructor(options = {}) {
        this.storageDir = options.storageDir || path.join(process.cwd(), 'experience_store');
        this.maxMemEntries = options.maxMemEntries || 10000;  // Archive to disk when exceeded
        this.archiveBatchSize = options.archiveBatchSize || 1000;
        this.importanceWeights = options.importanceWeights || {
            novelty: 0.3,          // 新信息 vs 重复信息
            impact: 0.3,           // 对系统/用户的影响程度
            frequency: 0.2,        // 同类经验的稀有度
            recency: 0.1,          // 时间衰减
            complexity: 0.1        // 数据丰富度
        };

        // 内存缓存（热数据）
        this._experiences = new Map();          // id → experience
        this._indices = {
            byTime: [],                          // 按时间排序的 id 列表
            byType: new Map(),                   // type → Set<id>
            byImportance: [],                    // 按重要性排序的 id 列表
            byTags: new Map(),                   // tag → Set<id>
            byDate: new Map()                    // YYYY-MM-DD → Set<id>
        };
        this._stats = {
            totalExperiences: 0,
            archivedExperiences: 0,
            uniqueTypes: new Set(),
            startTime: Date.now(),
            lastArchiveTime: null,
            topTags: new Map()
        };

        // 内存上限控制
        this._isArchiving = false;

        // 确保存储目录存在
        this._ensureDirectories();

        // 从磁盘恢复
        this._recoverFromDisk();
    }

    // Public API

    /**
     * 记录一条经验
     * @param {string} type - 类型: state_snapshot | user_interaction | tool_execution | environment_change
     * @param {object} data - 经验数据
     * @param {object} [context] - 上下文信息
     * @returns {string} 经验ID
     */
    async record(type, data, context = {}) {
        const id = this._generateId(type);
        const now = new Date();

        const experience = {
            id,
            type,
            timestamp: now.toISOString(),
            timestampEpoch: Date.now(),
            data: this._sanitize(data),
            context: this._sanitize(context),
            outcome: null,
            importance: 0,
            accessCount: 0,
            lastAccess: null,
            tags: this._extractTags(data, context),
            metadata: {
                source: context.source || 'auto',
                confidence: context.confidence || 1.0,
                version: 1
            }
        };

        // 自动评估重要性
        experience.importance = this._assessImportance(experience);

        // 更新统计
        this._stats.totalExperiences++;
        this._stats.uniqueTypes.add(type);

        // Archive oldest entries if memory limit exceeded
        if (this._experiences.size >= this.maxMemEntries) {
            await this._archiveBatch();
        }

        // 存入内存
        this._experiences.set(id, experience);
        this._updateIndices(id, experience);

        return id;
    }

    /**
     * 批量记录经验
     */
    async recordBatch(experiences) {
        const ids = [];
        for (const exp of experiences) {
            const id = await this.record(exp.type, exp.data, exp.context || {});
            ids.push(id);
        }
        return ids;
    }

    /**
     * 查询经验
     * @param {object} filters
     * @param {string} [filters.type] - 按类型过滤
     * @param {number} [filters.limit=100] - 返回条数
     * @param {number} [filters.offset=0] - 偏移
     * @param {string} [filters.sortBy='time'] - time | importance
     * @param {boolean} [filters.desc=true] - 降序
     * @param {string} [filters.tag] - 按标签过滤
     * @param {string} [filters.date] - 按日期 YYYY-MM-DD
     * @param {number} [filters.startTime] - 起始时间戳
     * @param {number} [filters.endTime] - 结束时间戳
     * @returns {object[]}
     */
    query(filters = {}) {
        const {
            type = null,
            limit = 100,
            offset = 0,
            sortBy = 'time',
            desc = true,
            tag = null,
            date = null,
            startTime = null,
            endTime = null
        } = filters;

        let ids = this._getCandidateIds(type, tag, date, startTime, endTime);

        // 排序
        if (sortBy === 'importance') {
            ids.sort((a, b) => {
                const ea = this._experiences.get(a);
                const eb = this._experiences.get(b);
                return (ea && eb) ? (desc ? eb.importance - ea.importance : ea.importance - eb.importance) : 0;
            });
        } else {
            ids.sort((a, b) => {
                const ea = this._experiences.get(a);
                const eb = this._experiences.get(b);
                return (ea && eb) ? (desc ? eb.timestampEpoch - ea.timestampEpoch : ea.timestampEpoch - eb.timestampEpoch) : 0;
            });
        }

        // 分页
        const page = ids.slice(offset, offset + limit);
        return page.map(id => this._experiences.get(id)).filter(Boolean);
    }

    /**
     * 根据 ID 获取单条经验
     */
    get(id) {
        const exp = this._experiences.get(id);
        if (exp) {
            exp.accessCount++;
            exp.lastAccess = new Date().toISOString();
        }
        return exp ? { ...exp } : null;
    }

    /**
     * 记录经验的后续结果
     */
    async setOutcome(experienceId, outcome) {
        const exp = this._experiences.get(experienceId);
        if (!exp) return false;

        exp.outcome = this._sanitize(outcome);
        exp.metadata.version++;

        // 结果可能会影响重要性
        if (outcome && (outcome.success !== undefined || outcome.error)) {
            exp.importance = Math.min(1.0, exp.importance + 0.1);
        }

        return true;
    }

    /**
     * 删除经验（标记删除）
     */
    async delete(id) {
        const exp = this._experiences.get(id);
        if (!exp) return false;
        exp.metadata.deleted = true;
        // Mark as deleted rather than actually removing
        return true;
    }

    /**
     * 获取经验统计
     */
    getStats() {
        return {
            totalExperiences: this._stats.totalExperiences,
            archivedExperiences: this._stats.archivedExperiences,
            inMemory: this._experiences.size,
            uniqueTypes: Array.from(this._stats.uniqueTypes),
            types: Array.from(this._indices.byType.keys()).map(t => ({
                type: t,
                count: this._indices.byType.get(t).size
            })),
            uptime: Date.now() - this._stats.startTime,
            lastArchive: this._stats.lastArchiveTime,
            topTags: Array.from(this._stats.topTags.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([tag, count]) => ({ tag, count }))
        };
    }

    /**
     * 获取按重要性排序的前 N 条重要经验
     */
    getImportantExperiences(n = 10, minImportance = 0.3) {
        const candidates = [];
        for (const [id, exp] of this._experiences) {
            if (exp.importance >= minImportance && !exp.metadata.deleted) {
                candidates.push(exp);
            }
        }
        return candidates
            .sort((a, b) => b.importance - a.importance)
            .slice(0, n);
    }

    /**
     * 获取最近的 N 条经验
     */
    getRecent(n = 10, type = null) {
        let ids = type
            ? Array.from(this._indices.byType.get(type) || [])
            : Array.from(this._experiences.keys());

        ids.sort((a, b) => {
            const ea = this._experiences.get(a);
            const eb = this._experiences.get(b);
            return (ea && eb) ? eb.timestampEpoch - ea.timestampEpoch : 0;
        });

        return ids.slice(0, n).map(id => this._experiences.get(id)).filter(Boolean);
    }

    /**
     * 搜索经验内容
     */
    search(keyword, options = {}) {
        const { limit = 50, type = null } = options;
        const kw = keyword.toLowerCase();

        const results = [];
        for (const [id, exp] of this._experiences) {
            if (exp.metadata.deleted) continue;
            if (type && exp.type !== type) continue;

            const haystack = JSON.stringify(exp.data).toLowerCase();
            if (haystack.includes(kw) || (exp.tags && exp.tags.some(t => t.toLowerCase().includes(kw)))) {
                results.push({ id, ...exp });
            }
        }

        return results
            .sort((a, b) => b.importance - a.importance)
            .slice(0, limit);
    }

    /**
     * 持久化到磁盘
     */
    async persist() {
        try {
            // 将当前内存数据写入磁盘
            const dataPath = path.join(this.storageDir, 'experiences_active.json');
            const data = {
                version: 1,
                exportedAt: new Date().toISOString(),
                count: this._experiences.size,
                experiences: Array.from(this._experiences.values())
                    .filter(e => !e.metadata.deleted)
                    .slice(-this.maxMemEntries) // 只保留最新的
            };
            fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

            // 保存统计
            const statsPath = path.join(this.storageDir, 'experience_stats.json');
            fs.writeFileSync(statsPath, JSON.stringify({
                ...this._stats,
                uniqueTypes: Array.from(this._stats.uniqueTypes),
                topTags: Array.from(this._stats.topTags.entries())
            }, null, 2), 'utf8');

            return true;
        } catch (e) {
            console.error('[ExperienceDB] Persist error:', e.message);
            return false;
        }
    }

    /**
     * 清除所有数据（慎用）
     */
    async clear() {
        this._experiences.clear();
        this._indices.byType.clear();
        this._indices.byTags.clear();
        this._indices.byDate.clear();
        this._indices.byTime = [];
        this._indices.byImportance = [];
        this._stats.totalExperiences = 0;
        this._stats.archivedExperiences = 0;
        this._stats.uniqueTypes.clear();
        this._stats.topTags.clear();

        // 清理磁盘
        try {
            const files = fs.readdirSync(this.storageDir);
            for (const f of files) {
                if (f.endsWith('.json')) {
                    fs.unlinkSync(path.join(this.storageDir, f));
                }
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        return true;
    }

    // Internal

    _generateId(type) {
        const prefix = type.substring(0, 3);
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).substring(2, 6);
        return `${prefix}_${ts}_${rand}`;
    }

    _sanitize(data) {
        if (typeof data === 'string') return data;
        if (typeof data === 'number' || typeof data === 'boolean') return data;
        if (data === null || data === undefined) return null;
        if (Array.isArray(data)) return data.map(d => this._sanitize(d));
        if (typeof data === 'object') {
            const sanitized = {};
            for (const [key, value] of Object.entries(data)) {
                if (typeof value === 'function' || typeof value === 'symbol') continue;
                sanitized[key] = this._sanitize(value);
            }
            return sanitized;
        }
        return String(data);
    }

    _extractTags(data, context = {}) {
        const tags = new Set();

        // 从数据类型提取
        if (context.tags && Array.isArray(context.tags)) {
            context.tags.forEach(t => tags.add(t));
        }

        // 从数据中提取数值范围标签
        if (data && typeof data === 'object') {
            for (const [key, value] of Object.entries(data)) {
                if (typeof value === 'number') {
                    if (value > 80) tags.add(`high_${key}`);
                    if (value < 20) tags.add(`low_${key}`);
                }
                if (typeof value === 'string' && value.length < 50) {
                    tags.add(`${key}_${value.toLowerCase().replace(/\s+/g, '_')}`);
                }
                if (key === 'error' || key === 'warning' || key === 'critical') {
                    tags.add(key);
                }
                if (key === 'status') {
                    tags.add(`status_${String(value).toLowerCase()}`);
                }
            }
        }

        // 时间标签
        const hour = new Date().getHours();
        tags.add(`hour_${hour}`);
        tags.add(hour < 6 ? 'period_night' : hour < 12 ? 'period_morning' : hour < 18 ? 'period_afternoon' : 'period_evening');

        return Array.from(tags).slice(0, 20);
    }

    _assessImportance(experience) {
        const data = experience.data;
        let score = 0.1; // 基础分

        // 1. 新颖性（首次出现的概念/模式）
        const typeCount = this._indices.byType.get(experience.type)?.size || 0;
        if (typeCount < 5) score += 0.2; // 新类型的前几条经验

        // 2. 影响度
        if (data && typeof data === 'object') {
            if (data.error) score += 0.3;
            if (data.critical || data.critical === true) score += 0.3;
            if (data.warning) score += 0.15;
            if (data.success === false) score += 0.2;
            if (data.status === 'error' || data.status === 'critical') score += 0.25;
            if (data.impact) score += Math.min(0.3, data.impact * 0.3);
        }

        // 3. Time decay — handled via sort order at query time

        // 4. 数据复杂度
        if (data) {
            const strLen = JSON.stringify(data).length;
            if (strLen > 500) score += 0.1;
            if (strLen > 2000) score += 0.1;
        }

        // 5. 用户交互的优先级
        if (experience.type === 'user_interaction') score += 0.15;

        return Math.min(1.0, Math.max(0, score));
    }

    _updateIndices(id, experience) {
        // 按类型索引
        if (!this._indices.byType.has(experience.type)) {
            this._indices.byType.set(experience.type, new Set());
        }
        this._indices.byType.get(experience.type).add(id);

        // 按时间索引
        this._indices.byTime.push(id);

        // 按重要性索引
        this._indices.byImportance.push(id);

        // 按标签索引
        for (const tag of experience.tags) {
            if (!this._indices.byTags.has(tag)) {
                this._indices.byTags.set(tag, new Set());
            }
            this._indices.byTags.get(tag).add(id);
            this._stats.topTags.set(tag, (this._stats.topTags.get(tag) || 0) + 1);
        }

        // 按日期索引
        const dateKey = experience.timestamp.substring(0, 10);
        if (!this._indices.byDate.has(dateKey)) {
            this._indices.byDate.set(dateKey, new Set());
        }
        this._indices.byDate.get(dateKey).add(id);
    }

    _getCandidateIds(type, tag, date, startTime, endTime) {
        let sets = [];

        // 类型过滤
        if (type) {
            const typeSet = this._indices.byType.get(type);
            if (!typeSet) return [];
            sets.push(typeSet);
        }

        // 标签过滤
        if (tag) {
            const tagSet = this._indices.byTags.get(tag);
            if (!tagSet) return [];
            sets.push(tagSet);
        }

        // 日期过滤
        if (date) {
            const dateSet = this._indices.byDate.get(date);
            if (!dateSet) return [];
            sets.push(dateSet);
        }

        // 时间范围过滤
        if (startTime || endTime) {
            const timeSet = new Set();
            for (const [id, exp] of this._experiences) {
                if (startTime && exp.timestampEpoch < startTime) continue;
                if (endTime && exp.timestampEpoch > endTime) continue;
                timeSet.add(id);
            }
            sets.push(timeSet);
        }

        // No filters: return all non-deleted IDs
        if (sets.length === 0) {
            const all = new Set();
            for (const [id, exp] of this._experiences) {
                if (!exp.metadata.deleted) all.add(id);
            }
            return Array.from(all);
        }

        // 交集计算
        const base = sets.reduce((a, b) => a.size < b.size ? a : b);
        const result = new Set();
        for (const id of base) {
            if (sets.every(s => s.has(id))) {
                const exp = this._experiences.get(id);
                if (exp && !exp.metadata.deleted) {
                    result.add(id);
                }
            }
        }

        return Array.from(result);
    }

    async _archiveBatch() {
        if (this._isArchiving) return;
        this._isArchiving = true;

        try {
            // 找到最不重要且最旧的批量经验进行归档
            const candidates = Array.from(this._experiences.entries())
                .filter(([_, exp]) => !exp.metadata.deleted)
                .sort((a, b) => {
                    // 按 (重要性升序, 时间升序) 排序
                    const impDiff = a[1].importance - b[1].importance;
                    if (impDiff !== 0) return impDiff;
                    return a[1].timestampEpoch - b[1].timestampEpoch;
                });

            const toArchive = candidates.slice(0, this.archiveBatchSize);
            if (toArchive.length === 0) { this._isArchiving = false; return; }

            // 写入归档文件
            const archiveFile = path.join(
                this.storageDir,
                'archives',
                `archive_${Date.now()}.json`
            );
            const archiveData = toArchive.map(([id, exp]) => exp);
            fs.writeFileSync(archiveFile, JSON.stringify(archiveData, null, 2), 'utf8');

            // 从内存中移除
            for (const [id] of toArchive) {
                this._experiences.delete(id);
                // 从索引中移除（简化为重建索引的惰性方式）
            }

            this._stats.archivedExperiences += toArchive.length;
            this._stats.lastArchiveTime = new Date().toISOString();
            this._stats.lastArchiveSize = toArchive.length;

            // 重建索引
            this._rebuildIndices();

            console.log(`[ExperienceDB] Archived ${toArchive.length} experiences (total archived: ${this._stats.archivedExperiences})`);
        } catch (e) {
            console.error('[ExperienceDB] Archive error:', e.message);
        } finally {
            this._isArchiving = false;
        }
    }

    _rebuildIndices() {
        this._indices.byType.clear();
        this._indices.byTags.clear();
        this._indices.byDate.clear();
        this._indices.byTime = [];
        this._indices.byImportance = [];
        this._stats.topTags.clear();

        for (const [id, exp] of this._experiences) {
            if (exp.metadata.deleted) continue;
            this._updateIndices(id, exp);
        }
    }

    _ensureDirectories() {
        try {
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
            }
            const archiveDir = path.join(this.storageDir, 'archives');
            if (!fs.existsSync(archiveDir)) {
                fs.mkdirSync(archiveDir, { recursive: true });
            }
        } catch (e) {
            console.error('[ExperienceDB] Directory creation error:', e.message);
        }
    }

    _recoverFromDisk() {
        try {
            const dataPath = path.join(this.storageDir, 'experiences_active.json');
            if (fs.existsSync(dataPath)) {
                const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
                if (data.experiences && Array.isArray(data.experiences)) {
                    for (const exp of data.experiences) {
                        this._experiences.set(exp.id, exp);
                        this._updateIndices(exp.id, exp);
                    }
                    this._stats.totalExperiences = data.count || data.experiences.length;
                    console.log(`[ExperienceDB] Recovered ${data.experiences.length} experiences from disk`);
                }
            }
        } catch (e) {
            console.warn('[ExperienceDB] Recovery error (benign):', e.message);
        }
    }
}

module.exports = ExperienceDatabase;
