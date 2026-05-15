// CognitiveOrchestrator — 认知编排器

const DecisionEngine = require('./DecisionEngine');

class CognitiveOrchestrator {
    constructor(options = {}) {
        this.debug = options.debug || false;

        this.cognitiveFramework = options.cognitiveFramework || null;
        this.toolExecutor = options.toolExecutor || null;
        this.stateManager = options.stateManager || null;
        this.memoryManager = options.memoryManager || null;
        this.deviceManager = options.deviceManager || null;
        this.safetyEngine = options.safetyEngine || null;

        this.decisionEngine = new DecisionEngine({
            debug: options.debug,
            autonomousThreshold: options.autonomousThreshold || 0.65,
            advisoryThreshold: options.advisoryThreshold || 0.35
        });

        this._state = {
            status: 'idle',          // idle | perceiving | thinking | deciding | executing | learning
            currentTask: null,
            startTime: null,
            consecutiveFailures: 0
        };

        this._executionHistory = [];

        this.config = {
            maxConsecutiveFailures: options.maxConsecutiveFailures || 3,
            maxExecutionHistory: options.maxExecutionHistory || 100,
            autoLearn: options.autoLearn !== false
        };

        this.stats = {
            totalTasks: 0,
            successfulTasks: 0,
            failedTasks: 0,
            averageExecutionTime: 0,
            totalExecutionTime: 0,
            lastTaskTime: null
        };
    }

    init() {
        // 注入引擎引用到决策引擎
        if (this.cognitiveFramework) {
            this.decisionEngine.inject({
                cognitiveFramework: this.cognitiveFramework,
                reasoningEngine: this.cognitiveFramework.reasoningEngine,
                patternDetector: this.cognitiveFramework.patternDetector,
                conceptBuilder: this.cognitiveFramework.conceptBuilder,
                selfAssessor: this.cognitiveFramework.selfAssessor,
                strategyLibrary: this.cognitiveFramework.strategyLibrary,
                knowledgeGraph: this.cognitiveFramework.knowledgeGraph,
                patternLibrary: this.cognitiveFramework.patternLibrary,
                experienceDB: this.cognitiveFramework.experienceDB,
                carrierProfile: this.cognitiveFramework.carrierProfile,
                feedbackProcessor: this.cognitiveFramework.feedbackProcessor
            });
        }

        if (this.debug) {
            console.log('[CognitiveOrchestrator] 初始化完成');
        }
    }

    /**
     * 执行任务的完整闭环
     * @param {string|object} task - 任务描述
     * @param {object} [options]
     * @returns {object} 执行结果
     */
    async runTask(task, options = {}) {
        this._state.status = 'perceiving';
        this._state.currentTask = task;
        this._state.startTime = Date.now();
        this.stats.totalTasks++;

        try {
            // 感知阶段
            if (this.debug) console.log('[CognitiveOrchestrator] 感知中...');
            const perception = await this._perceive(task, options);

            // 思考阶段
            this._state.status = 'thinking';
            if (this.debug) console.log('[CognitiveOrchestrator] 思考中...');
            const thought = await this._think(perception, options);

            // 决策阶段
            			// Anti-hallucination: check for re-phrased questions
			const taskStr = typeof task === 'string' ? task : (task.description || task.task || '');
			const questionKeywords = ['如何', '怎么', '怎样', '什么', 'how to', 'how do', 'what is', 'what are', 'how can', 'how would'];
			const isAsking = questionKeywords.some(v => taskStr.toLowerCase().includes(v));
			if (isAsking && !taskStr.startsWith('帮') && !taskStr.startsWith('请') && !taskStr.startsWith('创建')) {
			    if (this.debug) console.log('[CognitiveOrchestrator] Question detected, not executing');
			    return {
			        success: false,
			        mode: 'help',
			        message: 'User is asking a question, not issuing a command',
			        state: this._state
			    };
			}
			
			this._state.status = 'deciding';
            if (this.debug) console.log('[CognitiveOrchestrator] 决策中...');
            const decision = await this._decide(thought, perception, options);

            // 如果决策模式是 "help"，不执行
            if (decision.mode === 'help') {
                return {
                    success: false,
                    mode: 'help',
                    decision,
                    message: '自信度不足，无法自主决策',
                    state: this._state
                };
            }

            // 执行阶段
            this._state.status = 'executing';
            if (this.debug) console.log('[CognitiveOrchestrator] 执行中...');
            const execution = await this._execute(decision, task, options);

            // 学习阶段
            this._state.status = 'learning';
            if (this.config.autoLearn) {
                if (this.debug) console.log('[CognitiveOrchestrator] 学习中...');
                await this._learn(task, decision, execution);
            }

            // 完成
            this._state.status = 'idle';
            const elapsed = Date.now() - this._state.startTime;

            this.stats.totalExecutionTime += elapsed;
            this.stats.averageExecutionTime = this.stats.totalExecutionTime / this.stats.totalTasks;
            this.stats.lastTaskTime = new Date().toISOString();

            if (execution.success) {
                this.stats.successfulTasks++;
                this._state.consecutiveFailures = 0;
            } else {
                this.stats.failedTasks++;
                this._state.consecutiveFailures++;
            }

            const result = {
                success: execution.success,
                mode: decision.mode,
                elapsed,
                perception: {
                    taskType: perception.type,
                    contextSummary: perception.summary?.substring(0, 100)
                },
                decision: {
                    action: decision.decision.action,
                    confidence: decision.decision.confidence,
                    reason: decision.decision.reason
                },
                execution: {
                    result: execution.result,
                    error: execution.error
                },
                safety: decision.safety,
                state: {
                    status: this._state.status,
                    consecutiveFailures: this._state.consecutiveFailures
                }
            };

            this._executionHistory.push(result);
            if (this._executionHistory.length > this.config.maxExecutionHistory) {
                this._executionHistory = this._executionHistory.slice(-this.config.maxExecutionHistory);
            }

            return result;

        } catch (e) {
            this._state.status = 'idle';
            this.stats.failedTasks++;
            console.error('[CognitiveOrchestrator] 任务异常:', e.message);

            return {
                success: false,
                error: e.message,
                mode: 'error',
                elapsed: Date.now() - this._state.startTime,
                state: this._state
            };
        }
    }

