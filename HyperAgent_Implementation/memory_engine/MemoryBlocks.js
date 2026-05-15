// MemoryBlocks — typed memory blocks
const fs = require('fs');
const path = require('path');

const BLOCK_TYPES = {
    persona: { readOnly: true,  maxSize: 2000, description: '智能体身份与人格定义' },
    core:    { readOnly: false, maxSize: 4000, description: '核心工作记忆（始终在上下文）' },
    archival:{ readOnly: false, maxSize: null, description: '归档记忆（向量索引）' },
    system:  { readOnly: true,  maxSize: 1000, description: '系统配置（只读）' }
};

class MemoryBlocks {
    constructor(options = {}) {
        this.storageDir = options.storageDir || path.join(process.cwd(), 'mem_store', 'blocks');
        this._blocks = new Map();
        this._initialized = false;

        // 默认块定义
        this._defaults = options.blocks || {
            persona: {
                label: 'persona',
                value: `你是 JingxuanAgent，运行在用户的 Windows 电脑上的智能体。
你可以读写文件、执行命令、控制系统。
你的记忆会跨会话保留。
用户授权后你可以完全操控电脑。`,
                template_name: 'default_persona',
                readOnly: true
            },
            core: {
                label: 'core',
                value: '',
                template_name: 'core_memory',
                readOnly: false,
                limit: 4000
            },
            system: {
                label: 'system',
                value: JSON.stringify({
                    version: '4.0.0',
                    platform: process.platform,
                    hostname: require('os').hostname(),
                    features: []
                }),
                readOnly: true
            }
        };

        // 已注册的工具处理器（供 ToolExecutor 注册）
        this._toolHandlers = {
            memory_read_block: async (params) => {
                const block = this.getBlock(params.name);
                if (!block) return { verified: false, error: `Block not found: ${params.name}` };
                return { verified: true, data: { label: block.label, value: block.value, readOnly: block.readOnly } };
            },
            memory_write_block: async (params) => {
                const block = this._blocks.get(params.name);
                if (!block) return { verified: false, error: `Block not found: ${params.name}` };
                if (block.readOnly) return { verified: false, error: `Block ${params.name} is read-only` };
                block.value = params.value;
                block.updatedAt = new Date().toISOString();
                await this._persistBlock(params.name);
                return { verified: true, data: { label: block.label, updated: true } };
            },
            memory_list_blocks: async () => {
                const blocks = {};
                for (const [name, block] of this._blocks) {
                    blocks[name] = { label: block.label, readOnly: block.readOnly, size: (block.value || '').length };
                }
                return { verified: true, data: { blocks } };
            },
            memory_append_archival: async (params) => {
                const block = this._blocks.get('archival');
                if (!block) return { verified: false, error: 'Archival block not found' };
                if (!Array.isArray(block.value)) block.value = [];
                block.value.push({ content: params.content, timestamp: new Date().toISOString(), tags: params.tags || [] });
                await this._persistBlock('archival');
                return { verified: true, data: { appended: true, index: block.value.length - 1 } };
            },
            memory_search_archival: async (params) => {
                const block = this._blocks.get('archival');
                if (!block || !Array.isArray(block.value)) return { verified: true, data: { results: [] } };
                const q = params.query.toLowerCase();
                const results = block.value.filter(e => e.content.toLowerCase().includes(q));
                return { verified: true, data: { results: results.slice(0, params.topK || 10) } };
            }
        };
    }

