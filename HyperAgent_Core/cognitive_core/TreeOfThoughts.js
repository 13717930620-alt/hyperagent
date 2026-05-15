// TreeOfThoughts — 思维树多分支推理

class TreeOfThoughts {
    constructor(options = {}) {
        this.llmAdapter = options.llmAdapter || null;
        this.searchMode = options.searchMode || 'bfs'; // 'bfs' | 'dfs'
        this.maxBranches = options.maxBranches || 3;
        this.maxDepth = options.maxDepth || 5;
        this.beamSize = options.beamSize || 2; // BFS 保留的分支数
        this.temperature = options.temperature || 0.7;

        this.stats = {
            totalSolves: 0,
            totalThoughtsGenerated: 0,
            totalEvaluations: 0,
            prunedBranches: 0
        };
    }

    /**
     * 求解问题
     * @param {string} problem
     * @param {object} context - { state, tools, constraints }
     * @returns {Promise<{ solution: string, tree: object, confidence: number }>}
     */
    async solve(problem, context = {}) {
        this.stats.totalSolves++;

        const root = {
            id: 'root',
            thought: problem,
            depth: 0,
            value: 0,
            parent: null,
            children: [],
            path: [problem.substring(0, 100)]
        };

        const result = this.searchMode === 'bfs'
            ? await this._bfsSearch(root, problem, context)
            : await this._dfsSearch(root, problem, context, 0);

        // 从最佳叶节点回溯路径
        const bestLeaf = this._findBestLeaf(result.tree);
        const solution = bestLeaf ? bestLeaf.thought : '';

        return {
            solution,
            tree: result.tree,
            confidence: bestLeaf ? bestLeaf.value : 0,
            metadata: {
                mode: this.searchMode,
                totalNodes: this._countNodes(result.tree),
                depth: bestLeaf ? bestLeaf.depth : 0,
                stats: { ...this.stats }
            }
        };
    }

    /**
     * BFS 搜索
     */
    async _bfsSearch(root, problem, context) {
        let currentLevel = [root];

        for (let depth = 1; depth <= this.maxDepth; depth++) {
            const allCandidates = [];

            for (const node of currentLevel) {
                // 生成下一轮想法
                const thoughts = await this._generateThoughts(node.thought, problem, context);
                this.stats.totalThoughtsGenerated += thoughts.length;

                for (const thought of thoughts) {
                    const child = {
                        id: `n_${depth}_${allCandidates.length}`,
                        thought,
                        depth,
                        value: 0,
                        parent: node.id,
                        children: [],
                        path: [...node.path, thought.substring(0, 100)]
                    };
                    node.children.push(child);
                    allCandidates.push(child);
                }
            }

            if (allCandidates.length === 0) break;

            // 评估所有候选
            const evaluated = [];
            for (const candidate of allCandidates) {
                const score = await this._evaluateThought(candidate.thought, problem, context);
                this.stats.totalEvaluations++;
                candidate.value = score.value;
                evaluated.push({ node: candidate, score: score.value });
            }

            // 语义剪枝（合并相似分支）
            const pruned = this._semanticPrune(evaluated);
            this.stats.prunedBranches += (evaluated.length - pruned.length);

            // 保留 top-K
            pruned.sort((a, b) => b.score - a.score);
            const topK = pruned.slice(0, this.beamSize);

            // 移除未选中的子节点
            const selectedIds = new Set(topK.map(t => t.node.id));
            for (const node of currentLevel) {
                node.children = node.children.filter(c => selectedIds.has(c.id));
            }

            currentLevel = topK.map(t => t.node);

            // 检查是否有解（value >= 0.9）
            if (topK.some(t => t.score >= 0.9)) break;
        }

        return { tree: root };
    }