    /**
     * 快速执行（跳过完整闭环，适合简单任务）
     */
    async quickTask(task, options = {}) {
        if (!this.toolExecutor) {
            return { success: false, error: '无执行器' };
        }

        try {
            // 快速决策
            const quickDecision = await this.decisionEngine.quickDecide(task);

            if (quickDecision.quick && quickDecision.mode === 'autonomous') {
                // 直接执行
                const result = await this.toolExecutor.execute(
                    quickDecision.decision.action,
                    quickDecision.decision.plan
                );

                return {
                    success: true,
                    quick: true,
                    action: quickDecision.decision.action,
                    result
                };
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // 退化到完整闭环
        return this.runTask(task, options);
    }

    getStatus() {
        return {
            state: this._state,
            stats: this.stats,
            decisionEngine: this.decisionEngine.getStats(),
            executionHistory: this._executionHistory.slice(-5)
        };
    }

    // 闭环各阶段

    async _perceive(task, options) {
        const perception = {
            task: typeof task === 'string' ? task : task.description || task.task || JSON.stringify(task),
            type: task.type || options.type || 'general',
            domain: task.domain || options.domain || 'general',
            timestamp: new Date().toISOString(),
            carrierState: null,
            recentExperiences: null,
            userContext: options.userContext || null
        };

        // 收集承载体当前状态
        if (this.deviceManager) {
            try {
                perception.carrierState = this.deviceManager.getFullReport ?
                    this.deviceManager.getFullReport() :
                    this.deviceManager.getDeviceStats ?
                        this.deviceManager.getDeviceStats() : {};
            } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        }

        // 获取最近经验
        if (this.cognitiveFramework?.experienceDB) {
            perception.recentExperiences =
                this.cognitiveFramework.experienceDB.getRecent(10);
        }

        // 获取承载体画像摘要
        if (this.cognitiveFramework?.carrierProfile) {
            perception.carrierSummary =
                this.cognitiveFramework.carrierProfile.getSummary();
        }

        return perception;
    }

    async _think(perception, options) {
        if (!this.cognitiveFramework) {
            return { conclusion: '无认知框架', factors: [], patterns: [], confidence: 0.1 };
        }

        // 使用认知框架的 think 进行分析
        const thought = await this.cognitiveFramework.think(perception.task, {
            domain: perception.domain,
            state: perception.carrierState || {}
        });

        return thought;
    }

    async _decide(thought, perception, options) {
        const decision = await this.decisionEngine.decide({
            situation: perception.task,
            context: {
                domain: perception.domain,
                state: perception.carrierState,
                intent: perception.type,
                urgency: options.urgency || 'normal',
                impact: options.impact || 'normal'
            }
        });

        return decision;
    }

    /**
     * 执行阶段：调用 ToolExecutor 安全执行
     */
    async _execute(decision, task, options) {
        if (!this.toolExecutor) {
            return { success: false, error: '无工具执行器', result: null };
        }

        // 安全检查
        if (!decision.safety.passed) {
            return {
                success: false,
                error: `安全检查未通过: ${decision.safety.warnings.join('; ')}`,
                result: null,
                safetyBlocked: true
            };
        }

        try {
            // 执行
            const execResult = await this.toolExecutor.execute(
                decision.decision.action,
                decision.decision.plan
            );

            return { success: true, result: execResult, error: null };
        } catch (e) {
            return { success: false, error: e.message, result: null };
        }
    }

    /**
     * 学习阶段：记录结果、更新策略、触发进化
     */
    async _learn(task, decision, execution) {
        const cf = this.cognitiveFramework;
        if (!cf) return;

        try {
            // 1. 记录执行结果到经验数据库
            await cf.learn('tool_execution', {
                tool: decision.decision.action,
                success: execution.success,
                error: execution.error,
                elapsed: execution.elapsed
            }, {
                toolName: decision.decision.action,
                domain: task.domain || 'general',
                confidence: decision.decision.confidence
            });

            // 2. 记录到反馈处理器
            if (cf.feedbackProcessor) {
                await cf.feedbackProcessor.process({
                    context: task.domain || 'general',
                    action: decision.decision.action,
                    result: {
                        success: execution.success,
                        error: execution.error,
                        elapsed: execution.elapsed
                    },
                    domain: task.domain || 'general'
                });
            }

            // 3. 记录到策略库
            if (cf.strategyLibrary) {
                cf.strategyLibrary.learnFromExecution(
                    task.domain || 'general',
                    decision.decision.action,
                    execution.success,
                    { elapsed: execution.elapsed, error: execution.error }
                );
            }

            // 4. 更新自我评估
            if (cf.selfAssessor) {
                cf.selfAssessor.recordOutcome(
                    { action: decision.decision.action, domain: task.domain || 'general', confidence: decision.decision.confidence },
                    { success: execution.success, error: execution.error }
                );
            }

            // 5. 通知进化引擎
            cf.selfEvolver.notifyNewExperience();

        } catch (e) {
            if (this.debug) console.warn('[CognitiveOrchestrator] 学习阶段异常:', e.message);
        }
    }
}

module.exports = CognitiveOrchestrator;
