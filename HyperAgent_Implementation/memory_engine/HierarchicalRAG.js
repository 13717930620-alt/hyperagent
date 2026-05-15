// HierarchicalRAG — hierarchical retrieval-augmented generation
class HierarchicalRAG {
    constructor(options = {}) {
        this.vectorStore = options.vectorStore || null;
        this.llmAdapter = options.llmAdapter || null;
        this.topKSummary = options.topKSummary || 3;
        this.topKChunk = options.topKChunk || 5;
        this.topKSentence = options.topKSentence || 10;
        this.chunkSize = options.chunkSize || 500;
        this.chunkOverlap = options.chunkOverlap || 50;

        this.stats = {
            documentsIndexed: 0,
            totalChunks: 0,
            totalSentences: 0,
            retrievalCount: 0
        };

        // 存储层次化索引（memory fallback 当 vectorStore 不可用时）
        this._summaryIndex = new Map();
        this._chunkIndex = new Map();
        this._sentenceIndex = new Map();
    }

    /** 索引一篇文档（三层） */
    async indexDocument(text, metadata = {}) {
        const docId = metadata.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // 生成摘要
        const summary = await this._generateSummary(text, metadata);

        // 分块
        const chunks = this._chunkText(text);

        // 提取句子
        const allSentences = [];
        const chunkSentenceMap = [];

        for (let i = 0; i < chunks.length; i++) {
            const sentences = this._extractSentences(chunks[i]);
            allSentences.push(...sentences);
            chunkSentenceMap.push({ chunkIndex: i, sentenceIndices: range(allSentences.length - sentences.length, allSentences.length) });
        }

        // 4. 存储到向量存储
        if (this.vectorStore && typeof this.vectorStore.add === 'function') {
            // 摘要层
            this.vectorStore.add(summary, {
                docId, tier: 'summary', chunkIndex: -1,
                ...metadata, timestamp: new Date().toISOString()
            });

            // 段落层
            for (let i = 0; i < chunks.length; i++) {
                this.vectorStore.add(chunks[i].substring(0, 1000), {
                    docId, tier: 'chunk', chunkIndex: i,
                    ...metadata, timestamp: new Date().toISOString()
                });
            }

            // 句子层（限制数量避免爆炸）
            const maxSentences = Math.min(allSentences.length, 50);
            for (let i = 0; i < maxSentences; i++) {
                if (allSentences[i].length > 10) {
                    this.vectorStore.add(allSentences[i], {
                        docId, tier: 'sentence', chunkIndex: this._findChunkForSentence(i, chunkSentenceMap),
                        ...metadata, timestamp: new Date().toISOString()
                    });
                }
            }
        }

        // 5. 内存索引（fallback）
        this._summaryIndex.set(docId, { summary, chunks, metadata, indexedAt: Date.now() });
        for (let i = 0; i < chunks.length; i++) {
            const key = `${docId}:chunk:${i}`;
            this._chunkIndex.set(key, { docId, chunkIndex: i, text: chunks[i] });
        }
        for (let i = 0; i < allSentences.length; i++) {
            const key = `${docId}:sent:${i}`;
            this._sentenceIndex.set(key, { docId, sentenceIndex: i, text: allSentences[i] });
        }

        this.stats.documentsIndexed++;
        this.stats.totalChunks += chunks.length;
        this.stats.totalSentences += allSentences.length;

        // 限制内存索引大小
        if (this._summaryIndex.size > 100) {
            const oldest = [...this._summaryIndex.keys()].slice(0, this._summaryIndex.size - 100);
            for (const k of oldest) { this._summaryIndex.delete(k); }
            for (const k of [...this._chunkIndex.keys()].filter(k => oldest.some(d => k.startsWith(d)))) { this._chunkIndex.delete(k); }
            for (const k of [...this._sentenceIndex.keys()].filter(k => oldest.some(d => k.startsWith(d)))) { this._sentenceIndex.delete(k); }
        }

        return { docId, chunks: chunks.length, sentences: allSentences.length };
    }

    /** 三层检索：摘要 → 段落 → 句子 */
    async retrieve(query, options = {}) {
        this.stats.retrievalCount++;
        const topKSummary = options.topKSummary || this.topKSummary;
        const topKChunk = options.topKChunk || this.topKChunk;
        const topKSentence = options.topKSentence || this.topKSentence;

        // 1. 摘要层搜索
        const summaryResults = await this._searchTier(query, 'summary', topKSummary);

        // 2. 段落层搜索（结合摘要结果）
        const relevantDocIds = summaryResults.map(r => r.metadata?.docId || r.docId).filter(Boolean);
        const chunkResults = await this._searchTier(query, 'chunk', topKChunk, relevantDocIds);

        // 3. 句子层搜索（结合前两层）
        const chunkDocIds = chunkResults.map(r => r.metadata?.docId || r.docId).filter(Boolean);
        const searchDocIds = [...new Set([...relevantDocIds, ...chunkDocIds])];
        const sentenceResults = await this._searchTier(query, 'sentence', topKSentence, searchDocIds);

        return {
            summaries: summaryResults,
            chunks: chunkResults,
            sentences: sentenceResults,
            query
        };
    }

