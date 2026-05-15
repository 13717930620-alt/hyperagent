// CognitiveFramework — 元认知框架主入口

const path = require('path');
const ExperienceDatabase = require('../../JingxuanAgent_Implementation/cognitive_core/ExperienceDatabase');
const CarrierProfile = require('../../JingxuanAgent_Implementation/cognitive_core/CarrierProfile');
const ReasoningEngine = require('./ReasoningEngine');
const PatternDetector = require('./PatternDetector');
const ConceptBuilder = require('./ConceptBuilder');
const SelfAssessor = require('./SelfAssessor');

// Phase 3: 知识体组件
const KnowledgeGraph = require('./KnowledgeGraph');
const PatternLibrary = require('./PatternLibrary');
const StrategyLibrary = require('./StrategyLibrary');
const CarrierSelfDiscovery = require('../../JingxuanAgent_Implementation/cognitive_core/CarrierSelfDiscovery');

// Phase 4: 进化引擎组件
const SelfEvolver = require('./SelfEvolver');
const FeedbackProcessor = require('./FeedbackProcessor');
const ModelEvaluator = require('./ModelEvaluator');

class CognitiveFramework {
    constructor(options = {}) {
        this.version = '1.3.0';
        this.name = 'JingxuanAgent Cognitive Framework';

        this.storageDir = options.storageDir || path.join(process.cwd(), 'experience_store');

        // 核心组件
        this.experienceDB = new ExperienceDatabase({
            storageDir: this.storageDir,
            maxMemEntries: options.maxMemEntries || 10000
        });

        this.carrierProfile = new CarrierProfile({
            storageDir: this.storageDir,
            experienceDB: this.experienceDB,
            carrierType: options.carrierType || 'pc',
            name: options.name || 'JingxuanAgent Carrier'
        });

        // Phase 2: 元认知引擎（推理/模式/概念/自我评估）
        this.reasoningEngine = new ReasoningEngine({ debug: options.debug });
        this.patternDetector = new PatternDetector({ debug: options.debug });
        this.conceptBuilder = new ConceptBuilder({ debug: options.debug });
        this.selfAssessor = new SelfAssessor({ debug: options.debug });

        // Phase 3: 自建知识体（知识图谱/模式库/策略库/自发现）
        this.knowledgeGraph = new KnowledgeGraph({
            storageDir: this.storageDir,
            debug: options.debug
        });
        this.patternLibrary = new PatternLibrary({
            storageDir: this.storageDir,
            debug: options.debug
        });
        this.strategyLibrary = new StrategyLibrary({
            storageDir: this.storageDir,
            debug: options.debug
        });
        this.selfDiscovery = new CarrierSelfDiscovery({
            carrierType: options.carrierType || 'pc',
            debug: options.debug
        });

        // Phase 4: 进化引擎（进化控制器/反馈处理/模型评估）
        this.selfEvolver = new SelfEvolver({ debug: options.debug });
        this.feedbackProcessor = new FeedbackProcessor({ debug: options.debug });
        this.modelEvaluator = new ModelEvaluator({ debug: options.debug });

        // 外部接口（由 JingxuanAgent_Main.js 注入）
        this.deviceManager = null;
        this.toolExecutor = null;
        this.memoryManager = null;
        this.llmAdapter = null;          // 仅作为语言解析工具，非核心认知

        this._initialized = false;
        this._active = false;
        this._absorbTimer = null;
        this._thinkingTimer = null;
        this._stateBuffer = [];
        this._lastStateHash = null;

        this.stats = {
            startTime: null,
            totalAbsorbed: 0,
            totalThoughts: 0,
            totalEvolutions: 0,
            lastThinkTime: null,
            lastEvolveTime: null
        };


        this._debug = options.debug || false;
    }

    // 生命周期

