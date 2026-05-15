// SkillLibrary - embedding-indexed skill library
const fs = require('fs');
const path = require('path');

class SkillLibrary {
    constructor(options = {}) {
        this.vectorStore = options.vectorStore || null;
        this.llmAdapter = options.llmAdapter || null;
        this.storageDir = options.storageDir || path.join(process.cwd(), 'experience_store', 'skills');

        this._skills = new Map();  // name -> skill object
        this._initialized = false;

        // embedding 索引缓存
        this._embeddingCache = new Map();

        this.stats = {
            totalSkills: 0,
            totalExecutions: 0,
            totalDiscoveries: 0,
            totalRetrievals: 0
        };
    }

    async init() {
        if (this._initialized) return;
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // 从磁盘加载已有技能
        const files = await fs.promises.readdir(this.storageDir).catch(() => []);
        for (const file of files.filter(f => f.endsWith('.json'))) {
            try {
                const skill = JSON.parse(
                    await fs.promises.readFile(path.join(this.storageDir, file), 'utf8')
                );
                this._skills.set(skill.name, skill);
            } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
        }

        this.stats.totalSkills = this._skills.size;
        this._initialized = true;
        console.log(`[SkillLibrary] Loaded ${this._skills.size} skills`);
        return this._skills.size;
    }

    /**
     * Discover a skill from task execution
     */
    async discoverSkill(name, task, executionResult, metadata = {}) {
        const skill = {
            name,
            description: metadata.description || task.substring(0, 200),
            task,
            code: executionResult.code || executionResult.solution || executionResult.prompt || '',
            embedding: null,
            usageCount: 0,
            successCount: 0,
            successRate: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: metadata.tags || [],
            category: metadata.category || 'general'
        };

        // 生成 embedding
        skill.embedding = await this._computeEmbedding(skill.description);

        // 如果技能已存在，更新
        const existing = this._skills.get(name);
        if (existing) {
            skill.usageCount = existing.usageCount;
            skill.successCount = existing.successCount;
            skill.createdAt = existing.createdAt;
        }

        this._skills.set(name, skill);
        await this._persistSkill(skill);

        this.stats.totalSkills = this._skills.size;
        this.stats.totalDiscoveries++;
        console.log(`[SkillLibrary] Discovered skill: ${name}`);

        return skill;
    }

    /**
     * Retrieve most relevant skills
     */
    async retrieveSkill(taskDescription, topK = 3) {
        this.stats.totalRetrievals++;

        // 1. 语义搜索（如果 vectorStore 可用）
        let semanticResults = [];
        if (this.vectorStore && typeof this.vectorStore.search === 'function') {
            try {
                semanticResults = this.vectorStore.search(taskDescription, topK * 2);
            } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
        }

        // 2. 关键词匹配
        const keywordResults = [];
        const q = taskDescription.toLowerCase();
        const qWords = q.split(/\s+/).filter(w => w.length > 2);

        for (const [, skill] of this._skills) {
            // 关键词匹配
            const desc = skill.description.toLowerCase();
            const matchCount = qWords.filter(w => desc.includes(w)).length;
            const keywordScore = qWords.length > 0 ? matchCount / qWords.length : 0;

            // 标签匹配
            const tagScore = skill.tags.some(t => q.includes(t.toLowerCase())) ? 0.3 : 0;

            const totalScore = keywordScore * 0.5 + tagScore;
            if (totalScore > 0) {
                keywordResults.push({ skill, score: totalScore, source: 'keyword' });
            }
        }

        // 3. 合并结果（去重）
        const seen = new Set();
        const merged = [];

        for (const r of semanticResults) {
            const name = r.metadata?.skillName;
            if (name && !seen.has(name)) {
                seen.add(name);
                const skill = this._skills.get(name);
                if (skill) {
                    merged.push({ skill, score: 1 - (r.distance || 0), source: 'semantic' });
                }
            }
        }

        for (const r of keywordResults) {
            if (!seen.has(r.skill.name)) {
                seen.add(r.skill.name);
                merged.push(r);
            }
        }

        // 4. 按使用次数提升（最常用的技能有 bias）
        merged.sort((a, b) => {
            const usageBoost = (b.skill.usageCount - a.skill.usageCount) * 0.01;
            return (b.score + usageBoost) - (a.score + (b.skill.usageCount * 0.01));
        });

        return merged.slice(0, topK).map(r => ({
            name: r.skill.name,
            description: r.skill.description,
            code: r.skill.code,
            usageCount: r.skill.usageCount,
            successRate: r.skill.successRate,
            tags: r.skill.tags,
            score: r.score
        }));
    }

