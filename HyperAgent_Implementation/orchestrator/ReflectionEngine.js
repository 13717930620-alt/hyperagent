// ReflectionEngine - reflection loop engine
class ReflectionEngine {
    constructor(memoryManager, llmAdapter, options = {}) {
        this.memoryManager = memoryManager;
        this.llm = llmAdapter;
        this.maxReflectionDepth = options.maxDepth || 3;
        this.failurePatterns = new Map(); // patternKey -> { count, lastSeen, solutions }
        this.reflectionLog = [];
        this.maxLogSize = options.maxLogSize || 200;
    }

    /**
     * Pre-reflection: review similar history before execution
     */
    async preReflect(goal, options = {}) {
        console.log(`[ReflectionEngine] Pre-reflection on: "${goal.substring(0, 60)}..."`);

        const results = {
            similarPastTasks: [],
            knownFailureModes: [],
            recommendations: [],
            riskLevel: 'low'
        };

        // 1. 在记忆中搜索类似任务
        if (this.memoryManager) {
            const similar = await this.memoryManager.retrieve(goal, {
                searchLevels: ['L2', 'L3'],
                limit: 5,
                useRelevance: true
            });

            for (const mem of similar) {
                const content = typeof mem.content === 'string' ? mem.content : '';
                if (content.includes('[失败]') || content.includes('[错误]') || content.includes('[教训]')) {
                    results.knownFailureModes.push(content.substring(0, 200));
                } else if (content.includes('[成功]') || content.includes('[经验]')) {
                    results.similarPastTasks.push(content.substring(0, 200));
                }
            }
        }

        // 2. 检查已知失败模式
        for (const [pattern, data] of this.failurePatterns) {
            if (goal.toLowerCase().includes(pattern.toLowerCase()) || this._fuzzyMatch(goal, pattern)) {
                results.knownFailureModes.push(`已知失败模式 "${pattern}" (出现${data.count}次): ${data.lastError?.substring(0, 100)}`);
                results.recommendations.push(data.solutions?.[0] || '注意避免此模式');
            }
        }

        // 3. 评估风险等级
        if (results.knownFailureModes.length >= 2) results.riskLevel = 'high';
        else if (results.knownFailureModes.length >= 1) results.riskLevel = 'medium';

        // 4. 用 LLM 做更深入的前置分析
        if (this.llm && typeof this.llm.chat === 'function' && results.riskLevel !== 'low') {
            try {
                const context = results.knownFailureModes.map((f, i) => `${i + 1}. ${f}`).join('\n');
                const response = await this.llm.chat([
                    { role: 'system', content: '你是一个反思型AI架构师。分析即将执行的任务和相关历史失败记录，给出具体的改进建议。简洁、可操作。' },
                    { role: 'user', content: `即将执行: ${goal}\n已知风险: ${context || '无'}\n请给出 2-3 条具体建议以规避风险。` }
                ]);
                results.llmAdvice = response.replace(/```/g, '').trim();
            } catch (e) {
                results.llmAdvice = null;
            }
        }

        this._log('pre_reflect', goal, results);
        return results;
    }

    /**
     * During-reflection: detect issues and decide if adjustment is needed
     */
    async duringReflect(stepResult, stepIndex, plan) {
        const result = {
            needsAdjustment: false,
            adjustment: null,
            confidence: 1.0,
            issues: []
        };

        if (!stepResult) return result;

        // 1. 检查执行是否返回错误
        if (stepResult.error) {
            result.issues.push(`步骤 ${stepIndex} 错误: ${stepResult.error}`);
            result.needsAdjustment = true;
            result.confidence = 0.3;
        }

        // 2. 检查执行结果是否为空或不符合预期
        if (stepResult.verified === false) {
            result.issues.push(`步骤 ${stepIndex} 验证失败`);
            result.needsAdjustment = true;
            result.confidence = 0.4;
        }

        // 3. 检查执行用时（过长可能表示有问题）
        if (stepResult.duration && stepResult.duration > 30000) {
            result.issues.push(`步骤 ${stepIndex} 执行时间过长 (${(stepResult.duration / 1000).toFixed(1)}s)`);
            result.confidence -= 0.1;
        }

        // 4. 如果需要调整，生成修正方案
        if (result.needsAdjustment && this.llm) {
            result.adjustment = await this._generateAdjustment(stepResult, stepIndex, plan);
        }

        this._log('during_reflect', `Step ${stepIndex}`, result);
        return result;
    }

    /**
     * Post-reflection: evaluate result quality and extract lessons
     */
    async postReflect(goal, result, executionData = {}) {
        console.log('[ReflectionEngine] Post-reflection: evaluating result quality');

        const evaluation = {
            success: false,
            qualityScore: 0,
            strengths: [],
            weaknesses: [],
            lessons: [],
            canImprove: false,
            improvementSuggestions: []
        };

        // 1. 结果存在性检查
        if (!result || result === '') {
            evaluation.weaknesses.push('结果为空');
            return evaluation;
        }

        // 2. 检查是否有错误
        const errorIndicators = ['error', '失败', '错误', '异常', 'timeout', 'fail'];
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const hasError = errorIndicators.some(e => resultStr.toLowerCase().includes(e));
        if (!hasError) evaluation.strengths.push('无错误报告');

        // 3. 结果长度和完整性
        if (resultStr.length > 20) {
            evaluation.strengths.push('结果非空且有内容');
            evaluation.qualityScore += 0.3;
        }
        if (resultStr.length > 200) {
            evaluation.qualityScore += 0.2;
        }

        // 4. 执行时间评价
        if (executionData.duration) {
            if (executionData.duration < 10000) evaluation.qualityScore += 0.2;
            else if (executionData.duration > 120000) evaluation.weaknesses.push('执行时间过长');
        }

        // 5. 用 LLM 做质量评价（如果有）
        if (this.llm && typeof this.llm.chat === 'function') {
            try {
                const response = await this.llm.chat([
                    { role: 'system', content: '你是一个任务质量评估专家。评价以下任务执行结果的质量，指出改进点。简洁。' },
                    { role: 'user', content: `目标: ${goal}\n结果: ${resultStr.substring(0, 1000)}\n\n评价(包含: 质量分数0-10, 优点, 缺点, 改进建议)` }
                ]);
                evaluation.llmFeedback = response.replace(/```/g, '').trim();
                if (evaluation.llmFeedback.includes('质量分数') || evaluation.llmFeedback.includes('评分')) {
                    const scoreMatch = evaluation.llmFeedback.match(/(\d+)\s*\/?\s*10/);
                    if (scoreMatch) evaluation.qualityScore = Math.max(evaluation.qualityScore, parseInt(scoreMatch[0]) / 10);
                }
            } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
        }

        // 6. 提取经验教训并存入记忆
        evaluation.lessons = await this._extractLessons(goal, result, hasError);

        if (hasError || evaluation.qualityScore < 0.5) {
            evaluation.canImprove = true;
            evaluation.improvementSuggestions = evaluation.lessons.slice(0, 3);
        }

        evaluation.success = evaluation.qualityScore >= 0.5 && !hasError;
        this._log('post_reflect', goal, evaluation);

        // 7. 如果失败，记录失败模式
        if (!evaluation.success) {
            await this._recordFailurePattern(goal, result, evaluation);
        }

        return evaluation;
    }

