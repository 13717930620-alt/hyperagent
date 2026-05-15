// SelfEvolver — 自我进化引擎

class SelfEvolver {
    constructor(options = {}) {
        this.debug = options.debug || false;

        this.engines = {
            experienceDB: null,
            carrierProfile: null,
            patternDetector: null,
            conceptBuilder: null,
            reasoningEngine: null,
            selfAssessor: null,
            knowledgeGraph: null,
            patternLibrary: null,
            strategyLibrary: null,
            feedbackProcessor: null,
            modelEvaluator: null
        };

        this.thresholds = {
            micro: options.microThreshold || 1,          // 每条经验
            minor: options.minorThreshold || 50,         // 每50条
            major: options.majorThreshold || 500,        // 每500条
            full: options.fullThreshold || 5000          // 每5000条
        };

        this.intervals = {
            minor: options.minorInterval || 300000,      // 5分钟
            major: options.majorInterval || 3600000,     // 1小时
            full: options.fullInterval || 86400000       // 24小时
        };

        this._state = {
            running: false,
            currentLevel: null,
            lastEvolution: {
                micro: null,
                minor: null,
                major: null,
                full: null
            },
            experiencesSinceLastEvolve: 0,
            totalEvolutions: 0
        };

        this._evolutionHistory = [];

        this._timers = {
            minor: null,
            major: null,
            full: null
        };

        this._evolving = false;

        this.stats = {
            totalEvolutions: 0,
            microCount: 0,
            minorCount: 0,
            majorCount: 0,
            fullCount: 0,
            totalDuration: 0,
            avgDuration: 0,
            lastEvolutionTime: null,
            evolutionTrend: []
        };
    }

    // 生命周期

    inject(engineRefs) {
        Object.assign(this.engines, engineRefs);
    }

    start() {
        if (this._state.running) return;
        this._state.running = true;

        // 启动定时进化
        this._timers.minor = setInterval(() => {
            this.tryEvolve('minor', { trigger: 'timer' }).catch(e => console.warn(`[cognitive_core] Caught: ${e.message}`));
        }, this.intervals.minor);

        this._timers.major = setInterval(() => {
            this.tryEvolve('major', { trigger: 'timer' }).catch(e => console.warn(`[cognitive_core] Caught: ${e.message}`));
        }, this.intervals.major);

        this._timers.full = setInterval(() => {
            this.tryEvolve('full', { trigger: 'timer' }).catch(e => console.warn(`[cognitive_core] Caught: ${e.message}`));
        }, this.intervals.full);

        if (this.debug) {
            console.log(`[SelfEvolver] 进化循环已启动 (minor=${this.intervals.minor/60000}min, major=${this.intervals.major/3600000}h, full=${this.intervals.full/86400000}d)`);
        }

        return true;
    }

    stop() {
        this._state.running = false;
        for (const timer of Object.values(this._timers)) {
            if (timer) clearInterval(timer);
        }
        this._timers = { minor: null, major: null, full: null };
        return true;
    }

    notifyNewExperience() {
        this._state.experiencesSinceLastEvolve++;
    }

    /**
     * 尝试进化——根据积累量自动选择进化级别
     * @param {string} [forceLevel] - 强制指定级别
     * @param {object} [options]
     * @returns {object|null}
     */
    async tryEvolve(forceLevel = null, options = {}) {
        if (this._evolving) return null;
        this._evolving = true;

        try {
            const level = forceLevel || this._determineEvolutionLevel();

            if (!level) {
                this._evolving = false;
                return null;
            }

            const result = await this._executeEvolution(level, options);
            return result;
        } catch (e) {
            console.error('[SelfEvolver] 进化异常:', e.message);
            return null;
        } finally {
            this._evolving = false;
        }
    }

    // 进化执行