    /**
     * 初始化认知框架
     */
    async init() {
        if (this._initialized) return;

        this.stats.startTime = Date.now();
        this._initialized = true;

        this.knowledgeGraph.load();
        this.patternLibrary.load();
        this.strategyLibrary.load();

        const engineRefs = {
            experienceDB: this.experienceDB,
            carrierProfile: this.carrierProfile,
            reasoningEngine: this.reasoningEngine,
            patternDetector: this.patternDetector,
            conceptBuilder: this.conceptBuilder,
            selfAssessor: this.selfAssessor,
            knowledgeGraph: this.knowledgeGraph,
            patternLibrary: this.patternLibrary,
            strategyLibrary: this.strategyLibrary,
            selfEvolver: this.selfEvolver,
            feedbackProcessor: this.feedbackProcessor,
            modelEvaluator: this.modelEvaluator
        };

        this.selfEvolver.inject(engineRefs);
        this.feedbackProcessor.strategyLibrary = this.strategyLibrary;
        this.feedbackProcessor.selfAssessor = this.selfAssessor;
        this.modelEvaluator.inject(engineRefs);

        const stats = this.experienceDB.getStats();
        this.carrierProfile.updateExperienceCount(stats.totalExperiences);

        this._log(`CognitiveFramework v${this.version} initialized`);
        this._log(`  - Experiences: ${stats.totalExperiences} (${stats.inMemory} in memory)`);
        this._log(`  - Carrier: ${this.carrierProfile.getSummary().identity}`);
        this._log(`  - Stage: ${this.carrierProfile.profile.cognition.evolutionStage}`);
        this._log(`  - KnowledgeGraph: ${this.knowledgeGraph.getStats().totalEntities} entities, ${this.knowledgeGraph.getStats().totalRelationships} relationships`);
        this._log(`  - PatternLibrary: ${this.patternLibrary.getStats().totalPatterns} patterns`);
        this._log(`  - StrategyLibrary: ${this.strategyLibrary.getStats().totalStrategies} strategies`);

        return this.getStatus();
    }

    /**
     * 启动认知框架（开始自动吸收）
     */
    start() {
        if (this._active) return;
        if (!this._initialized) {
            throw new Error('CognitiveFramework must be initialized before starting');
        }

        this._active = true;
        this.carrierProfile.startSession();

        this._absorbTimer = setInterval(() => {
            this._absorbCycle().catch(e => {
                if (this._debug) console.error('[CognitiveFramework] Absorb error:', e.message);
            });
        }, 30000);

        this._thinkingTimer = setInterval(() => {
            this._thinkCycle().catch(e => {
                if (this._debug) console.error('[CognitiveFramework] Think error:', e.message);
            });
        }, 300000);

        // 启动进化引擎自进化循环
        this.selfEvolver.start();

        this._log('CognitiveFramework started (absorb=30s, think=5min, evolve=auto)');
        return this.getStatus();
    }

    /**
     * 停止认知框架
     */
    stop() {
        this._active = false;

        if (this._absorbTimer) {
            clearInterval(this._absorbTimer);
            this._absorbTimer = null;
        }
        if (this._thinkingTimer) {
            clearInterval(this._thinkingTimer);
            this._thinkingTimer = null;
        }

        this.selfEvolver.stop();
        this.carrierProfile.endSession();
        this._log('CognitiveFramework stopped');
        return true;
    }

    /**
     * 销毁框架（持久化后清理）
     */
    async destroy() {
        this.stop();
        await this.experienceDB.persist();
        await this.carrierProfile.save();
        this.knowledgeGraph.persist();
        this.patternLibrary.persist();
        this.strategyLibrary.persist();
        // 进化引擎本身不需要持久化（它管理的是过程而非状态）
        this._initialized = false;
        this._log('CognitiveFramework v1.3 destroyed');
    }

    // 核心接口