    /**
     * Extract lessons from results and store in memory
     */
    async _extractLessons(goal, result, hasError) {
        const lessons = [];

        if (hasError) {
            lessons.push(`[教训] ${goal.substring(0, 50)} — 执行出现错误，需检查前置条件`);
        }

        if (this.llm && typeof this.llm.chat === 'function') {
            try {
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                const response = await this.llm.chat([
                    { role: 'system', content: '从以下任务执行中提取 1-2 条可复用的经验教训。每句话以"[经验]"或"[教训]"开头。简洁。' },
                    { role: 'user', content: `目标: ${goal}\n结果: ${resultStr.substring(0, 800)}` }
                ]);
                const extracted = response.replace(/```/g, '').trim().split('\n').filter(l => l.trim());
                for (const line of extracted) {
                    if (line.startsWith('[') && line.length > 10) {
                        lessons.push(line.trim());
                    }
                }
            } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
        }

        // 将教训存入 L2 记忆
        if (this.memoryManager && lessons.length > 0) {
            for (const lesson of lessons) {
                const tag = lesson.startsWith('[教训]') ? '失败' : '经验';
                await this.memoryManager.pushMemory(lesson, 'L2');
            }
        }

        return lessons;
    }

    /**
     * Record failure patterns for future prevention
     */
    async _recordFailurePattern(goal, result, evaluation) {
        const goalKey = goal.substring(0, 30);
        const errorText = typeof result === 'string' ? result.substring(0, 100) : 'unknown error';

        if (!this.failurePatterns.has(goalKey)) {
            this.failurePatterns.set(goalKey, { count: 0, lastSeen: null, lastError: null, solutions: [] });
        }

        const pattern = this.failurePatterns.get(goalKey);
        pattern.count++;
        pattern.lastSeen = new Date().toISOString();
        pattern.lastError = errorText;

        if (evaluation.improvementSuggestions.length > 0) {
            pattern.solutions.push(...evaluation.improvementSuggestions);
            if (pattern.solutions.length > 10) pattern.solutions = pattern.solutions.slice(-10);
        }

        // 如果失败次数过多，存入 L3 作为核心洞察
        if (pattern.count >= 3 && this.memoryManager) {
            await this.memoryManager.pushMemory(
                `[失败模式] 任务"${goalKey}" 已失败 ${pattern.count} 次. 最后错误: ${errorText}. 建议: ${pattern.solutions[0] || ''}`,
                'L3'
            );
        }
    }

    /**
     * Generate adjustment based on execution feedback
     */
    async _generateAdjustment(stepResult, stepIndex, plan) {
        if (!this.llm) return { action: 'retry', reason: 'No LLM available for adjustment' };

        try {
            const planStr = JSON.stringify(plan);
            const errorMsg = stepResult.error || 'verification_failed';
            const response = await this.llm.chat([
                { role: 'system', content: '你是任务执行修正专家。分析失败的步骤，给出修正后的操作和参数。返回 JSON: {"action":"修正后的工具","params":{},"reason":"修正原因"}' },
                { role: 'user', content: `计划: ${planStr.substring(0, 500)}\n步骤 ${stepIndex} 失败: ${errorMsg}\n参数: ${JSON.stringify(plan.steps?.[stepIndex]?.params || {})}\n\n给出修正方案(JSON):` }
            ]);
            const cleaned = response.replace(/```json|```/g, '').trim();
            return JSON.parse(cleaned);
        } catch (e) {
            return { action: 'retry', params: plan.steps?.[stepIndex]?.params || {}, reason: `Auto-retry after: ${stepResult.error}` };
        }
    }

    /**
     * 检查两个字符串是否模糊匹配（共享足够的关键词）
     */
    _fuzzyMatch(str, pattern) {
        const strWords = new Set(str.toLowerCase().split(/[\s,，。、；：]+/).filter(w => w.length > 1));
        const patternWords = new Set(pattern.toLowerCase().split(/[\s,，。、；：]+/).filter(w => w.length > 1));
        let matchCount = 0;
        for (const w of patternWords) {
            if (strWords.has(w)) matchCount++;
        }
        return matchCount >= 2;
    }

    _log(type, subject, data) {
        this.reflectionLog.push({
            type, subject: subject.substring(0, 100),
            timestamp: new Date().toISOString(),
            summary: data.riskLevel || data.qualityScore || data.confidence || 'logged'
        });
        if (this.reflectionLog.length > this.maxLogSize) this.reflectionLog.shift();
    }

    getStats() {
        return {
            totalReflections: this.reflectionLog.length,
            failurePatterns: this.failurePatterns.size,
            recent: this.reflectionLog.slice(-5)
        };
    }
}

module.exports = ReflectionEngine;
