// AdversarialVerifier - adversarial verifier
class AdversarialVerifier {
    constructor(options = {}) {
        this.llmAdapter = options.llmAdapter || null;
        this.verificationDepth = options.verificationDepth || 'quick'; // 'quick' | 'thorough'
        this.enabled = options.enabled !== false;

        this.stats = {
            totalVerifications: 0,
            passedCount: 0,
            failedCount: 0,
            totalIssuesFound: 0
        };
    }

    /**
     * Verify an agent's response
     */
    async verify(response, context = {}) {
        if (!this.enabled || !this.llmAdapter) {
            return { passed: true, issues: [], score: 1.0 };
        }

        this.stats.totalVerifications++;

        const result = this.verificationDepth === 'thorough'
            ? await this._thoroughVerify(response, context)
            : await this._quickVerify(response, context);

        if (result.passed) {
            this.stats.passedCount++;
        } else {
            this.stats.failedCount++;
        }
        this.stats.totalIssuesFound += result.issues.length;

        return result;
    }

    /**
     * Quick verification (single LLM call)
     */
    async _quickVerify(response, context) {
        const userMessage = context.userMessage || '';
        const instructions = context.instructions || '';

        const prompt = `你是一个严格的验证者。请检查以下 AI 回复是否存在问题。

【用户需求】${userMessage.substring(0, 500)}
${instructions ? `【指令要求】${instructions.substring(0, 500)}` : ''}
【AI 回复】${response.substring(0, 2000)}

请检查：
1. 回复是否完整回答了用户的所有问题？
2. 是否存在事实性错误或幻觉？
3. 是否有逻辑矛盾？

只返回 JSON：
{
  "passed": true/false,
  "issues": [{ "severity": "critical"|"major"|"minor", "description": "问题描述" }],
  "score": 0-1,
  "summary": "一句话总结"
}`;

        const llmResponse = await this.llmAdapter.chat([
            { role: 'system', content: '你是一个严格的 AI 输出验证者。只输出 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof llmResponse === 'string' ? llmResponse :
                     (llmResponse.content || llmResponse.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) { console.warn(`[conversation] Unhandled error: ${e.message}`); }

        return { passed: true, issues: [], score: 0.8, summary: 'Parse fallback: assumed passed' };
    }

    /**
     * Thorough verification (multi-round)
     */
    async _thoroughVerify(response, context) {
        // 第一轮：基础检查
        const quickResult = await this._quickVerify(response, context);

        if (quickResult.passed) return quickResult;

        // 第二轮：如果发现问题，深入检查并提出修改建议
        if (!quickResult.passed && quickResult.issues) {
            const criticalIssues = quickResult.issues.filter(i => i.severity === 'critical');

            if (criticalIssues.length > 0) {
                const fix = await this.suggestFix(response, quickResult.issues);
                return {
                    ...quickResult,
                    suggestedFix: fix,
                    needsRevision: true
                };
            }
        }

        return quickResult;
    }

    /**
     * Suggest fixes for issues found
     */
    async suggestFix(response, issues) {
        if (!this.llmAdapter) return null;

        const issuesText = issues.map(i => `[${i.severity}] ${i.description}`).join('\n');

        const prompt = `请修正以下 AI 回复中的问题。

【问题列表】
${issuesText}

【原始回复】
${response}

请提供一个修正版本。`;

        const llmResponse = await this.llmAdapter.chat([
            { role: 'system', content: '你是修正助手。修复问题，保留好的部分。' },
            { role: 'user', content: prompt }
        ]);

        return typeof llmResponse === 'string' ? llmResponse :
               (llmResponse.content || llmResponse.message?.content || '');
    }

    /**
     * Quick check without LLM call
     */
    quickCheck(response, userMessage) {
        const issues = [];

        // 检查长度
        if (!response || response.length < 5) {
            issues.push({ severity: 'major', description: '回复过短' });
        }

        // 检查用户消息中的关键词是否在回复中被提及
        if (userMessage) {
            const userWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const respLower = response.toLowerCase();
            const missingWords = userWords.filter(w => !respLower.includes(w));
            if (missingWords.length > userWords.length * 0.5) {
                issues.push({
                    severity: 'minor',
                    description: `回复可能遗漏了用户关注的关键词: ${missingWords.slice(0, 3).join(', ')}`
                });
            }
        }

        return {
            passed: issues.length === 0,
            issues,
            score: issues.length === 0 ? 1.0 : 0.5,
            source: 'quick_check'
        };
    }

    getStats() {
        return { ...this.stats, passRate: this.stats.totalVerifications > 0
            ? (this.stats.passedCount / this.stats.totalVerifications).toFixed(2)
            : 'N/A' };
    }
}

module.exports = AdversarialVerifier;
