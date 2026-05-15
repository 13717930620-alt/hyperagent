// ConversationEngine - conversation engine

class ConversationEngine {
    constructor(llmAdapter, contextManager) {
        this.llm = llmAdapter;
        this.contextManager = contextManager;
        this.memoryPipeline = null;      // 由外部注入
        this.permissionSystem = null;    // 由外部注入
        this.deviceManager = null;       // 由外部注入

        // New interaction modules
        this.messagePool = null;
        this.adversarialVerifier = null;
        this.personaInjection = null;
        this.groupChatManager = null;

        this.computerControlEnabled = true;
        this.toolCatalog = [];

        // ============================================
        // Conversation state machine
        // ============================================
        this.state = {
            // 对话元信息
            turnCount: 0,
            sessionStartTime: Date.now(),
            language: 'auto',              // 自动检测

            // 意图历史
            intentHistory: [],             // 最近5轮意图

            // 活跃任务追踪
            activeTask: null,              // 当前进行中的任务
            activeTaskGoal: null,
            activeTaskSteps: [],           // 已完成步骤
            activeTaskProgress: null,      // "2/5" 等进度

            // 对话阶段
            phase: 'greeting',             // greeting | chatting | executing | waiting_confirm | closing

            // 用户画像（会话内积累）
            userProfile: {
                communicationStyle: null,  // concise | detailed | technical
                commonTopics: [],
                knownPreferences: {}
            },

            // 防重复
            lastResponseHash: null,
            responseCount: 0
        };
    }

    // ============================================
    // Dependency injection
    // ============================================

    setMemoryPipeline(mp) { this.memoryPipeline = mp; }
    setPermissionSystem(ps) { this.permissionSystem = ps; }
    setDeviceManager(dm) { this.deviceManager = dm; }

    setMessagePool(mp) { this.messagePool = mp; }
    setAdversarialVerifier(av) { this.adversarialVerifier = av; }
    setPersonaInjection(pi) { this.personaInjection = pi; }
    setGroupChatManager(gcm) { this.groupChatManager = gcm; }

    setComputerControlEnabled(enabled, tools = []) {
        this.computerControlEnabled = enabled;
        if (enabled && tools.length > 0) {
            this.toolCatalog = tools;
        }
    }

    // ============================================
    // Main entry
    // ============================================

    async processMessage(userMessage, options = {}) {
        this.state.turnCount++;
        this.state.phase = 'chatting';

        // ============================================
        // Phase 1: Three-layer intent analysis
        // ============================================
        const analysis = await this._analyzeIntent(userMessage);

        // 记录意图历史
        this.state.intentHistory.push(analysis.intent);
        if (this.state.intentHistory.length > 5) this.state.intentHistory.shift();

        // Publish user message to message pool
        if (this.messagePool) {
            this.messagePool.publish('user', {
                type: analysis.intent || 'message',
                content: userMessage,
                role: 'user',
                metadata: { complexity: analysis.complexity, turn: this.state.turnCount }
            });
        }

        // ============================================
        // Phase 2: Strategy decision
        // ============================================
        const strategy = this._decideStrategy(analysis, userMessage);

        // ============================================
        // Phase 3: Memory enhancement
        // ============================================
        let memoryContext = null;
        if (this.memoryPipeline && analysis.intent !== 'chat') {
            try {
                const ctx = await this.memoryPipeline.buildContext(userMessage, {
                    topK: 5,
                    threshold: 0.4
                });
                if (ctx.hasContext) memoryContext = ctx;
            } catch (e) {
                // 记忆检索失败不阻断对话
            }
        }

        // ============================================
        // Phase 4: Build system context
        // ============================================
        const systemContext = this._buildSystemContext(analysis, memoryContext);

        let finalSystemContext = systemContext;
        if (this.personaInjection && options.persona) {
            const personaPrompt = this.personaInjection.generatePersonaPrompt(
                options.persona.role || 'assistant',
                options.persona.task || userMessage,
                options.persona.traits || {}
            );
            finalSystemContext = this.personaInjection.applyPersonaToSystemPrompt(
                systemContext, personaPrompt
            );
        }

        // ============================================
        // Phase 5: Execute strategy
        // ============================================
        const result = await this._executeStrategy(strategy, userMessage, analysis, finalSystemContext, options);

        // Adversarial verification
        if (this.adversarialVerifier && result.response && !result.needsTools) {
            try {
                const verification = await this.adversarialVerifier.verify(result.response, {
                    userMessage,
                    instructions: `意图=${analysis.intent}, 策略=${strategy}`
                });
                if (!verification.passed && verification.suggestedFix) {
                    result.response = verification.suggestedFix;
                    result._adversarialCheck = { original: 'flagelado', fixed: true };
                }
                result._adversarialCheck = result._adversarialCheck || verification;
            } catch (e) {
                // 验证失败不阻断
            }
        }

        // Publish response to message pool
        if (this.messagePool && result.response) {
            this.messagePool.publish('assistant', {
                type: 'response',
                content: result.response,
                role: 'assistant',
                metadata: { strategy, turn: this.state.turnCount }
            });
        }

        // 更新对话状态
        this._updateStateFromResult(strategy, result, analysis);

        // 自动语言检测
        if (this.state.turnCount <= 2) {
            this.state.language = this._detectLanguage(userMessage);
        }

        return {
            thinking: this._generateThinking(analysis, strategy, memoryContext),
            analysis,
            strategy,
            response: result.response,
            needsTools: result.needsTools || false,
            toolPlan: result.toolPlan || null,
            _awaitingConfirm: result._awaitingConfirm || false,
            _hallucinationGuard: analysis._guard
        };
    }