    /**
     * DFS 搜索（带回溯）
     */
    async _dfsSearch(node, problem, context, depth) {
        if (depth >= this.maxDepth) return node;

        const thoughts = await this._generateThoughts(node.thought, problem, context);
        this.stats.totalThoughtsGenerated += thoughts.length;

        let bestNode = node;
        let bestValue = -1;

        for (const thought of thoughts) {
            const child = {
                id: `n_${depth}_${Math.random().toString(36).substr(2, 4)}`,
                thought,
                depth,
                value: 0,
                parent: node.id,
                children: [],
                path: [...node.path, thought.substring(0, 100)]
            };
            node.children.push(child);

            const score = await this._evaluateThought(thought, problem, context);
            this.stats.totalEvaluations++;
            child.value = score.value;

            // 剪枝：impossible 分支不继续探索
            if (score.verdict === 'impossible') {
                this.stats.prunedBranches++;
                continue;
            }

            // 递归探索
            if (score.verdict !== 'sure' || depth < this.maxDepth) {
                await this._dfsSearch(child, problem, context, depth + 1);
            }

            // 追踪最佳节点
            const leafBest = this._findBestLeaf(child);
            if (leafBest && leafBest.value > bestValue) {
                bestValue = leafBest.value;
                bestNode = leafBest;
            }
        }

        return node;
    }

    /**
     * LLM 生成下一轮想法（无LLM时使用内置生成器）
     */
    async _generateThoughts(currentThought, problem, context) {
        if (!this.llmAdapter) {
            return this._builtinGenerateThoughts(currentThought, problem, context);
        }

        const prompt = `你正在解决一个问题。请从当前状态出发，生成 ${this.maxBranches} 个不同的下一步思考方向。

【问题】${problem}
【当前状态】${currentThought}
【可用工具】${context.tools ? context.tools.join(', ') : '无'}

请返回一个 JSON 数组，包含 ${this.maxBranches} 个不同的下一步想法：
["想法1", "想法2", "想法3"]

每个想法应该是具体的推理步骤或行动方案，不要重复。`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是一个多分支推理系统。输出严格的 JSON 数组。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\[[\s\S]*\]/);
            if (match) {
                const thoughts = JSON.parse(match[0]);
                return Array.isArray(thoughts) ? thoughts.slice(0, this.maxBranches) : [currentThought];
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        return [currentThought];
    }

    /**
     * LLM 评估想法（sure/maybe/impossible + 数值评分）
     */
    async _evaluateThought(thought, problem, context) {
        if (!this.llmAdapter) {
            return { value: 0.5, verdict: 'maybe', reasoning: 'No LLM' };
        }

        const prompt = `评估以下思考方向对解决问题的价值。

【问题】${problem}
【思考方向】${thought}

请评估：
1. 这个方向对解决问题有帮助吗？
2. 可行性如何？
3. 风险和收益如何？

只返回 JSON：
{
  "value": 0.0-1.0,
  "verdict": "sure" | "maybe" | "impossible",
  "reasoning": "简短理由（一句话）"
}`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是一个思维评估系统。严格返回 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                return JSON.parse(match[0]);
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        return { value: 0.5, verdict: 'maybe', reasoning: 'Parse fallback' };
    }

    /**
     * 语义剪枝：合并相似分支
     */
    _semanticPrune(evaluated) {
        if (evaluated.length <= 1) return evaluated;

        const clusters = [];
        const threshold = 0.6;

        for (const item of evaluated) {
            let added = false;
            for (const cluster of clusters) {
                const sim = this._jaccardSimilarity(
                    item.node.thought,
                    cluster[0].node.thought
                );
                if (sim > threshold) {
                    cluster.push(item);
                    added = true;
                    break;
                }
            }
            if (!added) {
                clusters.push([item]);
            }
        }

        // 每个簇保留最高分
        return clusters.map(cluster =>
            cluster.reduce((best, curr) => curr.score > best.score ? curr : best)
        );
    }

    _jaccardSimilarity(a, b) {
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return intersection.size / Math.max(union.size, 1);
    }