    /** 构建层次化上下文 */
    async buildHierarchicalContext(query, options = {}) {
        const results = await this.retrieve(query, options);

        const parts = [];

        if (results.summaries.length > 0) {
            parts.push('【相关文档摘要】');
            for (const s of results.summaries.slice(0, 2)) {
                parts.push(`- ${s.text || s.content || ''}`);
            }
        }

        if (results.chunks.length > 0) {
            parts.push('【相关段落】');
            for (const c of results.chunks.slice(0, 3)) {
                parts.push(`> ${(c.text || c.content || '').substring(0, 300)}`);
            }
        }

        if (results.sentences.length > 0) {
            parts.push('【具体信息】');
            for (const s of results.sentences.slice(0, 5)) {
                parts.push(`- ${s.text || s.content || ''}`);
            }
        }

        return parts.join('\n\n') || '（未找到相关信息）';
    }

    /** 搜索指定层级 */
    async _searchTier(query, tier, topK, docIds = null) {
        const results = [];

        if (this.vectorStore && typeof this.vectorStore.search === 'function') {
            try {
                const vecResults = this.vectorStore.search(query, topK * 3);
                for (const r of vecResults) {
                    if (r.metadata?.tier !== tier) continue;
                    if (docIds && !docIds.includes(r.metadata?.docId)) continue;
                    results.push({ ...r, text: r.text || r.content });
                }
            } catch (e) { console.warn(`[memory_engine] Unhandled error: ${e.message}`); }
        }

        // 内存索引 fallback
        if (results.length < topK) {
            const q = query.toLowerCase();
            const source = tier === 'summary' ? this._summaryIndex :
                          tier === 'chunk' ? this._chunkIndex :
                          this._sentenceIndex;

            for (const [key, val] of source) {
                const text = val.summary || val.text || '';
                if (!text.toLowerCase().includes(q)) continue;
                if (docIds && !docIds.includes(val.docId)) continue;
                results.push({
                    text: text.substring(0, 300),
                    docId: val.docId,
                    metadata: val.metadata || {},
                    score: 0.5,
                    tier
                });
            }
        }

        return results.slice(0, topK);
    }

    async _generateSummary(text, metadata) {
        if (!this.llmAdapter || text.length < 100) {
            return text.substring(0, 200);
        }

        try {
            const response = await this.llmAdapter.chat([
                { role: 'system', content: `你是一个文档摘要助手。请用一句话概括以下内容的核心要点（不超过 100 字）。` },
                { role: 'user', content: text.substring(0, 2000) }
            ]);

            const content = typeof response === 'string' ? response :
                           (response.content || response.message?.content || '');
            return content.substring(0, 300) || text.substring(0, 200);
        } catch (e) {
            return text.substring(0, 200);
        }
    }

    _chunkText(text) {
        if (text.length <= this.chunkSize) return [text];

        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + this.chunkSize;

            // 在段落边界分割
            if (end < text.length) {
                const nextPara = text.indexOf('\n\n', end - this.chunkOverlap);
                if (nextPara > start && nextPara < end + this.chunkOverlap) {
                    end = nextPara;
                } else {
                    // 在句子边界分割
                    const nextSentence = text.indexOf('. ', end - this.chunkOverlap);
                    if (nextSentence > start && nextSentence < end + this.chunkOverlap) {
                        end = nextSentence + 1;
                    }
                }
            }

            chunks.push(text.substring(start, Math.min(end, text.length)).trim());
            start = end;
        }

        return chunks.filter(c => c.length > 10);
    }

    _extractSentences(text) {
        return text
            .split(/[。！？.!?\n]+/)
            .map(s => s.trim())
            .filter(s => s.length > 5);
    }

    _findChunkForSentence(sentenceIndex, chunkSentenceMap) {
        let cumSum = 0;
        for (let i = 0; i < chunkSentenceMap.length; i++) {
            cumSum += chunkSentenceMap[i].sentenceIndices.length;
            if (sentenceIndex < cumSum) return i;
        }
        return -1;
    }

    getStats() {
        return { ...this.stats };
    }
}

function range(start, end) {
    const result = [];
    for (let i = start; i < end; i++) result.push(i);
    return result;
}

module.exports = HierarchicalRAG;