    async _executeEvolution(level, options = {}) {
        const startTime = Date.now();
        const trigger = options.trigger || 'auto';

        this._state.currentLevel = level;
        this._state.totalEvolutions++;

        if (this.debug) {
            console.log(`[SelfEvolver] 开始${level}进化 (触发: ${trigger})`);
        }

        let result = { level, trigger, actions: [], duration: 0 };

        switch (level) {
            case 'micro':
                result = await this._microEvolution(result);
                break;
            case 'minor':
                result = await this._minorEvolution(result);
                break;
            case 'major':
                result = await this._majorEvolution(result);
                break;
            case 'full':
                result = await this._fullEvolution(result);
                break;
        }

        result.duration = Date.now() - startTime;
        result.timestamp = new Date().toISOString();
        result.experiencesAtTime = this.engines.experienceDB?.getStats().totalExperiences || 0;

        // 更新状态
        this._state.lastEvolution[level] = result.timestamp;
        this._state.experiencesSinceLastEvolve = 0;

        // 更新统计
        this.stats.totalEvolutions++;
        this.stats[`${level}Count`]++;
        this.stats.totalDuration += result.duration;
        this.stats.avgDuration = this.stats.totalDuration / this.stats.totalEvolutions;
        this.stats.lastEvolutionTime = result.timestamp;

        // 记录历史
        this._evolutionHistory.push(result);
        if (this._evolutionHistory.length > 100) {
            this._evolutionHistory = this._evolutionHistory.slice(-100);
        }

        // 更新承载体画像
        if (this.engines.carrierProfile) {
            this.engines.carrierProfile.recordEvolution({
                type: `${level}_evolution`,
                trigger,
                duration: result.duration,
                actions: result.actions.length
            });
        }

        if (this.debug) {
            console.log(`[SelfEvolver] ${level}进化完成 (${result.duration}ms, ${result.actions.length}项操作)`);
        }

        return result;
    }

    /**
     * L1 微进化：实时更新权重和统计
     */
    async _microEvolution(result) {
        result.actions.push('update_experience_stats');

        // 统计最近经验的成功/失败比
        const db = this.engines.experienceDB;
        if (db) {
            const recent = db.getRecent(50);
            const successCount = recent.filter(e =>
                e.outcome?.success === true || e.data?.success === true
            ).length;
            const failCount = recent.filter(e =>
                e.outcome?.success === false || e.data?.success === false
            ).length;
            const totalOps = successCount + failCount;
            if (totalOps > 0) {
                const successRate = successCount / totalOps;
                result.actions.push(`success_rate=${(successRate * 100).toFixed(0)}%`);

                // 如果成功率低于40%，触发预警
                if (successRate < 0.4) {
                    result.actions.push('low_success_rate_warning');
                }
            }
        }

        this._state.experiencesSinceLastEvolve++;

        // 记录进化趋势
        this.stats.evolutionTrend.push({
            time: new Date().toISOString(),
            level: 'micro',
            totalEvolutions: this.stats.totalEvolutions,
            experiencesSinceLastEvolve: this._state.experiencesSinceLastEvolve
        });
        if (this.stats.evolutionTrend.length > 100) {
            this.stats.evolutionTrend = this.stats.evolutionTrend.slice(-100);
        }

        this.stats.microCount++;
        return result;
    }

    /**
     * L2 小进化：模式检测 + 策略更新
     */
    async _minorEvolution(result) {
        const db = this.engines.experienceDB;

        if (db) {
            const recent = db.getRecent(100);

            // 模式检测
            if (this.engines.patternDetector && recent.length > 10) {
                const patterns = this.engines.patternDetector.detectAll(recent);
                result.actions.push(`pattern_detection(${Object.values(patterns).reduce((s, p) => s + p.length, 0)}模式)`);

                // 导入模式库
                if (this.engines.patternLibrary) {
                    const added = this.engines.patternLibrary.registerFromDetector(patterns);
                    if (added > 0) result.actions.push(`pattern_library(+${added})`);
                }
            }

            // 简单策略学习
            if (this.engines.strategyLibrary) {
                const toolExps = recent.filter(e => e.type === 'tool_execution' && e.data);
                let learned = 0;
                for (const exp of toolExps) {
                    if (exp.data && exp.data.success !== undefined) {
                        this.engines.strategyLibrary.learnFromExecution(
                            exp.context?.toolName || exp.data.tool || 'unknown',
                            exp.data.tool || 'action',
                            exp.data.success === true,
                            { elapsed: exp.data.elapsed, error: exp.data.error }
                        );
                        learned++;
                    }
                }
                if (learned > 0) result.actions.push(`strategy_learning(+${learned})`);
            }
        }

        // 更新画像
        if (this.engines.carrierProfile && db) {
            this.engines.carrierProfile.updateExperienceCount(db.getStats().totalExperiences);
        }

        // 概念轻量更新
        if (this.engines.conceptBuilder && db) {
            const recent = db.getRecent(50);
            if (recent.length >= 10) {
                const concepts = this.engines.conceptBuilder.buildFromExperiences(recent);
                if (concepts.changes.created > 0) {
                    result.actions.push(`concept_building(+${concepts.changes.created})`);
                }
            }
        }

        this.stats.minorCount++;
        return result;
    }