    _findBestLeaf(node) {
        if (node.children.length === 0) return node;

        let best = null;
        let bestValue = -1;

        for (const child of node.children) {
            const leaf = this._findBestLeaf(child);
            if (leaf && leaf.value > bestValue) {
                bestValue = leaf.value;
                best = leaf;
            }
        }

        return best;
    }

    _countNodes(node) {
        let count = 1;
        for (const child of node.children) {
            count += this._countNodes(child);
        }
        return count;
    }

    /**
     * 内置想法生成器——无需LLM，基于问题分解策略生成不同思路
     */
    _builtinGenerateThoughts(currentThought, problem, context) {
        const thoughts = [];

        // 策略1: 分解法——将问题拆解为子步骤
        const decompositions = [
            `首先分析问题的前提条件和约束`,
            `将问题分解为多个可独立处理的子问题`,
            `确定每个子问题的输入输出关系`,
            `从最简单的情况开始逐步推进`,
            `考虑边界条件和特殊情况`
        ];

        // 策略2: 多角度法——从不同视角看待问题
        const perspectives = [
            `从已有经验的角度看，类似情况是如何处理的`,
            `从资源效率的角度考虑最优解`,
            `从安全可靠的角度检查可能的隐患`,
            `从用户体验的角度评估方案`,
            `从长远维护的角度考虑可扩展性`
        ];

        // 策略3: 反转思考法——从目标反向推导
        const reversals = [
            `从目标反向推导需要的前置条件`,
            `如果方案失败，最可能的原因是什么`,
            `与当前思路相反的方案是否更优`,
            `假设资源无限，理想的解决方案是什么`,
            `在最小可行的情况下如何实现目标`
        ];

        // 提取当前想法和问题中的关键词，选择最相关的策略
        const combined = (currentThought + ' ' + problem).toLowerCase();

        // 根据问题类型选择策略组合
        if (combined.includes('如何') || combined.includes('怎样') || combined.includes('怎么')) {
            // 方法论问题：用分解法
            thoughts.push(...decompositions.slice(0, this.maxBranches));
        } else if (combined.includes('为什么') || combined.includes('原因') || combined.includes('分析')) {
            // 分析型问题：用多角度法
            thoughts.push(...perspectives.slice(0, this.maxBranches));
        } else if (combined.includes('如果') || combined.includes('假设') || combined.includes('预测')) {
            // 假设性问题：用反转思考法
            thoughts.push(...reversals.slice(0, this.maxBranches));
        } else {
            // 通用型：三种策略混合
            const mixed = [
                ...decompositions, ...perspectives, ...reversals
            ];
            thoughts.push(...mixed.slice(0, this.maxBranches));
        }

        // 如果上下文中有工具信息，加入工具相关的想法
        if (context.tools && Array.isArray(context.tools)) {
            const toolSuggestions = context.tools.slice(0, 2).map(t =>
                `使用工具"${t}"来辅助完成当前步骤`
            );
            thoughts.push(...toolSuggestions);
        }

        // 去重并限制数量
        const uniqueThoughts = [...new Set(thoughts)];
        return uniqueThoughts.slice(0, this.maxBranches);
    }

