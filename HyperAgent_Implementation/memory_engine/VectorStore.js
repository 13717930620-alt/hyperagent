// VectorStore — vector storage engine
const https = require('https');
const http = require('http');

class VectorStore {
    constructor(options = {}) {
        this.entries = new Map();
        this.distanceThreshold = options.distanceThreshold || 0.5;
        this.embeddingMode = options.embeddingMode || 'hybrid'; // 'api' | 'local' | 'builtin' | 'hybrid'

        // 真实 Embedding 配置
        this.embeddingApiUrl = options.embeddingApiUrl || process.env.EMBEDDING_API_URL || '';
        this.embeddingApiKey = options.embeddingApiKey || process.env.EMBEDDING_API_KEY || '';
        this.embeddingModel = options.embeddingModel || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
        this.embeddingDim = options.dimension || 1536; // text-embedding-3-small 默认 1536
        this.embeddingBatchSize = options.embeddingBatchSize || 20;

        // 本地推理引擎 (BGE 等本地模型)
        this.localInference = options.localInference || null;

        // 外部自定义嵌入函数
        this._embeddingFn = options.embeddingFn || null;

        // 嵌入缓存: text -> vector
        this._embeddingCache = new Map();
        this._cacheMaxSize = options.cacheMaxSize || 5000;

        // TF-IDF 回退
        this._idfCache = null;
        this._totalDocs = 0;
        this._dirty = true;
    }

    // 公开 API