    // ============================================
    // Phase 1: Three-layer intent analysis
    // ============================================

    async _analyzeIntent(userMessage) {
        const msg = userMessage.trim();

        // ============================================
        // Layer 1: Rephrase detection
        // ============================================
        const isQuestion = this._isInformationQuestion(msg);
        if (isQuestion) {
            return this._makeAnalysis('chat', 'simple', false, {
                guard: 'rephrase',
                confidence: 0.95
            });
        }

        // ============================================
        // Layer 2: Heuristic analysis (fast path)
        // ============================================
        const heuristic = this._heuristicAnalysis(msg);

        // If heuristic confidence is high enough, use it directly
        if (heuristic.confidence > 0.85) {
            return heuristic;
        }

        // ============================================
        // Layer 3: LLM analysis (slow but accurate)
        // ============================================
        try {
            return await this._llmIntentAnalysis(msg, heuristic);
        } catch (e) {
            // LLM 失败时回退到启发式结果
            return heuristic;
        }
    }

    _makeAnalysis(intent, complexity, requiresTools, extra = {}) {
        return {
            intent,
            complexity: complexity || 'simple',
            requiresTools,
            entities: extra.entities || {},
            summary: extra.summary || '',
            confidence: extra.confidence || 0.5,
            _guard: extra.guard || null,
            _toolUnavailable: extra.toolUnavailable || false
        };
    }

    // ============================================
    // Anti-task-hallucination Layer 1: Rephrase detection
    // ============================================

    _isInformationQuestion(message) {
        const rephrasePatterns = [
            // 中文改写模式
            /如何\s*(才?能?|可以?|用|通过)/i,
            /怎么\s*(才?能?|可以?|用|通过)/i,
            /怎样\s*(才?能?|可以?|用|通过)/i,
            /(如何|怎么|怎样)\s*(才?能?|可以?)\s*(用|使用|通过|调用|实现|操作|删除|创建|打开|关闭|修改|设置)/i,
            /(如何|怎么|怎样)\s*(写|编|创建|删除|修改|配置|安装|部署|调试|测试|优化)/i,
            /(什么|哪些|哪).*(命令|方法|步骤|方式|API|库|工具|配置).*(可以|能|用来|用于)/i,
            /(请?问|请教|想请教|想问问).*(如何|怎么|怎样|什么|哪些|是否|有没有)/i,
            /(有没|有没有|可否|是否能|能不能|是否可以|可不可以)\s*(用|通过|使用|调用|实现|操作)/i,
            /.*的(步骤|方法|方式|流程|命令|写法|用法|配置方法|实现方式)/i,
            /(举例|示例|例子|demo|sample|范例).*(说明|演示|展示).*(如何|怎么|怎样)/i,
            /(是|有)什么(意思|用途|作用|区别|不同|原理|原因)/i,
            /(什么|哪些).*(区别|不同|差异)/i,
            /.*(教程|指南|入门).*/i,
            // 英语改写模式
            /how (to|do|can|would|should|could|does|is|are|was|were)/i,
            /what (is|are|was|were|does|do|can|would|could|should|the|command|function|method|step|way|tool|api|library)/i,
            /where (is|are|can|do|does|should|could|would)/i,
            /why (is|are|do|does|can|would|could|should)/i,
            /can (i|you|we|one|someone|anyone) (use|do|run|execute|create|delete|modify)/i,
            /(could you tell|would you mind|do you know|do you have any).*(how|what|where|why|whether)/i,
            /please (explain|describe|tell|show|demonstrate|teach)/i,
            /show me (how|an example|a demo|the way|the steps|the process)/i,
            /tell me (how|what|where|why|whether|about|more|the difference)/i,
            /(difference|diff|区别|差异) between/i,
            /tutorial|guide|documentation|docs|reference|manual/i,
        ];
        return rephrasePatterns.some(p => p.test(message));
    }