    async init() {
        if (this._initialized) return;
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // 加载持久化的块，或创建默认块
        for (const [name, defaults] of Object.entries(this._defaults)) {
            const loaded = await this._loadBlock(name);
            if (loaded) {
                this._blocks.set(name, loaded);
            } else {
                const block = {
                    label: defaults.label,
                    value: defaults.value || '',
                    template_name: defaults.template_name,
                    readOnly: defaults.readOnly,
                    limit: defaults.limit || BLOCK_TYPES[name]?.maxSize || 2000,
                    type: name,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                this._blocks.set(name, block);
                await this._persistBlock(name);
            }
        }

        // 确保 archival 块存在
        if (!this._blocks.has('archival')) {
            const archival = {
                label: 'archival',
                value: [],
                readOnly: false,
                limit: null,
                type: 'archival',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            this._blocks.set('archival', archival);
            await this._persistBlock('archival');
        }

        this._initialized = true;
        console.log(`[MemoryBlocks] Initialized: ${this._blocks.size} blocks`);
        return this._blocks.size;
    }

    getBlock(name) {
        const block = this._blocks.get(name);
        if (!block) return null;
        if (block.type === 'archival') {
            return { ...block, value: '(archival storage, use search)' };
        }
        return { ...block };
    }

    getBlockValue(name) {
        const block = this._blocks.get(name);
        return block ? block.value : null;
    }

    async setBlock(name, value) {
        const block = this._blocks.get(name);
        if (!block) throw new Error(`Block not found: ${name}`);
        if (block.readOnly) throw new Error(`Block ${name} is read-only`);
        if (block.limit && typeof value === 'string' && value.length > block.limit) {
            value = value.substring(0, block.limit);
        }
        block.value = value;
        block.updatedAt = new Date().toISOString();
        await this._persistBlock(name);
        return { label: block.label, updated: true };
    }

    async appendArchival(content, tags = []) {
        let block = this._blocks.get('archival');
        if (!block) {
            block = { label: 'archival', value: [], readOnly: false, limit: null, type: 'archival' };
            this._blocks.set('archival', block);
        }
        if (!Array.isArray(block.value)) block.value = [];
        block.value.push({ content, tags, timestamp: new Date().toISOString() });
        // 限制归档大小
        if (block.value.length > 10000) {
            block.value = block.value.slice(-5000);
        }
        block.updatedAt = new Date().toISOString();
        await this._persistBlock('archival');
        return block.value.length - 1;
    }

    searchArchival(query, topK = 10) {
        const block = this._blocks.get('archival');
        if (!block || !Array.isArray(block.value)) return [];
        const q = query.toLowerCase();
        return block.value
            .filter(e => e.content.toLowerCase().includes(q))
            .slice(-topK)
            .reverse();
    }

    getToolDefinitions() {
        return [
            {
                type: 'function',
                function: {
                    name: 'memory_read_block',
                    description: '读取指定记忆块的内容。块类型: persona(身份), core(核心工作记忆), system(系统配置)',
                    parameters: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', enum: ['persona', 'core', 'system'], description: '记忆块名称' }
                        },
                        required: ['name']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'memory_write_block',
                    description: '写入核心记忆块(core)，更新你的工作记忆。persona 和 system 是只读的。',
                    parameters: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', enum: ['core'], description: '可写的记忆块' },
                            value: { type: 'string', description: '要写入的内容（4000字符限制）' }
                        },
                        required: ['name', 'value']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'memory_append_archival',
                    description: '向归档记忆追加一条内容。用于存储你想长期记住的信息。',
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: '要记住的信息' },
                            tags: { type: 'array', items: { type: 'string' }, description: '标签' }
                        },
                        required: ['content']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'memory_search_archival',
                    description: '在归档记忆中搜索相关信息。',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: '搜索关键词' },
                            topK: { type: 'number', description: '返回结果数' }
                        },
                        required: ['query']
                    }
                }
            }
        ];
    }

    getToolHandlers() {
        return this._toolHandlers;
    }

    getContextSummary() {
        const parts = [];
        for (const [name, block] of this._blocks) {
            if (name === 'archival') {
                const count = Array.isArray(block.value) ? block.value.length : 0;
                parts.push(`[${name}: ${count} entries]`);
            } else if (block.value) {
                const val = typeof block.value === 'string' ? block.value : JSON.stringify(block.value);
                parts.push(`[${name}]\n${val.substring(0, 500)}`);
            }
        }
        return parts.join('\n\n');
    }

    getStats() {
        const stats = {};
        for (const [name, block] of this._blocks) {
            if (name === 'archival') {
                stats[name] = { count: Array.isArray(block.value) ? block.value.length : 0 };
            } else {
                stats[name] = { size: (block.value || '').length, readOnly: block.readOnly };
            }
        }
        return stats;
    }

    async _persistBlock(name) {
        const block = this._blocks.get(name);
        if (!block) return;
        await fs.promises.writeFile(
            path.join(this.storageDir, `block_${name}.json`),
            JSON.stringify(block, null, 2)
        );
    }

    async _loadBlock(name) {
        try {
            const filePath = path.join(this.storageDir, `block_${name}.json`);
            if (fs.existsSync(filePath)) {
                return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
            }
        } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }
        return null;
    }
}

MemoryBlocks.BLOCK_TYPES = BLOCK_TYPES;
module.exports = MemoryBlocks;