    /**
     * 分析当前情境并做出判断
     * 使用 ReasoningEngine + PatternDetector + SelfAssessor 协同推理
     *
     * @param {object|string} situation - 需要分析的情境
     * @param {object} [options]
     * @returns {object} { analysis, decision, confidence, reasoning }
     */
    async think(situation, options = {}) {
        if (!this._initialized) await this.init();

        this.stats.totalThoughts++;
        this.stats.lastThinkTime = new Date().toISOString();
        const startTime = Date.now();

        // 1. 解析输入情境
        const parsed = this._parseSituation(situation);

        // 2. 构建推理上下文
        const recentExperiences = this.experienceDB.getRecent(30);
        const similarExperiences = this._retrieveSimilar(parsed);
        const matchedPatterns = this.patternDetector.matchSituation(situation);
        const conceptMatches = this.conceptBuilder.matchExperience(parsed);

        const reasoningContext = {
            recentHistory: recentExperiences,
            similarExperiences,
            matchedPatterns,
            currentState: options.state || this._getCurrentDeviceState(),
            carrierProfile: this.carrierProfile.getProfile(),
            experienceCount: this.experienceDB.getStats().totalExperiences,
            domain: options.domain || 'general'
        };

        // 3. ReasoningEngine 执行多模式推理
        const reasoning = await this.reasoningEngine.reason(situation, reasoningContext);

        // 4. SelfAssessor 评估自信度
        const selfAssessment = this.selfAssessor.assessDecision(
            { action: reasoning.conclusion, domain: options.domain || 'general', confidence: reasoning.confidence },
            reasoningContext
        );

        // 5. 检索策略（来自画像和经验）
        const relevantStrategies = this._retrieveStrategies(parsed);

        // 6. 生成最终决策
        const finalDecision = this._generateDecision(
            reasoning,
            relevantStrategies,
            selfAssessment
        );

        const elapsed = Date.now() - startTime;

        // 7. 记录思考经验
        await this.experienceDB.record('cognitive_thought', {
            input: parsed.summary,
            reasoningMethod: reasoning.method,
            conclusion: reasoning.conclusion,
            decision: finalDecision.action,
            confidence: selfAssessment.confidence,
            conceptMatches: conceptMatches.length
        }, { source: 'cognitive_framework' });

        return {
            analysis: {
                conclusion: reasoning.conclusion,
                reasoningMethod: reasoning.method,
                reasoningChain: reasoning.reasoning,
                keyFactors: [
                    { name: '推理方式', value: reasoning.method, significance: 'high' },
                    { name: '相似经验', value: similarExperiences.length, significance: 'medium' },
                    { name: '匹配模式', value: matchedPatterns.length, significance: 'medium' },
                    { name: '匹配概念', value: conceptMatches.length, significance: 'low' }
                ],
                patterns: matchedPatterns.map(p => ({ pattern: p.description, relevance: p.relevance })),
                similarCount: similarExperiences.length
            },
            decision: {
                action: finalDecision.action,
                alternatives: finalDecision.alternatives,
                reasoning: reasoning.reasoning,
                confidence: selfAssessment.confidence
            },
            confidence: selfAssessment.confidence,
            selfAssessment: {
                confidenceFactors: selfAssessment.factors,
                calibrationInfo: {
                    overallAccuracy: this.stats.totalThoughts > 0 ?
                        (this.selfAssessor.stats.correctDecisions / Math.max(1, this.selfAssessor.stats.totalDecisions)) : 0
                }
            },
            metadata: {
                elapsed,
                experienceCount: this.experienceDB.getStats().totalExperiences,
                evolutionStage: this.carrierProfile.profile.cognition.evolutionStage,
                conceptCount: this.conceptBuilder.getStats().totalConcepts,
                patternCount: this.patternDetector.getStats().totalPatterns
            }
        };
    }