    /**
     * Execute a skill
     */
    async executeSkill(skillName, params = {}) {
        const skill = this._skills.get(skillName);
        if (!skill) throw new Error(`Skill not found: ${skillName}`);

        skill.usageCount++;
        skill.updatedAt = new Date().toISOString();
        await this._persistSkill(skill);

        this.stats.totalExecutions++;

        return {
            name: skill.name,
            code: skill.code,
            description: skill.description,
            usageCount: skill.usageCount
        };
    }

    /**
     * Record skill execution result
     */
    async recordExecution(skillName, success) {
        const skill = this._skills.get(skillName);
        if (!skill) return;

        skill.usageCount = (skill.usageCount || 0) + 1;
        if (success) skill.successCount = (skill.successCount || 0) + 1;
        skill.successRate = skill.usageCount > 0
            ? skill.successCount / skill.usageCount
            : 0;
        skill.updatedAt = new Date().toISOString();
        await this._persistSkill(skill);
    }

    /**
     * 列出所有技能
     */
    listSkills(category = null) {
        const skills = [];
        for (const [, skill] of this._skills) {
            if (category && skill.category !== category) continue;
            skills.push({
                name: skill.name,
                description: skill.description.substring(0, 100),
                usageCount: skill.usageCount,
                successRate: skill.successRate,
                category: skill.category,
                tags: skill.tags
            });
        }
        return skills.sort((a, b) => b.usageCount - a.usageCount);
    }

    getSkill(name) {
        const skill = this._skills.get(name);
        if (!skill) return null;
        return { ...skill };
    }

    async deleteSkill(name) {
        const skill = this._skills.get(name);
        if (!skill) return false;

        this._skills.delete(name);
        try {
            await fs.promises.unlink(path.join(this.storageDir, `skill_${name}.json`));
        } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
        this.stats.totalSkills = this._skills.size;
        return true;
    }

    /**
     * 计算文本的 embedding
     * 使用 LLM adapter 或简单的 TF-IDF 风格向量
     */
    async _computeEmbedding(text) {
        // 如果有 embedding 缓存，直接返回
        const cacheKey = text.substring(0, 100);
        if (this._embeddingCache.has(cacheKey)) {
            return this._embeddingCache.get(cacheKey);
        }

        // 简单的关键词频率向量（不依赖外部服务）
        const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const freq = {};
        for (const w of words) {
            freq[w] = (freq[w] || 0) + 1;
        }

        // 归一化
        const maxFreq = Math.max(...Object.values(freq), 1);
        const embedding = Object.fromEntries(
            Object.entries(freq).map(([k, v]) => [k, v / maxFreq])
        );

        this._embeddingCache.set(cacheKey, embedding);
        // 限制缓存大小
        if (this._embeddingCache.size > 500) {
            const firstKey = this._embeddingCache.keys().next().value;
            this._embeddingCache.delete(firstKey);
        }

        return embedding;
    }

    async _persistSkill(skill) {
        const filePath = path.join(this.storageDir, `skill_${skill.name}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(skill, null, 2));
    }

    getStats() {
        return { ...this.stats };
    }
}

module.exports = SkillLibrary;