    add(text, metadata = {}) {
        const id = `vec_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const entry = {
            id, text, metadata,
            vector: null,           // 真实嵌入向量 (API/local)
            tfidfVector: null,      // TF-IDF 回退向量
            createdAt: new Date().toISOString(),
            accessCount: 0,
            lastAccessed: null,
            embeddingReady: false    // 标记嵌入是否已生成
        };
        this.entries.set(id, entry);
        this._totalDocs++;
        this._dirty = true;
        return { id, text, metadata };
    }

    addBatch(items) {
        const results = [];
        for (const item of items) {
            results.push(this.add(item.text, item.metadata));
        }
        return results;
    }

    /** 批量生成嵌入 */
    async buildEmbeddings(options = {}) {
        const force = options.force || false;
        const batch = [];

        for (const [id, entry] of this.entries) {
            if (!force && entry.embeddingReady) continue;
            if (entry.text.length < 2 || entry.text.length > 8192) continue;
            batch.push(entry);
        }

        if (batch.length === 0) return { indexed: 0, total: this.entries.size };

        console.log(`[VectorStore] Building embeddings for ${batch.length} items (mode=${this.embeddingMode})...`);
        let indexed = 0;
        let errors = 0;

        // 分批处理
        for (let i = 0; i < batch.length; i += this.embeddingBatchSize) {
            const chunk = batch.slice(i, i + this.embeddingBatchSize);
            const texts = chunk.map(e => e.text.substring(0, 4096)); // 截断过长的文本

            try {
                let vectors;

                if (this.embeddingMode === 'api' && this.embeddingApiUrl) {
                    vectors = await this._callEmbeddingAPI(texts);
                } else if (this.embeddingMode === 'local' && this.localInference) {
                    vectors = await this._callLocalEmbedding(texts);
                } else if (this._embeddingFn) {
                    vectors = await Promise.all(texts.map(t => this._embeddingFn(t)));
                } else {
                    // 内置 TF-IDF 回退
                    for (const entry of chunk) {
                        entry.tfidfVector = this._computeTFIDFVector(entry.text);
                        entry.embeddingReady = true;
                        indexed++;
                    }
                    continue;
                }

                for (let j = 0; j < chunk.length; j++) {
                    if (vectors && vectors[j]) {
                        chunk[j].vector = vectors[j];
                        chunk[j].embeddingReady = true;
                        indexed++;
                    }
                }
            } catch (e) {
                console.warn(`[VectorStore] Embedding batch ${i} failed: ${e.message}`);
                // 失败时回退到 TF-IDF
                for (const entry of chunk) {
                    entry.tfidfVector = this._computeTFIDFVector(entry.text);
                    entry.embeddingReady = true;
                    indexed++;
                }
                errors++;
            }
        }

        console.log(`[VectorStore] Embeddings built: ${indexed} indexed, ${errors} errors`);
        return { indexed, total: this.entries.size, errors };
    }

    /** 语义搜索 */
    search(query, topK = 5) {
        if (this.entries.size === 0) return [];

        const queryStr = String(query).substring(0, 4096);
        const hasRealEmbeddings = this._hasRealEmbeddings();

        // 检查是否有嵌入向量
        if (hasRealEmbeddings) {
            // 使用缓存或即时生成查询向量
            const queryVec = this._getQueryVector(queryStr);
            if (queryVec) {
                return this._cosineSearch(queryVec, topK);
            }
        }

        // 回退到 TF-IDF 搜索
        return this._tfidfSearch(queryStr, topK);
    }

    /**
     * 余弦相似度搜索 (用于真实嵌入)
     */
    _cosineSearch(queryVec, topK) {
        const scored = [];

        for (const entry of this.entries.values()) {
            const entryVec = entry.vector || this._entryVectorFallback(entry);
            if (!entryVec) continue;

            const similarity = this._cosineSimilarity(queryVec, entryVec);
            const distance = 1 - similarity;

            if (distance < this.distanceThreshold) {
                entry.accessCount++;
                entry.lastAccessed = new Date().toISOString();
                scored.push({
                    ...entry,
                    distance,
                    score: similarity,
                    _searchType: 'cosine'
                });
            }
        }

        return scored
            .sort((a, b) => a.distance - b.distance)
            .slice(0, topK);
    }

    /**
     * TF-IDF 搜索 (回退方案)
     */
    _tfidfSearch(query, topK) {
        const queryTokens = this._tokenize(query);
        const tfidf = this._computeTFIDF(queryTokens);
        const entries = Array.from(this.entries.values());

        const scored = tfidf.map((score, idx) => {
            entries[idx].accessCount++;
            entries[idx].lastAccessed = new Date().toISOString();
            return {
                ...entries[idx],
                distance: 1 - Math.min(score, 1),
                score,
                _searchType: 'tfidf'
            };
        });

        return scored
            .filter(s => s.distance < this.distanceThreshold)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, topK);
    }

    remove(id) {
        if (!this.entries.has(id)) return false;
        this.entries.delete(id);
        this._totalDocs--;
        this._dirty = true;
        return true;
    }

    clear() {
        this.entries.clear();
        this._totalDocs = 0;
        this._embeddingCache.clear();
        this._dirty = true;
    }

    get(id) { return this.entries.get(id) || null; }

    getAll() { return Array.from(this.entries.values()); }

    getStats() {
        const hasRealEmb = this._hasRealEmbeddings();
        return {
            total: this.entries.size,
            threshold: this.distanceThreshold,
            mode: this.embeddingMode,
            dimensions: hasRealEmb ? (this.embeddingDim || 'varies') : 'tfidf',
            embeddingModel: hasRealEmb ? this.embeddingModel : 'builtin-tfidf',
            cacheSize: this._embeddingCache.size,
            embeddingReady: this._countEmbeddingReady(),
            dirty: this._dirty
        };
    }

    // Embedding API 调用

    /**
     * 调用 OpenAI 兼容的 Embedding API
     * 支持: text-embedding-3-small/large, jina-embeddings-v3, BGE via API 等
     */
    _callEmbeddingAPI(texts) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(this.embeddingApiUrl);
            const client = urlObj.protocol === 'https:' ? https : http;

            const body = JSON.stringify({
                model: this.embeddingModel,
                input: texts.map(t => this._truncateText(t, 4096)),
                encoding_format: 'float'
            });

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname || '/v1/embeddings',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.embeddingApiKey}`,
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 30000
            };

            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.data && Array.isArray(parsed.data)) {
                            // OpenAI 格式: data[{index, embedding}]
                            const vectors = new Array(texts.length);
                            for (const item of parsed.data) {
                                vectors[item.index] = item.embedding;
                            }
                            resolve(vectors);
                        } else if (parsed.embeddings && Array.isArray(parsed.embeddings)) {
                            // Jina 格式: embeddings[{index, embedding}]
                            const vectors = new Array(texts.length);
                            for (const item of parsed.embeddings) {
                                vectors[item.index || 0] = item.embedding;
                            }
                            resolve(vectors);
                        } else {
                            reject(new Error('Unexpected API response format'));
                        }
                    } catch (e) {
                        reject(new Error(`API parse error: ${e.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Embedding API timeout')); });
            req.write(body);
            req.end();
        });
    }

    /**
     * 调用 LocalInferenceEngine 生成嵌入
     */
    async _callLocalEmbedding(texts) {
        const results = [];
        for (const text of texts) {
            try {
                const vec = await this.localInference.generateEmbedding(text);
                results.push(vec);
            } catch (e) {
                results.push(null);
            }
        }
        return results;
    }

    // 向量工具

    _cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    /**
     * 获取查询的向量表示: 先查缓存，没有再即时生成
     */
    _getQueryVector(query) {
        // 缓存命中
        if (this._embeddingCache.has(query)) {
            return this._embeddingCache.get(query);
        }

        // 通过 API 或本地推理生成
        if (this.embeddingMode === 'api' && this.embeddingApiUrl) {
            // 同步方式: 单条查询直接调用
            this._callEmbeddingAPI([query]).then(vectors => {
                if (vectors && vectors[0]) {
                    this._setCache(query, vectors[0]);
                }
            }).catch(e => console.warn(`[memory_engine] Caught: ${e.message}`));
            return null; // 异步缓存, 本次查不到
        }

        if (this.embeddingMode === 'local' && this.localInference) {
            this._callLocalEmbedding([query]).then(vectors => {
                if (vectors && vectors[0]) {
                    this._setCache(query, vectors[0]);
                }
            }).catch(e => console.warn(`[memory_engine] Caught: ${e.message}`));
            return null;
        }

        if (this._embeddingFn) {
            const vec = this._embeddingFn(query);
            if (vec) this._setCache(query, vec);
            return vec || null;
        }

        return null;
    }

    /**
     * 条目向量的回退: 用 TF-IDF 向量替代
     */
    _entryVectorFallback(entry) {
        if (entry.tfidfVector) return entry.tfidfVector;
        if (!entry.text) return null;
        // 即时计算 TF-IDF
        const tokens = this._tokenize(entry.text);
        const freq = {};
        for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
        const dim = this.embeddingDim || 384;
        const vec = new Float64Array(dim);
        for (const [token, count] of Object.entries(freq)) {
            const hash = this._hashCode(token);
            vec[Math.abs(hash) % dim] += count;
        }
        const norm = Math.sqrt(Array.from(vec).reduce((s, v) => s + v * v, 0));
        if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
        entry.tfidfVector = Array.from(vec);
        return entry.tfidfVector;
    }

    // TF-IDF

    _tokenize(text) {
        const tokens = [];
        const str = String(text).toLowerCase();
        const chineseChars = str.match(/[一-鿿]+/g) || [];
        for (const cjk of chineseChars) {
            for (let i = 0; i < cjk.length - 1; i++) {
                tokens.push(cjk.substring(i, i + 2));
            }
        }
        const words = str.match(/[a-z]+/g) || [];
        for (const w of words) {
            if (w.length > 2) tokens.push(w);
            tokens.push(...this._ngram(w, 3));
        }
        return tokens;
    }

    _ngram(word, n) {
        const result = [];
        for (let i = 0; i <= word.length - n; i++) result.push(word.substring(i, i + n));
        return result;
    }

    _computeTFIDF(queryTokens) {
        const entries = Array.from(this.entries.values());
        return entries.map(entry => {
            const docTokens = this._tokenize(entry.text);
            const docFreq = new Map();
            for (const t of docTokens) docFreq.set(t, (docFreq.get(t) || 0) + 1);

            let score = 0;
            for (const qt of queryTokens) {
                const tf = docFreq.get(qt) || 0;
                if (tf === 0) continue;
                const idf = Math.log((this._totalDocs + 1) / (this._countDocsWith(qt) + 1)) + 1;
                score += (tf / docTokens.length) * idf;
            }
            return score;
        });
    }

    _computeTFIDFVector(text) {
        const tokens = this._tokenize(text);
        const freq = {};
        for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
        const dim = 384;
        const vec = new Float64Array(dim);
        for (const [token, count] of Object.entries(freq)) {
            const hash = this._hashCode(token);
            vec[Math.abs(hash) % dim] += count * Math.log1p(Object.keys(freq).length);
        }
        const norm = Math.sqrt(Array.from(vec).reduce((s, v) => s + v * v, 0));
        if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
        return Array.from(vec);
    }

    _countDocsWith(term) {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (this._tokenize(entry.text).includes(term)) count++;
        }
        return count;
    }

    _hasRealEmbeddings() {
        for (const entry of this.entries.values()) {
            if (entry.vector) return true;
        }
        return false;
    }

    _countEmbeddingReady() {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.embeddingReady) count++;
        }
        return count;
    }

    _truncateText(text, maxLen) {
        if (text.length <= maxLen) return text;
        // 保留首尾
        const headLen = Math.floor(maxLen * 0.7);
        const tailLen = maxLen - headLen - 3;
        return text.substring(0, headLen) + '...' + text.substring(text.length - tailLen);
    }

    _setCache(key, vec) {
        if (this._embeddingCache.size >= this._cacheMaxSize) {
            // 删除最早的一半
            const keys = Array.from(this._embeddingCache.keys());
            for (let i = 0; i < keys.length / 2; i++) {
                this._embeddingCache.delete(keys[i]);
            }
        }
        this._embeddingCache.set(key, vec);
    }

    _hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }
}

module.exports = VectorStore;