    /**
     * 记录经验并触发认知更新
     */
    async learn(type, data, context = {}) {
        const id = await this.experienceDB.record(type, data, context);

        if (type === 'user_interaction') {
            await this.carrierProfile.recordInteraction(data);
        } else if (type === 'tool_execution') {
            await this.carrierProfile.recordToolExecution(
                context.toolName || 'unknown',
                data
            );

            if (data && data.success !== undefined) {
                this.selfAssessor.recordOutcome(
                    { action: context.toolName, domain: 'tool_execution', confidence: context.confidence || 0.5 },
                    { success: data.success, error: data.error, elapsed: data.elapsed }
                );
            }
        }

        const stats = this.experienceDB.getStats();
        this.carrierProfile.updateExperienceCount(stats.totalExperiences);
        this.stats.totalAbsorbed++;

        // 通知进化引擎有新经验
        this.selfEvolver.notifyNewExperience();

        // 如果工具执行失败，送反馈处理器分析
        if (type === 'tool_execution' && data && data.success === false) {
            this.feedbackProcessor.process({
                context: context?.toolName || data.tool || 'unknown',
                action: data.tool || 'unknown',
                result: { success: false, error: data.error || 'unknown_error' },
                domain: context?.domain || 'tool_execution',
                timestamp: new Date().toISOString()
            });
        }

        // 每 N 条经验触发一次轻量认知更新
        if (this.stats.totalAbsorbed % 5 === 0) {
            this._lightweightCognitionUpdate();
        }

        return id;
    }

    integrate(components = {}) {
        if (components.deviceManager) this.deviceManager = components.deviceManager;
        if (components.toolExecutor) this.toolExecutor = components.toolExecutor;
        if (components.memoryManager) this.memoryManager = components.memoryManager;
        if (components.llmAdapter) this.llmAdapter = components.llmAdapter;

        this._log(`Integrated: ${Object.keys(components).join(', ')}`);
    }

    getStatus() {
        const dbStats = this.experienceDB.getStats();
        const profileSummary = this.carrierProfile.getSummary();

        return {
            version: this.version,
            active: this._active,
            initialized: this._initialized,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
            experiences: {
                total: dbStats.totalExperiences,
                inMemory: dbStats.inMemory,
                archived: dbStats.archivedExperiences,
                types: dbStats.types
            },
            carrier: profileSummary,
            cognition: {
                stage: this.carrierProfile.profile.cognition.evolutionStage,
                capabilities: this.carrierProfile.profile.cognition.capabilities,
                totalEvolutions: this.stats.totalEvolutions,
                totalThoughts: this.stats.totalThoughts,
                totalAbsorbed: this.stats.totalAbsorbed
            },
            engines: {
                reasoning: this.reasoningEngine.getStats(),
                patternDetector: this.patternDetector.getStats(),
                conceptBuilder: this.conceptBuilder.getStats(),
                selfAssessor: this.selfAssessor.getStats()
            },
            knowledge: {
                graph: this.knowledgeGraph.getStats(),
                patternLibrary: this.patternLibrary.getStats(),
                strategyLibrary: this.strategyLibrary.getStats(),
                discovery: this.selfDiscovery.getStats()
            },
            evolution: {
                selfEvolver: this.selfEvolver.getStatus(),
                feedbackProcessor: this.feedbackProcessor.getStats(),
                modelEvaluator: this.modelEvaluator.getStats()
            },
            stats: {
                lastThinkTime: this.stats.lastThinkTime,
                lastEvolveTime: this.stats.lastEvolveTime
            }
        };
    }

    // 内部循环