    // ============================================
    // Anti-task-hallucination Layer 2: Heuristic analysis
    // ============================================

    _isExplicitCommand(message) {
        const commandPatterns = [
            // 中文直接指令
            /^(帮我把|帮我|给我|请[你把]?|你[去]?把|立刻|马上|现在[就]?)\s*(分析|统计|比较|合并|压缩|解压|下载|上传|计算|检查|检测|读取|搜索|清理|整理|创建|删除|打开|关闭|运行|执行|启动|停止|复制|移动|重命名|修改|设置|安装|卸载|清空|发送|生成|写|保存|查看|看|浏览|播放|连接|配置|备份|恢复|导出|导入|更新|升级|添加|移除|截屏|截图|查询)/i,
            // 中文动词开头
            /^(分析|统计|比较|合并|压缩|解压|下载|上传|计算|检查|检测|读取|搜索|清理|整理|创建|删除|打开|关闭|运行|执行|启动|停止|复制|移动|重命名|修改|设置|安装|卸载|清空|发送|生成|写|保存|查看|看|浏览|播放|连接|配置|备份|恢复|导出|导入|更新|升级|添加|移除|截屏|截图|告诉|查询)\s*.{2,}/i,
            // "在...上/里" 结构（在桌面上创建文件、在D盘新建文件夹）
            /在.*(上|里|下|中)\s*(创建|新建|写|写入|保存|复制|移动|删除|打开|运行|执行|生成|建立|放|存放|建立|设置|修改)\s*.{2,}/i,
            // "把...给我" 结构
            /把.*(给我|做了|处理[一下]?|检查[一下]?|更新[一下]?|清理[一下]?|整理[一下]?)/i,
            // "给...做X" 结构
            /给.*(创建|新建|写|发|发送|配置|设置|安装|打开|运行|启动|停止|删除|复制|移动|改名)/i,
            // "帮我/给我" 放宽匹配（不要空格限制）
            /(帮我|给我|替我)\s*.{3,}/i,
            // 英文指令
            /^(please )?(create|delete|open|close|run|execute|start|stop|copy|move|rename|modify|change|set|install|uninstall|clear|send|generate|write|save|analyze|check|search|find|list|show|display|read|screenshot)\s/i,
            /^(can you|could you|would you|will you|please)\s+(create|delete|open|close|run|execute|start|stop|copy|move|rename|modify|change|set|install|uninstall|clear|send|generate|write|save|analyze|check|search|find|list|show|display|read|screenshot)/i,
            // 特定单字指令
            /^[搜查打找删改看写]\s*.{2,}/i,
        ];
        return commandPatterns.some(p => p.test(message));
    }

    _heuristicAnalysis(message) {
        const msg = message.trim();

        // 改写检测优先
        if (this._isInformationQuestion(msg)) {
            return this._makeAnalysis('chat', 'simple', false, {
                guard: 'heuristic_rephrase',
                confidence: 0.95,
                summary: msg.substring(0, 80)
            });
        }

        let intent = 'chat';
        let requiresTools = false;
        let confidence = 0.5;

        if (this._isExplicitCommand(msg)) {
            intent = 'control';
            requiresTools = true;
            confidence = 0.9;
        } else if (/^(查询|显示|查看|多少|列出|什么|如何|怎么)/i.test(msg)) {
            intent = 'query';
            requiresTools = false;
        } else if (/^帮我/.test(msg)) {
            if (/帮我\s*(理解|看看|检查[一下]?|分析|解释)/i.test(msg)) {
                intent = 'query';
                requiresTools = false;
            } else {
                intent = 'task';
                requiresTools = true;
                confidence = 0.8;
            }
        } else if (/^(整理|分析|处理|备份|同步|批量|自动|规划)/i.test(msg)) {
            intent = 'task';
            requiresTools = true;
            confidence = 0.75;
        } else if (/(?:^|，|,)(?:但是?|然而|不过|虽然|尽管)/i.test(msg)) {
            // 包含转折 → 可能是复杂query
            intent = 'query';
            requiresTools = false;
        }

        const complexity = msg.length > 150 ? 'complex' : msg.length > 50 ? 'medium' : 'simple';

        return this._makeAnalysis(intent, complexity, requiresTools, {
            confidence,
            summary: msg.substring(0, 80)
        });
    }