    /**
     * L3 中进化：概念重构 + 知识图谱扩展 + 深度策略优化
     */
    async _majorEvolution(result) {
        const db = this.engines.experienceDB;

        // 先执行小进化的所有操作
        const minorResult = await this._minorEvolution({ level: 'minor', trigger: 'major_inner', actions: [] });
        result.actions.push(...minorResult.actions);

        if (db) {
            const recent = db.getRecent(200);
            const important = db.getImportantExperiences(30, 0.3);

            // 深度概念构建
            if (this.engines.conceptBuilder) {
                const concepts = this.engines.conceptBuilder.buildFromExperiences(recent);
                if (concepts.changes.abstracted > 0) {
                    result.actions.push(`concept_abstraction(${concepts.changes.abstracted})`);
                }
            }

            // 知识图谱优化（清理弱关系）
            if (this.engines.knowledgeGraph) {
                const kgStats = this.engines.knowledgeGraph.getStats();
                result.actions.push(`kg_entities(${kgStats.totalEntities})`);
            }

            // 策略库深度优化
            if (this.engines.strategyLibrary) {
                // 从重要经验中提取策略
                for (const exp of important) {
                    if (exp.type === 'tool_execution' && exp.data) {
                        this.engines.strategyLibrary.learnFromExecution(
                            exp.context?.toolName || exp.data.tool || 'unknown',
                            exp.data.tool || 'action',
                            exp.data.success === true,
                            { elapsed: exp.data.elapsed, importance: exp.importance }
                        );
                    }
                }
                result.actions.push('strategy_deep_learning');
            }

            // 反馈处理
            if (this.engines.feedbackProcessor) {
                const failedExps = recent.filter(e =>
                    (e.type === 'tool_execution' && e.data?.success === false) ||
                    (e.outcome && e.outcome.success === false)
                );
                if (failedExps.length > 0) {
                    const feedbackResult = await this.engines.feedbackProcessor.processBatch(failedExps);
                    if (feedbackResult.lessons > 0) {
                        result.actions.push(`feedback_processing(${feedbackResult.lessons}教训)`);
                    }
                }
            }
        }

        // 模型自评估
        if (this.engines.modelEvaluator) {
            const evalResult = this.engines.modelEvaluator.evaluateAll();
            if (evalResult) {
                result.actions.push(`model_evaluation(健康分:${evalResult.healthScore})`);
                result.evaluation = evalResult;
            }
        }

        // 持久化
        await this._persistAll();

        this.stats.majorCount++;
        return result;
    }