    async _absorbCycle() {
        if (!this._active) return;

        if (this.deviceManager) {
            try {
                const report = this.deviceManager.getFullReport ?
                    this.deviceManager.getFullReport() :
                    this.deviceManager.getDeviceStats ?
                        this.deviceManager.getDeviceStats() : null;

                if (report) {
                    const stateStr = JSON.stringify(report);
                    const stateHash = this._simpleHash(stateStr);

                    // 仅在状态变化时记录
                    if (stateHash !== this._lastStateHash) {
                        this._lastStateHash = stateHash;

                        await this.experienceDB.record('state_snapshot', report, {
                            source: 'device_manager'
                        });

                        await this.carrierProfile.updateState(report);
                    }
                }
            } catch (e) {
                if (this._debug) console.warn('[CognitiveFramework] DeviceManager absorb error:', e.message);
            }
        }

        if (this.memoryManager) {
            try {
                // 扫描 L1 层的新记忆作为经验
                for (const level of ['L0', 'L1', 'L2']) {
                    const layer = this.memoryManager.layers?.[level];
                    if (!layer) continue;

                    for (const [id, item] of layer) {
                        if (this._absorbedMemories?.has(id)) continue;
                        if (!this._absorbedMemories) this._absorbedMemories = new Set();
                        this._absorbedMemories.add(id);

                        const content = typeof item.content === 'string' ?
                            item.content : JSON.stringify(item.content);

                        await this.experienceDB.record('memory_observation', {
                            memoryId: id,
                            level,
                            content: content.substring(0, 500),
                            tags: item.tags || []
                        }, { source: 'memory_manager' });
                    }
                }
            } catch (e) {
                if (this._debug) console.warn('[CognitiveFramework] Memory absorb error:', e.message);
            }
        }

        if (this.stats.totalAbsorbed % 5 === 0) {
            await this.experienceDB.persist();
        }
    }

    async _thinkCycle() {
        if (!this._active) return;

        const recentExperiences = this.experienceDB.getRecent(50);
        if (recentExperiences.length < 5) return;

        // 分析这段时间的变化趋势
        const stateExperiences = recentExperiences.filter(e => e.type === 'state_snapshot');
        if (stateExperiences.length > 5) {
            // 触发统计进化（每10次思考循环一次完整进化）
            if (this.stats.totalThoughts % 10 === 0) {
                await this.evolve();
            }
        }
    }

    // Phase 3: 自建知识体接口

    /**
     * 执行承载体自发现并导入知识图谱
     * 这是系统了解自身承载体的第一步
     */
    async discoverCarrier(options = {}) {
        this._log('开始承载体自发现...');

        // 1. 执行全面扫描
        const inventory = await this.selfDiscovery.discoverAll(options);

        this._log(`自发现结果: ${inventory.summary.totalItems}项`);

        // 2. 导入到知识图谱
        const importResult = this.knowledgeGraph.importFromDiscovery(inventory);

        // 3. 记录为初始经验
        await this.experienceDB.record('carrier_discovery', {
            carrierType: inventory.carrierType,
            totalItems: inventory.summary.totalItems,
            cpu: inventory.hardware?.cpu?.model,
            memory: inventory.hardware?.memory?.totalGB,
            os: inventory.system?.platform,
            softwareCount: inventory.summary.softwareCount,
            runtimeCount: inventory.summary.runtimeCount
        }, { source: 'carrier_discovery', importance: 1.0 });

        // 4. 更新承载体画像
        this.carrierProfile.recordEvolution({
            type: 'carrier_discovery',
            itemsFound: inventory.summary.totalItems,
            entitiesCreated: importResult.entities,
            relationshipsCreated: importResult.relationships
        });

        this._log(`承载体自发现完成: ${importResult.entities}实体, ${importResult.relationships}关系`);

        return {
            inventory: inventory.summary,
            knowledgeGraph: importResult
        };
    }

    /**
     * 从经验中提取策略并存入策略库
     */
    async learnStrategies(experiences) {
        if (!experiences || experiences.length < 2) return { learned: 0 };

        let learned = 0;

        // 从工具执行经验中学习策略
        const toolExecutions = experiences.filter(e => e.type === 'tool_execution' && e.data);
        for (const exp of toolExecutions) {
            if (exp.data && exp.data.success !== undefined) {
                const context = exp.context?.toolName || exp.data.tool || 'unknown';
                const action = context;
                const success = exp.data.success === true;

                this.strategyLibrary.learnFromExecution(context, action, success, {
                    tool: exp.data.tool,
                    elapsed: exp.data.elapsed,
                    error: exp.data.error
                });
                learned++;
            }
        }

        // 从用户交互经验中学习
        const interactions = experiences.filter(e => e.type === 'user_interaction' && e.data);
        for (const exp of interactions) {
            const context = `user_${exp.data?.type || 'interaction'}`;
            this.strategyLibrary.learnFromExecution(context, 'respond', true, {
                type: exp.data?.type
            });
            learned++;
        }

        return { learned };
    }