    // ============================================
    // Anti-task-hallucination Layer 3: LLM intent analysis
    // ============================================

    async _llmIntentAnalysis(userMessage, heuristic) {
        const deviceContext = this._buildDeviceContextSnippet();

        const systemPrompt = `你是一个意图分析模块。分析用户是想"问问题"还是"做操作"。

返回 JSON（不要代码块）:
{
  "intent": "query|control|task|config|chat",
  "complexity": "simple|medium|complex",
  "requiresTools": false,
  "entities": {},
  "summary": "一句话总结用户要做什么",
  "confidence": 0.0-1.0
}

规则:
- 用户说"怎么/如何/什么/为什么"等疑问词 → chat, requiresTools=false
- 用户说"帮我做X""创建文件""运行命令""打开网站"等指令 → requiresTools=true
- 用户说"查一下""看看""显示""列出"涉及查询的 → requiresTools=true
- 任何涉及对电脑进行实际操作（创建/删除/修改/运行/打开）的 → requiresTools=true
- 不确定时，倾向于 requiresTools=true 让执行层去判断`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...(deviceContext ? [{ role: 'system', content: `设备: ${deviceContext}` }] : []),
            { role: 'user', content: `分析: "${userMessage}"` }
        ];

        const raw = await this.llm.chat(messages);
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        const analysis = this._makeAnalysis(
            parsed.intent || 'chat',
            parsed.complexity || 'simple',
            parsed.requiresTools || false,
            {
                entities: parsed.entities || {},
                summary: parsed.summary || '',
                confidence: parsed.confidence || 0.5
            }
        );

        // 第二层防线：改写检测override
        if (analysis.requiresTools && this._isInformationQuestion(userMessage)) {
            analysis.requiresTools = false;
            analysis.intent = 'chat';
            analysis._guard = 'llm_rephrase_override';
        }

        // 第三层防线：置信度门槛
        if (analysis.requiresTools && (analysis.confidence || 0) < 0.8) {
            if (this._isExplicitCommand(userMessage)) {
                analysis.confidence = 0.9;
            } else {
                analysis.requiresTools = false;
                analysis.intent = 'chat';
                analysis._guard = 'low_confidence';
            }
        }