    /**
     * L4 大进化：全面认知重构 + 系统自评估 + 知识重组 + 阈值自适应
     */
    async _fullEvolution(result) {
        // 先执行中进化的所有操作
        const majorResult = await this._majorEvolution({ level: 'major', trigger: 'full_inner', actions: [] });
        result.actions.push(...majorResult.actions);

        const db = this.engines.experienceDB;

        if (db) {
            // 全面自评估
            if (this.engines.modelEvaluator) {
                const fullEval = this.engines.modelEvaluator.evaluateAll(true);
                result.actions.push(`full_evaluation`);

                // 根据评估结果生成进化建议
                const suggestions = this.engines.modelEvaluator.getSuggestions();
                if (suggestions.length > 0) {
                    result.actions.push(...suggestions.map(s => `建议:${s}`));
                }
                result.evaluation = fullEval;
            }

            // 认知进化阶段升级检查
            if (this.engines.carrierProfile) {
                const totalExps = db.getStats().totalExperiences;
                this.engines.carrierProfile.updateExperienceCount(totalExps);
                const stage = this.engines.carrierProfile.profile.cognition.evolutionStage;
                result.actions.push(`evolution_stage:${stage}`);
            }
        }

        // ===== 自适应阈值调整 =====
        const historyLen = this._evolutionHistory.length;
        if (historyLen >= 5) {
            // 分析最近5次进化的平均持续时间
            const recentEvolutions = this._evolutionHistory.slice(-5);
            const avgDuration = recentEvolutions.reduce((sum, e) => sum + (e.duration || 0), 0) / recentEvolutions.length;

            // 如果进化耗时很短(<100ms)，说明进化内容太少，应降低触发门槛
            if (avgDuration < 100 && this.intervals.minor > 120000) {
                const oldInterval = this.intervals.minor;
                this.intervals.minor = Math.max(60000, Math.floor(this.intervals.minor * 0.8));
                result.actions.push(`auto_tune: minor interval ${oldInterval/60000}min→${this.intervals.minor/60000}min`);
            }

            // 如果进化耗时很长(>5000ms)，说明内容太多，应提高触发门槛
            if (avgDuration > 5000 && this.thresholds.minor < 100) {
                this.thresholds.minor = Math.min(200, this.thresholds.minor + 20);
                result.actions.push(`auto_tune: minor threshold ${this.thresholds.minor - 20}→${this.thresholds.minor}`);
            }

            // 根据最近进化结果调整 full 阈值
            const recentFullEvolutions = this._evolutionHistory.filter(e => e.level === 'full');
            if (recentFullEvolutions.length >= 2) {
                const lastFull = recentFullEvolutions[recentFullEvolutions.length - 1];
                const prevFull = recentFullEvolutions[recentFullEvolutions.length - 2];

                // 如果 full 进化产出越来越少，拉长间隔
                if (lastFull && prevFull && lastFull.actions && prevFull.actions) {
                    if (lastFull.actions.length < prevFull.actions.length * 0.5) {
                        this.intervals.full = Math.min(172800000, Math.floor(this.intervals.full * 1.2));
                        result.actions.push(`auto_tune: full interval extended (diminishing returns)`);
                    }
                }
            }
        }

        // 全量持久化
        await this._persistAll();

        // 记录进化趋势
        this.stats.evolutionTrend.push({
            time: new Date().toISOString(),
            level: 'full',
            totalExperiences: db?.getStats().totalExperiences || 0,
            healthScore: result.evaluation?.healthScore || 0,
            duration: result.duration || 0
        });
        if (this.stats.evolutionTrend.length > 50) {
            this.stats.evolutionTrend = this.stats.evolutionTrend.slice(-50);
        }

        this.stats.fullCount++;
        return result;
    }

    // 辅助方法

    _determineEvolutionLevel() {
        const count = this._state.experiencesSinceLastEvolve;
        const now = Date.now();

        // 检查是否需要全进化
        const lastFull = this._state.lastEvolution.full ?
            new Date(this._state.lastEvolution.full).getTime() : 0;
        if (count >= this.thresholds.full || (lastFull > 0 && now - lastFull >= this.intervals.full)) {
            return 'full';
        }

        // 检查是否需要中进化
        const lastMajor = this._state.lastEvolution.major ?
            new Date(this._state.lastEvolution.major).getTime() : 0;
        if (count >= this.thresholds.major || (lastMajor > 0 && now - lastMajor >= this.intervals.major)) {
            return 'major';
        }

        // 检查是否需要小进化
        const lastMinor = this._state.lastEvolution.minor ?
            new Date(this._state.lastEvolution.minor).getTime() : 0;
        if (count >= this.thresholds.minor || (lastMinor > 0 && now - lastMinor >= this.intervals.minor)) {
            return 'minor';
        }

        // 总是执行微进化
        if (count >= this.thresholds.micro) {
            return 'micro';
        }

        return null;
    }

    async _persistAll() {
        try {
            if (this.engines.experienceDB) await this.engines.experienceDB.persist();
            if (this.engines.carrierProfile) await this.engines.carrierProfile.save();
            if (this.engines.knowledgeGraph) this.engines.knowledgeGraph.persist();
            if (this.engines.patternLibrary) this.engines.patternLibrary.persist();
            if (this.engines.strategyLibrary) this.engines.strategyLibrary.persist();
        } catch (e) {
            console.error('[SelfEvolver] Persist error:', e.message);
        }
    }

    getEvolutionHistory(n = 20) {
        return this._evolutionHistory.slice(-n);
    }

    getLastEvolution() {
        return this._evolutionHistory[this._evolutionHistory.length - 1] || null;
    }

    getStatus() {
        return {
            running: this._state.running,
            currentLevel: this._state.currentLevel,
            experiencesSinceLastEvolve: this._state.experiencesSinceLastEvolve,
            totalEvolutions: this._state.totalEvolutions,
            lastEvolution: this._state.lastEvolution,
            stats: this.stats,
            thresholds: this.thresholds
        };
    }

    getStats() {
        return this.stats;
    }
}

module.exports = SelfEvolver;