    /**
     * 内置想法评估器——无需LLM，基于启发式规则打分
     */
    async _evaluateThought(thought, problem, context) {
        if (!this.llmAdapter) {
            return this._builtinEvaluateThought(thought, problem, context);
        }

        const prompt = `评估以下思考方向对解决问题的价值。

	【问题】${problem}
	【思考方向】${thought}

	请评估：
	1. 这个方向对解决问题有帮助吗？
	2. 可行性如何？
	3. 风险和收益如何？

	只返回 JSON：
	{
	  "value": 0.0-1.0,
	  "verdict": "sure" | "maybe" | "impossible",
	  "reasoning": "简短理由（一句话）"
	}`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是一个思维评估系统。严格返回 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                return JSON.parse(match[0]);
            }
        } catch (e) {
            console.warn('[TreeOfThoughts] LLM eval parse failed:', e.message);
        }

        return { value: 0.5, verdict: 'maybe', reasoning: 'Parse fallback' };
    }

    /**
     * 内置启发式评估——无需LLM
     */
    _builtinEvaluateThought(thought, problem, context) {
        const thoughtLower = thought.toLowerCase();
        const problemLower = problem.toLowerCase();

        // 评分因素:
        let score = 0.5;

        // 1. 相关性：想法与问题的关键词重叠度
        const problemWords = new Set(problemLower.split(/\s+/).filter(w => w.length > 2));
        const thoughtWords = new Set(thoughtLower.split(/\s+/).filter(w => w.length > 2));
        const overlap = [...problemWords].filter(w => thoughtWords.has(w)).length;
        if (problemWords.size > 0) {
            score += (overlap / problemWords.size) * 0.2;
        }

        // 2. 可操作性：是否包含具体的动词或行动指引
        const actionVerbs = ['分析', '检查', '创建', '使用', '分解', '确定', '评估', '测试', '验证', '比较', '实现', '设计'];
        const hasAction = actionVerbs.some(v => thoughtLower.includes(v));
        if (hasAction) score += 0.1;

        // 3. 安全性：是否包含风险关键词
        const riskWords = ['删除', '格式化', '覆盖', '终止', '强制', '跳过', '忽略'];
        const hasRisk = riskWords.some(w => thoughtLower.includes(w));
        if (hasRisk) score -= 0.1;

        // 4. 创新性：是否与当前思路不同
        const explorationWords = ['另一种', '反向', '假设', '如果', '替代', '不同角度', '其他方式'];
        const isExploratory = explorationWords.some(w => thoughtLower.includes(w));
        if (isExploratory) score += 0.05;

        // 5. 完整性：思路是否完整（包含多个信息点）
        const sentences = thought.split(/[，。；]/).filter(s => s.trim().length > 5);
        if (sentences.length >= 2) score += 0.05;
        if (sentences.length >= 3) score += 0.05;

        // 限制范围并确定verdict
        const finalScore = Math.max(0, Math.min(1, score));
        let verdict = 'maybe';
        if (finalScore >= 0.7) verdict = 'sure';
        else if (finalScore <= 0.2) verdict = 'impossible';

        return {
            value: finalScore,
            verdict,
            reasoning: finalScore >= 0.6 ? '方向可行' : (finalScore >= 0.3 ? '方向有待验证' : '方向不明确')
        };
    }

    /**
     * 多种剪枝策略组合
     */
    _semanticPrune(evaluated) {
        if (evaluated.length <= 1) return evaluated;

        // 策略1: Jaccard 相似度去重
        const threshold = 0.6;
        const clusters = [];
        for (const item of evaluated) {
            let added = false;
            for (const cluster of clusters) {
                const sim = this._jaccardSimilarity(
                    item.node.thought,
                    cluster[0].node.thought
                );
                if (sim > threshold) {
                    cluster.push(item);
                    added = true;
                    break;
                }
            }
            if (!added) clusters.push([item]);
        }

        // 策略2: 策略互补保留（同一簇内保留最高分和最低分，保留多样性）
        const result = [];
        for (const cluster of clusters) {
            if (cluster.length <= 1) {
                result.push(cluster[0]);
            } else {
                // 保留最高分
                const sorted = cluster.sort((a, b) => b.score - a.score);
                result.push(sorted[0]);
                // 如果簇内差异大，再保留一个互补的
                if (sorted.length > 2 && (sorted[0].score - sorted[sorted.length - 1].score) > 0.3) {
                    result.push(sorted[sorted.length - 1]);
                }
            }
        }

        return result;
    }

    getStats() {
        return { ...this.stats };
    }
}

module.exports = TreeOfThoughts;