    /**
     * 将 PatternDetector 检测到的可靠模式导入 PatternLibrary
     */
    async consolidatePatterns() {
        const detectorPatterns = this.patternDetector.getAllPatterns();
        const allPatterns = [
            ...detectorPatterns.temporal,
            ...detectorPatterns.correlational,
            ...detectorPatterns.sequential,
            ...detectorPatterns.anomaly
        ];

        if (allPatterns.length === 0) return { consolidated: 0 };

        const added = this.patternLibrary.registerFromDetector({
            temporal: detectorPatterns.temporal,
            correlational: detectorPatterns.correlational,
            sequential: detectorPatterns.sequential,
            anomaly: detectorPatterns.anomaly
        });

        return { consolidated: added, total: this.patternLibrary.getStats().totalPatterns };
    }

    /**
     * 更新进化流程（含知识图谱+模式库+策略库）
     */
    async evolve() {
        this.stats.totalEvolutions++;

        const recentExperiences = this.experienceDB.getRecent(100);
        const importantExperiences = this.experienceDB.getImportantExperiences(30);

        // 1. PatternDetector 检测
        const patterns = this.patternDetector.detectAll(recentExperiences);

        // 2. ConceptBuilder 构建概念
        const concepts = this.conceptBuilder.buildFromExperiences(recentExperiences);

        // 3. 将可靠模式导入 PatternLibrary
        const patternConsolidation = await this.consolidatePatterns();

        // 4. 从经验中学习策略
        const strategyLearning = await this.learnStrategies(recentExperiences);

        // 5. 将模式作为经验记录
        for (const p of patterns.temporal.slice(0, 5)) {
            await this.experienceDB.record('detected_pattern', p, { source: 'pattern_detector' });
        }

        // 6. 更新承载体画像
        this.carrierProfile.recordEvolution({
            type: 'evolution',
            temporalPatterns: patterns.temporal.length,
            correlationalPatterns: patterns.correlational.length,
            sequentialPatterns: patterns.sequential.length,
            anomalyPatterns: patterns.anomaly.length,
            newConcepts: concepts.changes.created,
            patternsConsolidated: patternConsolidation.consolidated,
            strategiesLearned: strategyLearning.learned
        });

        // 7. 获取自我评估报告
        const assessmentReport = this.selfAssessor.getReport();

        // 8. 持久化所有知识体
        await this.experienceDB.persist();
        await this.carrierProfile.save();
        this.knowledgeGraph.persist();
        this.patternLibrary.persist();
        this.strategyLibrary.persist();

        this._log(`进化完成: ${patterns.temporal.length}T+${patterns.correlational.length}C+${patterns.sequential.length}S+${patterns.anomaly.length}A模式, ${concepts.changes.created}概念, ${patternConsolidation.consolidated}入库, ${strategyLearning.learned}策略`);

        return {
            evolved: true,
            patterns: {
                temporal: patterns.temporal.length,
                correlational: patterns.correlational.length,
                sequential: patterns.sequential.length,
                anomaly: patterns.anomaly.length
            },
            concepts: concepts.changes,
            patternLibrary: patternConsolidation,
            strategyLibrary: strategyLearning,
            knowledgeGraph: this.knowledgeGraph.getStats(),
            selfAssessment: {
                accuracy: assessmentReport.overall.overallAccuracy,
                knowledgeGaps: assessmentReport.knowledgeGaps.slice(0, 5)
            },
            totalExperiences: this.experienceDB.getStats().totalExperiences
        };
    }

