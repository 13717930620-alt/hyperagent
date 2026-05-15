/**
 * ScreenAgent — Plan-Act-Reflect loop for visual GUI automation.
 */
class ScreenAgent {
    constructor(options = {}) {
        this.llmAdapter = options.llmAdapter || null;
        this.guiOperator = options.guiOperator || null;
        this.maxIterations = options.maxIterations || 10;
        this.screenshotDir = options.screenshotDir || './screenshots';

        this.stats = {
            totalTasks: 0,
            completedTasks: 0,
            failedTasks: 0,
            totalSteps: 0
        };
    }

    /**
     * 执行完整的 GUI 任务（Plan-Act-Reflect 循环）
     */
    async runTask(goal, options = {}) {
        this.stats.totalTasks++;
        const maxIter = options.maxIterations || this.maxIterations;

        console.log(`[ScreenAgent] Task: ${goal}`);

        let iteration = 0;
        let context = {
            goal,
            completedSteps: [],
            lastActionResult: null,
            lastScreenshot: null
        };

        while (iteration < maxIter) {
            iteration++;
            this.stats.totalSteps++;

            // Plan: 分析当前状态决定下一步
            const plan = await this._plan(context);
            if (plan.done) {
                this.stats.completedTasks++;
                console.log(`[ScreenAgent] Task completed in ${iteration} steps`);
                return { success: true, steps: iteration, summary: plan.summary };
            }

            // Act: 执行操作
            const actionResult = await this._act(plan.action);
            context.lastActionResult = actionResult;

            // Reflect: 验证操作结果
            const reflect = await this._reflect(context);
            context = { ...context, ...reflect };
            context.completedSteps.push(plan.action.description || plan.action.type);

            if (reflect.done) {
                this.stats.completedTasks++;
                console.log(`[ScreenAgent] Task completed in ${iteration} steps`);
                return { success: true, steps: iteration, summary: reflect.assessment };
            }

            // Exit on consecutive failures
            if (reflect.failed) {
                this.stats.failedTasks++;
                console.warn(`[ScreenAgent] Task failed at step ${iteration}: ${reflect.error}`);
                return { success: false, steps: iteration, error: reflect.error };
            }
        }

        this.stats.failedTasks++;
        console.warn(`[ScreenAgent] Task incomplete after ${maxIter} iterations`);
        return { success: false, steps: maxIter, error: 'Max iterations reached' };
    }

    /**
     * Plan 阶段：分析屏幕，规划下一步
     */
    async _plan(context) {
        if (!this.llmAdapter) {
            return { action: { type: 'screenshot' }, done: false };
        }

        const prompt = `你是一个 GUI 操作规划器。基于当前屏幕状态和任务目标，决定下一步操作。

【任务】${context.goal}
【已完成步骤】${context.completedSteps.join(' -> ') || '(尚未开始)'}
【上一步结果】${context.lastActionResult ? JSON.stringify(context.lastActionResult).substring(0, 200) : '无'}

请分析并返回 JSON：
{
  "analysis": "当前屏幕状态分析（一句话）",
  "action": {
    "type": "click" | "type" | "scroll" | "screenshot" | "wait",
    "params": {},
    "description": "操作描述"
  },
  "done": false,
  "summary": null
}

如果任务已经完成，设置 done=true 并提供 summary。`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是 GUI 操作规划器。输出 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }

        return { action: { type: 'screenshot' }, done: false };
    }

    /**
     * Act 阶段：执行屏幕操作
     */
    async _act(action) {
        if (!this.guiOperator) {
            return { success: false, error: 'GUI Operator not available' };
        }

        try {
            switch (action.type) {
                case 'click':
                case 'left_click':
                    return await this.guiOperator.executeAction('leftClick', {
                        x: action.params?.x || 500,
                        y: action.params?.y || 500
                    });

                case 'double_click':
                    return await this.guiOperator.executeAction('doubleClick', {
                        x: action.params?.x || 500,
                        y: action.params?.y || 500
                    });

                case 'right_click':
                    return await this.guiOperator.executeAction('rightClick', {
                        x: action.params?.x || 500,
                        y: action.params?.y || 500
                    });

                case 'type':
                case 'type_text':
                    return await this.guiOperator.executeAction('type', {
                        text: action.params?.text || ''
                    });

                case 'scroll':
                    return await this.guiOperator.executeAction('scroll', {
                        x: action.params?.x || 0,
                        y: action.params?.y || 0
                    });

                case 'screenshot':
                default:
                    return await this.guiOperator.executeAction('screenshot', { returnBase64: true });
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Reflect 阶段：验证操作结果
     */
    async _reflect(context) {
        if (!this.llmAdapter) {
            return { done: false, assessment: 'No LLM available' };
        }

        const prompt = `验证以下 GUI 操作的结果。

【任务】${context.goal}
【执行的操作】${context.lastActionResult?.description || JSON.stringify(context.lastActionResult) || '截图检查'}

请评估：
1. 操作是否成功执行？
2. 任务是否已完成？
3. 如果未完成，下一步应该做什么？

返回 JSON：
{
  "done": true/false,
  "failed": true/false,
  "error": null 或失败原因,
  "assessment": "评估描述",
  "nextStep": "建议的下一步"
}`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是 GUI 操作验证器。输出 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }

        return { done: false, failed: false, assessment: 'Reflect fallback', nextStep: 'continue' };
    }

    getStats() {
        return { ...this.stats, successRate: this.stats.totalTasks > 0
            ? (this.stats.completedTasks / this.stats.totalTasks * 100).toFixed(1) + '%'
            : 'N/A' };
    }
}

module.exports = ScreenAgent;