        return analysis;
    }

    // ============================================
    // Phase 2: Strategy decision
    // ============================================

    _decideStrategy(analysis, userMessage) {
        const strategyMap = {
            query:   { type: 'query', requiresTools: analysis.requiresTools },
            control: { type: 'execute', requiresTools: true },
            task:    { type: 'planAndExecute', requiresTools: true },
            config:  { type: 'execute', requiresTools: true },
            chat:    { type: 'directChat', requiresTools: false },
        };
        if (analysis.requiresTools) {
            return strategyMap[analysis.intent] || { type: 'execute', requiresTools: true };
        }
        return strategyMap[analysis.intent] || strategyMap.chat;
    }

    // ============================================
    // Phase 4: System context construction
    // ============================================

    _buildSystemContext(analysis, memoryContext = null) {
        const parts = [];

        // Role definition — 执行优先，不是聊天优先
        const roleDef = `你是 JingxuanAgent — 运行在用户 Windows 电脑上的智能助手。
你有以下能力：
1. 文件操作 — 读/写/编辑/搜索本地文件
2. 命令执行 — 运行 cmd/PowerShell 命令
3. 进程管理 — 查看/管理运行中的进程
4. 系统操控 — 系统信息/剪贴板/通知/电源管理
5. GUI自动化 — 截屏分析、浏览器控制
6. 网络请求 — HTTP请求获取信息
7. 对话交流 — 回答用户的问题，提供信息和建议

核心原则：用户要求执行操作时，直接执行，不要分析或建议。完成任务后一句话告知结果。`;

        parts.push(roleDef);

        // 系统能力清单
        parts.push(
`你的系统已加载以下全部模块，相关能力已通过工具暴露，无需读取源码：

【记忆系统】MemoryManager — 分层记忆 L0-L3，自动持久化到磁盘文件。跨会话：每次启动自动加载历史记忆到向量索引，可通过 SaveMemory 工具写入长期记忆。
【任务编排】CoordinatorOrchestrator — 任务分解、工具循环、检查点、自动重试。
【执行器】AtomicExecutor/ToolExecutor — 文件读写、命令执行、GUI操作、浏览器控制。
【认知框架】CognitiveOrchestrator — 决策引擎、模式检测、概念构建、知识图谱。
【LLM适配器】支持 DeepSeek/GLM/Qwen/Minimax 多模型切换与自动回退。
【MCP客户端】可连接外部工具服务器扩展能力。
【配置系统】JingxuanAgent_Ultimate_Config.js 自动加载，无需手动部署。`);

        // === 对话上下文 ===
        const ctxLines = [`当前分析:
- 意图: ${analysis.intent}
- 复杂度: ${analysis.complexity}
- 摘要: ${analysis.summary}`];

        // 活跃任务状态
        if (this.state.activeTask) {
            ctxLines.push(`
- 进行中任务: ${this.state.activeTaskGoal}
- 进度: ${this.state.activeTaskProgress || '进行中'}
- 已完成: ${this.state.activeTaskSteps.join(' → ') || '尚未开始'}`);
        }

        parts.push(`===== 对话上下文 =====\n${ctxLines.join('\n')}`);

        // === 用户画像 ===
        if (this.state.turnCount > 3) {
            const profileParts = [];
            if (this.state.userProfile.communicationStyle) {
                profileParts.push(`风格: ${this.state.userProfile.communicationStyle}`);
            }
            const prefs = Object.entries(this.state.userProfile.knownPreferences);
            if (prefs.length > 0) {
                profileParts.push(`偏好: ${prefs.slice(-5).map(([k, v]) => `${k}=${v}`).join(', ')}`);
            }
            if (profileParts.length > 0) {
                parts.push(`[用户画像]\n${profileParts.join('\n')}`);
            }
        }

        // === 记忆增强上下文 ===
        if (memoryContext && memoryContext.hasContext) {
            parts.push(memoryContext.context);
        }

        // === 设备上下文 ===
        if (this.deviceManager) {
            try {
                const report = this.deviceManager.getFullReport();
                if (report && !report.error) {
                    const deviceLines = [
                        `类型: ${report.info?.type || 'N/A'}`,
                        `名称: ${report.info?.name || report.info?.hostname || 'N/A'}`
                    ];
                    if (this.permissionSystem) {
                        const level = this.permissionSystem.getEffectiveLevel();
                        const levelName = this.permissionSystem.getLevelName();
                        deviceLines.push(`权限: Level ${level} (${levelName})`);
                    }
                    parts.push(`[设备]\n${deviceLines.join('\n')}`);
                }
            } catch (e) { console.warn(`[conversation] Unhandled error: ${e.message}`); }
        }

        // === 当前时间（实时注入，防止LLM幻觉时间） ===
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        const isoStr = now.toISOString();
        parts.push(`[当前时间]
本地时间: ${timeStr}
ISO时间: ${isoStr}
时区: Asia/Shanghai (UTC+8)`);

        // === 触发词（行为规则） ===
        parts.push(`
回复规则:
- 使用用户的语言回复（中文/英文）
- 简洁专业，直接回答问题
- 执行操作前简要说明你要做什么
- 如果用户问"如何做X"，提供步骤说明，不要真的去执行
- 不确定时，优先提问澄清而不是猜测执行`);

        // === 对话历史 ===
        if (this.contextManager) {
            const history = this.contextManager.getHistory({ maxMessages: 30 });
            if (history.length > 0) {
                const historyText = history.map(m =>
                    `${m.role === 'user' ? '用户' : '助手'}: ${m.content.substring(0, 500)}`
                ).join('\n');
                parts.push(`[对话历史]\n${historyText}`);
            }
        }

        return parts.join('\n\n');
    }

    // ============================================
    // Phase 5: Strategy execution
    // ============================================

    async _executeStrategy(strategy, userMessage, analysis, systemContext, options) {
        switch (strategy.type) {
            case 'directChat': {
                // If user is asking rather than commanding, use plain chat
                if (analysis.intent !== 'chat' && analysis.requiresTools) {
                    return { response: '', needsTools: true, toolPlan: { intent: analysis.intent, summary: analysis.summary } };
                }
                return {
                    response: await this._llmChat(userMessage, systemContext),
                    needsTools: false
                };
            }

            case 'query': {
                if (analysis.requiresTools) {
                    return { response: '', needsTools: true, toolPlan: { intent: 'query', summary: analysis.summary } };
                }
                return { response: await this._llmChat(userMessage, systemContext), needsTools: false };
            }

            case 'execute': {
                return { response: '', needsTools: true, toolPlan: { intent: 'control', summary: analysis.summary } };
            }

            case 'planAndExecute': {
                return { response: '', needsTools: true, toolPlan: { intent: 'task', summary: analysis.summary } };
            }

            default:
                return { response: await this._llmChat(userMessage, systemContext), needsTools: false };
        }
    }

    // ============================================
    // LLM chat
    // ============================================

    async _llmChat(userMessage, systemContext) {
        try {
            const messages = [
                { role: 'system', content: systemContext },
                ...this._getRecentHistory(),
                { role: 'user', content: userMessage }
            ];

            const response = await this.llm.chat(messages);
            const cleaned = response.replace(/```/g, '').trim();
            this.state.lastResponseHash = this._hash(cleaned);
            this.state.responseCount++;
            return cleaned;
        } catch (e) {
            console.error('[ConversationEngine] LLM chat error:', e.message);
            return `抱歉，处理时出错了: ${e.message}`;
        }
    }

    // ============================================
    // Conversation state update
    // ============================================

    _updateStateFromResult(strategy, result, analysis) {
        // 任务追踪
        if (strategy.type === 'planAndExecute' && result.needsTools) {
            this.state.activeTask = true;
            this.state.activeTaskGoal = analysis.summary || '执行任务';
            this.state.activeTaskSteps = [];
            this.state.activeTaskProgress = '启动';
        }

        // 更新用户风格画像
        if (this.state.turnCount > 2) {
            const response = result.response || '';
            if (response.length > 200) {
                this.state.userProfile.communicationStyle = 'detailed';
            } else if (response.length < 50) {
                this.state.userProfile.communicationStyle = 'concise';
            }
        }
    }

    // ============================================
    // Helper methods
    // ============================================

    _buildDeviceContextSnippet() {
        if (!this.deviceManager) return null;
        try {
            const report = this.deviceManager.getFullReport();
            if (!report || report.error) return null;
            const lines = [`设备类型: ${report.info?.type || 'unknown'}`];
            if (report.sensors?.cpu) {
                lines.push(`CPU: ${typeof report.sensors.cpu.usagePercent === 'number' ? (report.sensors.cpu.usagePercent * 100).toFixed(1) : 'N/A'}%`);
            }
            if (report.sensors?.memory) {
                lines.push(`内存: ${report.sensors.memory.usagePercent}%`);
            }
            return lines.join(', ');
        } catch (e) { return null; }
    }

    _getRecentHistory() {
        try {
            return this.contextManager ? this.contextManager.getHistory({ maxMessages: 20 }) : [];
        } catch (e) { return []; }
    }

    _detectLanguage(message) {
        const chineseChars = (message.match(/[一-鿿]/g) || []).length;
        const totalChars = message.replace(/\s/g, '').length;
        if (totalChars === 0) return 'unknown';
        return (chineseChars / totalChars) > 0.3 ? 'zh' : 'en';
    }

    _generateThinking(analysis, strategy, memoryContext) {
        const intentLabels = {
            query: '查询', control: '控制', task: '任务', config: '配置', chat: '对话'
        };
        const strategyLabels = {
            query: '查询执行', execute: '单步控制',
            planAndExecute: '规划执行', directChat: '直接回复'
        };

        const lines = [
            `🎯 意图: ${intentLabels[analysis.intent] || analysis.intent}`,
            `📊 策略: ${strategyLabels[strategy.type] || strategy.type}`,
            `💡 ${analysis.summary || ''}`,
        ];

        if (memoryContext?.hasContext) {
            lines.push(`📖 记忆增强: ${memoryContext.sources.length}条相关记忆`);
        }
        if (analysis._guard) {
            lines.push(`🛡️ 防幻觉: ${analysis._guard}`);
        }

        return '```analysis\n' + lines.join('\n') + '\n```';
    }

    _hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }

    getState() { return this.state; }

    getStats() {
        return {
            turnCount: this.state.turnCount,
            phase: this.state.phase,
            activeTask: !!this.state.activeTask,
            intentHistory: this.state.intentHistory,
            userStyle: this.state.userProfile.communicationStyle
        };
    }
}

module.exports = ConversationEngine;