    // 认知处理

    _parseSituation(situation) {
        if (typeof situation === 'string') {
            return { raw: situation, summary: situation.substring(0, 200), type: 'text' };
        }
        if (typeof situation === 'object') {
            return {
                raw: situation,
                summary: JSON.stringify(situation).substring(0, 200),
                type: situation.type || 'object',
                keyFields: Object.keys(situation).filter(k =>
                    typeof situation[k] !== 'object' && typeof situation[k] !== 'function'
                )
            };
        }
        return { raw: situation, summary: String(situation), type: 'unknown' };
    }

    _retrieveSimilar(parsed) {
        const keyword = parsed.summary.substring(0, 30);
        const results = this.experienceDB.search(keyword, { limit: 10 });
        return results.slice(0, 5);
    }

    _retrieveStrategies(parsed) {
        const strategies = [];

        const sp = this.carrierProfile.profile.stateProfile;
        if (sp.cpuTypical.avg > 70) {
            strategies.push({
                type: 'system_health',
                suggestion: 'CPU负载较高，建议减少并发任务',
                priority: sp.cpuTypical.avg > 90 ? 'high' : 'medium'
            });
        }
        if (sp.memoryTypical.avg > 80) {
            strategies.push({
                type: 'system_health',
                suggestion: '内存使用率偏高，建议检查内存泄漏',
                priority: 'medium'
            });
        }

        const currentHour = new Date().getHours();
        if (this.carrierProfile.profile.behavior.peakLoadTimes.includes(currentHour)) {
            strategies.push({
                type: 'timing',
                suggestion: '当前为承载体活跃时段，应优先处理用户请求',
                priority: 'medium'
            });
        }

        return strategies;
    }

    _generateDecision(reasoning, strategies, selfAssessment) {
        const alternatives = strategies.map(s => ({
            action: s.suggestion,
            priority: s.priority,
            reasoning: `基于${s.type}策略`
        }));

        // 根据推理引擎的自信度结合自我评估选择方案
        const highPriority = alternatives.find(a => a.priority === 'high');
        const selected = highPriority || alternatives[0] || null;

        // 如果自信度很低，给出谨慎建议
        let action = selected ? selected.action : reasoning.conclusion;
        if (selfAssessment.confidence < 0.3) {
            action = `建议谨慎: ${action}（自信度较低，建议验证后执行）`;
        }

        return {
            action,
            alternatives: alternatives.length > 0 ? alternatives : [reasoning.conclusion],
            reasoning: selected ? selected.reasoning : (reasoning.reasoning || ['基于推理引擎分析'])
        };
    }

    _lightweightCognitionUpdate() {
        try {
            const recent = this.experienceDB.getRecent(50);
            if (recent.length >= 5) {
                const patterns = this.patternDetector.detectAll(recent);
                const concepts = this.conceptBuilder.buildFromExperiences(recent);

                if (patterns.temporal.length + patterns.correlational.length > 0) {
                    this.carrierProfile.recordEvolution({
                        type: 'lightweight_update',
                        patterns: patterns.temporal.length + patterns.correlational.length,
                        concepts: concepts.changes.created
                    });
                }
            }
        } catch (e) {
            if (this._debug) console.warn('[CognitiveFramework] Lightweight cognition update error:', e.message);
        }
    }

    _getCurrentDeviceState() {
        try {
            if (this.deviceManager) {
                return this.deviceManager.getFullReport ?
                    this.deviceManager.getFullReport() :
                    this.deviceManager.getDeviceStats ?
                        this.deviceManager.getDeviceStats() : {};
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        return {};
    }

    _simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }

    _log(msg) {
        console.log(`[CognitiveFramework] ${msg}`);
    }
}

module.exports = CognitiveFramework;
