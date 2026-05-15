// CoordinatorOrchestrator - task orchestrator
const { toToolDefinitions } = require('../../JingxuanAgent_Core/tool_schema');
const ReflectionEngine = require('./ReflectionEngine');
const MetaCognitiveMonitor = require('./MetaCognitiveMonitor');
const CheckpointManager = require('./CheckpointManager');

class CoordinatorOrchestrator {
    constructor(config) {
        this.stateManager = config.stateManager;
        this.memoryManager = config.memoryManager;
        this.registry = config.registry;
        this.executor = config.executor;
        this.sopGenerator = config.sopGenerator;
        this.optimizer = config.optimizer;
        this.llmAdapter = config.llmAdapter;
        this.conversationEngine = config.conversationEngine || null;
        this.config = config.config || {};

        this.executionState = 'IDLE';
        this.currentPlan = null;

        this.reflectionEngine = new ReflectionEngine(this.memoryManager, this.llmAdapter, {
            maxDepth: this.config.maxReflectLoop || 3
        });
        this.metaMonitor = new MetaCognitiveMonitor({ enabled: true });

        // Decision modules
        this.stateGraph = null;
        this.skillLibrary = null;
        this.mctsPlanner = null;

        // Anti-hallucination: tool call state machine
        this.toolCallStateMachine = null;
        this.toolRegistry = null;
        this._currentPermissionLevel = 1;

        // ============================================
        // 任务分解 & 检查点
        // ============================================
        this.taskDecomposition = {
            maxSubtasks: 5,          // 最大子任务数
            checkpointInterval: 3,   // 每N步一个检查点
            currentTask: null,       // 当前正在执行的任务
            subtasks: [],            // [ { id, goal, status, result } ]
            completedSubtasks: [],
            progress: null,          // "3/5"
        };

        // ============================================
        // Persistent checkpoint manager
        // ============================================
        this.checkpointManager = new CheckpointManager({
            stateManager: this.stateManager,
            storageDir: 'checkpoints',
            maxCheckpoints: 50,
            enabled: process.env.CHECKPOINT_ENABLED !== 'false'
        });

        // 工具调用循环深度
        this._toolLoopDepth = 0;
        this._toolStartTime = 0;
    }

    // ============================================
    // 主入口
    // ============================================

    async runTask(goal, options = {}) {
        this.executionState = 'RESEARCHING';

        const preReflection = await this._preReflect(goal);

        try {
            const researchData = await this._stageResearch(goal);
            this.executionState = 'SYNTHESIZING';
            const plan = await this._stageSynthesis(goal, researchData);

            if (preReflection.riskLevel !== 'low' && preReflection.llmAdvice) {
                plan._reflectionAdvice = preReflection.llmAdvice;
            }

            this.currentPlan = plan;
            this.executionState = 'IMPLEMENTING';
            const executionResult = await this._stageImplementation(plan);

            await this._postReflect(goal, executionResult, {
                duration: Date.now() - (researchData.timestamp || Date.now()),
                steps: plan.steps?.length || 0
            });

            this.executionState = 'COMPLETED';
            return executionResult;
        } catch (error) {
            this.executionState = 'FAILED';
            if (this.config.maxRetries > 0) {
                return await this._handleFailure(goal, error);
            }
            throw error;
        }
    }

    async runTaskWithTools(goal, options = {}) {
        const maxLoops = options.maxToolLoops || 30;
        this._toolLoopDepth = 0;
        this._toolStartTime = Date.now();

        // 检查LLM能力
        if (!this.llmAdapter.chatWithTools && !this.llmAdapter.chat) {
            return this.runTask(goal, options);
        }

        // ============================================
        // Checkpoint restore
        // ============================================
        const taskStr = typeof goal === 'string' ? goal : (goal.description || goal.task || '');
        if (options.restore !== false && this.checkpointManager) {
            try {
                const checkpoint = await this.checkpointManager.restore(taskStr);
                if (checkpoint && checkpoint.subtasks && checkpoint.subtasks.length > 0) {
                    const remaining = checkpoint.subtasks.filter(s => s.status !== 'completed');
                    const completed = checkpoint.subtasks.filter(s => s.status === 'completed');
                    if (remaining.length > 0 && completed.length > 0) {
                        console.log(`[Coordinator] 从检查点恢复任务: 已完成 ${completed.length}/${checkpoint.subtasks.length} 步`);
                        this.taskDecomposition.subtasks = checkpoint.subtasks.map(s => ({ ...s }));
                        this.taskDecomposition.completedSubtasks = completed.map(s => ({ ...s }));
                        this.taskDecomposition.currentTask = remaining[0]?.goal || taskStr;
                        this.taskDecomposition.progress = `${completed.length}/${checkpoint.subtasks.length}`;

                        // Continue with remaining subtasks using restored context
                        const overallResult = completed.map(s => s.result || '').join('\n');
                        return await this._executeRemainingSubtasks(
                            remaining, taskStr, overallResult, options
                        );
                    }
                }
            } catch (e) {
                console.warn(`[Coordinator] 检查点恢复失败 (非致命): ${e.message}`);
            }
        }

        // ============================================
        // Skill retrieval
        // ============================================
        let reusedSkill = null;
        if (this.skillLibrary && typeof this.skillLibrary.retrieveSkill === 'function') {
            try {
                const skills = await this.skillLibrary.retrieveSkill(taskStr, 1);
                if (skills.length > 0 && skills[0].score > 0.4 && skills[0].code) {
                    reusedSkill = skills[0];
                    console.log(`[Coordinator] Reusing skill: ${reusedSkill.name} (score=${reusedSkill.score.toFixed(2)})`);
                }
            } catch (e) {
                // 技能检索失败不影响主流程
            }
        }

        const isComplex = taskStr.length > 80 || this._isComplexTask(taskStr);

        if (isComplex && !reusedSkill) {
            const subtasks = await this._decomposeTask(taskStr);
            if (subtasks.length > 1) {
                return await this._executeSubtasks(subtasks, goal, options);
            }
        }

        // ============================================
        // Simple task: direct tool loop
        // ============================================
        return await this._toolLoop(goal, options, maxLoops);
    }

    // ============================================
    // Task decomposition execution
    // ============================================

    async _decomposeTask(goal) {
        try {
            const response = await this.llmAdapter.chat([
                {
                    role: 'system',
                    content: `你是任务分解专家。将以下复杂任务分解为2-5个可独立执行的子任务。
返回JSON数组（不要代码块）:
[{"id":1,"goal":"子任务目标描述","checkpoint":true}]

规则:
- 每个子任务应是一个完整可执行的操作
- 需要中间结果的子任务设 checkpoint:true
- 子任务应按执行顺序排列
- 最后一步应验证整体结果`
                },
                { role: 'user', content: `任务: ${goal}` }
            ]);

            const cleaned = response.replace(/```json|```/g, '').trim();
            const subtasks = JSON.parse(cleaned);
            if (Array.isArray(subtasks) && subtasks.length >= 1 && subtasks.length <= 8) {
                return subtasks.map((s, i) => ({
                    ...s,
                    status: 'pending',
                    result: null,
                    error: null,
                    retries: 0
                }));
            }
        } catch (e) {
            // 分解失败，返回整体
        }
        return [{ id: 1, goal: goal, checkpoint: true, status: 'pending' }];
    }

    async _executeSubtasks(subtasks, originalGoal, options) {
        this.taskDecomposition.subtasks = subtasks;
        this.taskDecomposition.completedSubtasks = [];
        this.taskDecomposition.currentTask = subtasks[0]?.goal || originalGoal;

        let overallResult = '';
        const maxLoops = options.maxToolLoops || 15;

        for (let i = 0; i < subtasks.length; i++) {
            const subtask = subtasks[i];
            subtask.status = 'in_progress';
            this.taskDecomposition.currentTask = subtask.goal;
            this.taskDecomposition.progress = `${i + 1}/${subtasks.length}`;

            // 传递上下文（已有结果）
            const contextGoal = this._buildSubtaskContext(subtask, originalGoal, overallResult);

            try {
                const result = await this._toolLoop(contextGoal, options, maxLoops);
                subtask.status = 'completed';
                subtask.result = result;

                if (result) {
                    overallResult += `\n[步骤${subtask.id}] ${result.substring(0, 500)}`;
                }

                this.taskDecomposition.completedSubtasks.push(subtask);

                // Checkpoint: persist progress
                if (subtask.checkpoint || i % this.taskDecomposition.checkpointInterval === 0) {
                    await this._saveCheckpoint(originalGoal, subtasks, i);
                }
            } catch (e) {
                subtask.status = 'failed';
                subtask.error = e.message;

                // 尝试重试一次
                if (subtask.retries < 1) {
                    subtask.retries++;
                    i--; // 重试当前步骤
                    continue;
                }

                overallResult += `\n[步骤${subtask.id} 失败] ${e.message}`;
                // 继续下一步而不是完全失败
            }
        }

        this.executionState = 'COMPLETED';
        return overallResult || originalGoal + ' (completed)';
    }

    /**
     * Execute remaining subtasks after checkpoint restore
     */
    async _executeRemainingSubtasks(remainingSubtasks, originalGoal, previousResults, options) {
        const maxLoops = options.maxToolLoops || 15;
        let overallResult = previousResults || '';

        for (let i = 0; i < remainingSubtasks.length; i++) {
            const subtask = remainingSubtasks[i];
            subtask.status = 'in_progress';
            this.taskDecomposition.currentTask = subtask.goal;
            this.taskDecomposition.progress = `${this.taskDecomposition.completedSubtasks.length + i + 1}/${this.taskDecomposition.subtasks.length}`;

            const contextGoal = this._buildSubtaskContext(subtask, originalGoal, overallResult);

            try {
                const result = await this._toolLoop(contextGoal, options, maxLoops);
                subtask.status = 'completed';
                subtask.result = result;

                if (result) {
                    overallResult += `\n[步骤${subtask.id}] ${result.substring(0, 500)}`;
                }

                this.taskDecomposition.completedSubtasks.push(subtask);

                if (subtask.checkpoint) {
                    await this._saveCheckpoint(originalGoal, remainingSubtasks, i);
                }
            } catch (e) {
                subtask.status = 'failed';
                subtask.error = e.message;
                if (subtask.retries < 1) {
                    subtask.retries++;
                    i--;
                    continue;
                }
                overallResult += `\n[步骤${subtask.id} 失败] ${e.message}`;
            }
        }

        this.executionState = 'COMPLETED';
        return overallResult || originalGoal + ' (已恢复并执行完毕)';
    }

    _buildSubtaskContext(subtask, originalGoal, previousResults) {
        let context = subtask.goal;
        if (previousResults) {
            context += `\n\n已完成的上一步结果:\n${previousResults.substring(0, 500)}`;
        }
        context += `\n\n注意: 这是任务"${originalGoal}"的第${subtask.id}步。完成它并返回结果。`;
        return context;
    }

    // ============================================
    // Tool loop
    // ============================================

    async _toolLoop(goal, options, maxLoops) {
        const tools = this._getTools();
        if (tools.length === 0) return this.runTask(goal, options);

        this.executionState = 'EXECUTING';

        const sysPrompt = this._buildToolSystemPrompt(goal, tools);

        const messages = [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: goal }
        ];

        let finalOutput = '';
        let consecutiveToolCalls = 0;
        const wallDeadline = Date.now() + 180000; // 3分钟墙钟超时

        this._toolLoopMessages = messages;
        this._consecutiveToolCalls = 0;

        for (let loop = 0; loop < maxLoops; loop++) {
            this._toolLoopDepth = loop;

            // 墙钟超时检查
            if (Date.now() > wallDeadline) {
                finalOutput += '\n[工具循环超时] 总执行时间超过 180 秒，已自动终止。\n';
                break;
            }

            // Try chatWithTools first, fall back to text-based JSON parsing
            let response;
            let toolCalls = [];

            try {
                if (this.llmAdapter.chatWithTools) {
                    try {
                        response = await this.llmAdapter.chatWithTools(messages, tools);
                        toolCalls = response.toolCalls || [];
                    } catch (e) {
                        // Fallback to chat + text parsing
                        const text = await this.llmAdapter.chat(messages);
                        response = { content: text };
                        toolCalls = this._parseToolCallsFromText(text, tools);
                    }
                } else {
                    const text = await this.llmAdapter.chat(messages);
                    response = { content: text };
                    toolCalls = this._parseToolCallsFromText(text, tools);
                }
            } catch (e) {
                finalOutput += `\n[API错误] ${e.message}\n`;
                break;
            }

            const cleanContent = response.content ? this._stripToolCallsFromText(response.content) : '';
            const isAnalysisText = cleanContent && /(建议|推荐|如需|可以尝试|请检查|请确认|是否继续|请选择|需要你授权|不能直接)/.test(cleanContent);

            if (!toolCalls || toolCalls.length === 0) {
                if (!cleanContent) {
                    messages.push({ role: 'user', content: '只输出JSON工具调用，不要多余文字。' });
                    continue;
                }
                if (loop < 5) {
                    messages.push({
                        role: 'assistant',
                        content: response.content || ''
                    });
                    const pushMsg = isAnalysisText
                        ? '不要分析或建议。直接调用工具执行任务。只输出JSON格式的工具调用。'
                        : '直接执行。输出JSON工具调用。';
                    messages.push({ role: 'user', content: pushMsg });
                    continue;
                }
                if (finalOutput) break;
                finalOutput = '\n[执行失败] LLM 连续 5 轮未调用工具，任务未执行。\n';
                break;
            }

            if (cleanContent && !isAnalysisText) {
                finalOutput += cleanContent + '\n';
            }

            consecutiveToolCalls++;
            this._consecutiveToolCalls = consecutiveToolCalls;

            if (consecutiveToolCalls % 5 === 0 || consecutiveToolCalls === 10) {
                try {
                    const goalStr = typeof goal === 'string' ? goal : (goal.description || goal.task || '');
                    this.checkpointManager.save({
                        goal: goalStr,
                        status: 'EXECUTING',
                        subtasks: this.taskDecomposition.subtasks,
                        completedSubtasks: this.taskDecomposition.completedSubtasks,
                        currentTask: this.taskDecomposition.currentTask || goalStr,
                        progress: this.taskDecomposition.progress,
                        messages: messages.slice(-80), // 最近80条消息
                        toolState: {
                            loopDepth: loop,
                            consecutiveToolCalls,
                            strategyBlackboard: this._strategyBlackboard || null
                        },
                        metadata: { source: 'tool_loop_auto', toolLoop: loop }
                    }).catch(e => console.warn(`[orchestrator] Caught: ${e.message}`));
                } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
            }

            if (response.content) {
                messages.push({ role: 'assistant', content: response.content });
            } else {
                const toolDesc = toolCalls.map(tc => `${tc.function.name}(${JSON.stringify(tc.function.arguments)})`).join(', ');
                messages.push({ role: 'assistant', content: `[调用工具: ${toolDesc}]` });
            }

            const toolResults = await Promise.all(toolCalls.map(async (tc) => {
                const toolName = tc.function.name;
                const params = typeof tc.function.arguments === 'string'
                    ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
                    : (tc.function.arguments || {});

                try {
                    if (this.toolCallStateMachine) {
                        const result = await this.toolCallStateMachine.invoke(
                            toolName, params,
                            { permissionLevel: this._currentPermissionLevel || 1 }
                        );
                        return {
                            id: tc.id || `tc_${loop}_${toolName}`,
                            toolName,
                            result: result.status === 'success'
                                ? { verified: true, data: result.data }
                                : { verified: false, error: result.error || '工具调用失败' },
                            data: result.status === 'success' ? result.data : null,
                            error: result.status !== 'success' ? (result.error || '失败') : null
                        };
                    }
                    const result = await this.executor.executeAction({
                        id: `tool_${loop}_${toolName}`,
                        tool: toolName,
                        params,
                        expected: 'Any'
                    });
                    return {
                        id: tc.id || `tc_${loop}_${toolName}`,
                        toolName,
                        result,
                        data: result.data,
                        error: result.error || (!result.verified ? '执行失败' : null)
                    };
                } catch (e) {
                    return { id: `tc_${loop}_${toolName}`, toolName, result: { verified: false, error: e.message }, data: null, error: e.message };
                }
            }));

            // ============================================
            // 验证层：文件写入工具系统级校验 + 自动重试
            // 这是系统代码，LLM 无法绕过。
            // ============================================
            const fs = require('fs');
            for (let ri = 0; ri < toolResults.length; ri++) {
                const tr = toolResults[ri];
                const isFileWrite = /^(write_file|file_write|Write|edit_file|Edit)$/i.test(tr.toolName);
                if (!isFileWrite || tr.error) continue;

                let filePath = null;
                try {
                    const callData = toolCalls[ri];
                    const rawParams = typeof callData.function?.arguments === 'string'
                        ? JSON.parse(callData.function.arguments) : (callData.function?.arguments || {});
                    filePath = rawParams.file_path || rawParams.filePath || rawParams.path || null;
                } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }

                if (!filePath) continue;

                // 系统级校验：文件必须真实存在
                let verified = false;
                let retries = 0;
                while (!verified && retries < 3) {
                    try {
                        verified = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
                    } catch (e) { verified = false; }
                    if (!verified) {
                        retries++;
                        if (retries < 3) {
                            // 自动重试：重新调用工具
                            try {
                                if (this.toolCallStateMachine) {
                                    const retryResult = await this.toolCallStateMachine.invoke(
                                        tr.toolName,
                                        JSON.parse(typeof toolCalls[ri]?.function?.arguments === 'string'
                                            ? toolCalls[ri].function.arguments : '{}'),
                                        { permissionLevel: this._currentPermissionLevel || 1 }
                                    );
                                    tr.data = retryResult.status === 'success' ? retryResult.data : null;
                                    tr.error = retryResult.status !== 'success' ? (retryResult.error || '重试失败') : null;
                                    tr.result = retryResult.status === 'success'
                                        ? { verified: true, data: retryResult.data }
                                        : { verified: false, error: retryResult.error || '重试失败' };
                                }
                            } catch (e) {
                                tr.error = e.message;
                            }
                        }
                    }
                }
                if (!verified) {
                    tr.error = tr.error || `文件写入后磁盘校验失败 (${filePath})，重试 ${retries} 次后放弃`;
                }
            }

            // ============================================
            // Error knowledge base and strategy blackboard
            // ============================================

            // Initialize strategy blackboard
            if (loop === 0) {
                this._strategyBlackboard = {
                    triedApproaches: [],  // [{tool, errorPattern, loop}]
                    avoidedApproaches: new Set(), // 已确认不可行的方法
                    forceStrategy: null,  // 外部强制的策略
                };
            }

            // Inject tool results into message history
            let hasError = false;
            const errorFeedbacks = []; // 收集错误以便批量分析
            for (const tr of toolResults) {
                const resultStr = tr.data
                    ? (typeof tr.data === 'string' ? tr.data.substring(0, 2000) : JSON.stringify(tr.data, null, 2).substring(0, 2000))
                    : `[失败] ${tr.error || '未知错误'}`;

                messages.push({
                    role: 'user',
                    content: `[${tr.toolName} 执行结果] ${resultStr}`
                });

                if (tr.error) {
                    hasError = true;
                    finalOutput += `\n[${tr.toolName} ❌] ${tr.error}\n`;
                    errorFeedbacks.push({ toolName: tr.toolName, error: tr.error });
                } else {
                    finalOutput += `\n[${tr.toolName} ✅] ${resultStr.substring(0, 300)}\n`;
                }
            }

            // ============================================
            // Knowledge base error analysis
            // ============================================
            if (hasError) {
                // 知识库：错误模式 → 解决方案 + 工作示例
                const knowledgeBase = [
                    {
                        id: 'powershell_embed_python',
                        match: (t, e) => t === 'exec_powershell' && (e.includes('python') || e.includes('Python')),
                        solution: '不要在PowerShell中嵌入Python代码',
                        example: `正确做法(两步法):
  步骤1: file_write path="C:\\Users\\{用户名}\\Desktop\\create_doc.py" content="完整Python代码"
  步骤2: exec_cmd cmd="python C:\\Users\\{用户名}\\Desktop\\create_doc.py"`,
                        instruction: `请先用 file_write 工具将Python脚本写入 .py 文件(保存到桌面路径), 然后用 exec_cmd 执行该文件。`
                    },
                    {
                        id: 'python_c_nested_quotes',
                        match: (t, e) => t === 'exec_cmd' && (e.includes('SyntaxError') || e.includes('invalid syntax')),
                        solution: 'python -c 遇到嵌套引号会断裂',
                        example: `正确做法:
  1. file_write(path="script.py", content="print('hello')")
  2. exec_cmd(cmd="python script.py")`,
                        instruction: `python -c 不支持多行代码和嵌套引号。请先用 file_write 把完整Python代码写入 .py 文件, 再用 exec_cmd 执行该文件。`
                    },
                    {
                        id: 'python_path_escape',
                        match: (t, e) => t === 'exec_cmd' && (e.includes('unicodeescape') || e.includes('\\\\U') || e.includes('\\\\u')),
                        solution: 'Windows路径\\U被Python当作unicode转义',
                        example: `修改Python代码中的路径格式:
  path = "C:/Users/用户名/Desktop/file.docx"  # 用正斜杠
  path = r"C:\\Users\\用户名\\Desktop\\file.docx"  # 或用原始字符串`,
                        instruction: `Python中路径字符串的\\U会被当作Unicode转义。请在Python代码中使用正斜杠 / 或原始字符串 r"..." 来避免此问题。`
                    },
                    {
                        id: 'python_not_found',
                        match: (t, e) => (e.includes('python') && (e.includes('not found') || e.includes('not recognize') || e.includes('not recognized') || e.includes('not installed'))),
                        solution: 'Python命令未被识别',
                        example: `检查Python可用性:
  exec_cmd(cmd="py --version")
  exec_cmd(cmd="python3 --version")`,
                        instruction: `请尝试用 py 或 python3 代替 python 命令。`
                    },
                    {
                        id: 'pip_fails',
                        match: (t, e) => (t === 'exec_cmd' && e.includes('pip')) || (e.includes('pip') && (e.includes('error') || e.includes('fail'))),
                        solution: 'pip安装失败, 其实python-docx库已安装无需再装',
                        example: `跳过pip安装, 直接验证:
  exec_cmd(cmd="python -c \\"import docx; print(docx.__version__)\\"")`,
                        instruction: `python-docx库已安装(版本1.2.0), 无需pip。直接验证即可。`
                    },
                    {
                        id: 'com_word_unavailable',
                        match: (t, e) => e.includes('COM') || e.includes('Word.Application') || e.includes('ComObject'),
                        solution: 'Word COM对象不可用(Word未安装)',
                        example: `改用Python+python-docx:
  1. file_write(path="create.py", content="from docx import Document\\ndoc = Document()\\ndoc.save('路径')")
  2. exec_cmd(cmd="python create.py")`,
                        instruction: `Word桌面版未安装。请使用已安装的 python-docx 库来创建Word文档。`
                    },
                    {
                        id: 'module_not_found',
                        match: (t, e) => e.includes('ModuleNotFoundError') || e.includes('No module'),
                        solution: 'Python缺少依赖模块',
                        example: `exec_cmd(cmd="pip install python-docx")
  或用Python标准库实现`,
                        instruction: `缺少Python模块。尝试 pip install, 或改用Python标准库实现。`
                    },
                    {
                        id: 'cmd_not_found',
                        match: (t, e) => t === 'exec_cmd' && (e.includes('not recognized as') || e.includes('is not recognized')),
                        solution: '命令不存在',
                        example: `exec_cmd(cmd="where 命令名")`,
                        instruction: `命令不存在。请先用 where 命令检查可用性。`
                    },
                    {
                        id: 'pptx_not_installed',
                        match: (t, e) => (e.includes('pptx') || e.includes('PowerPoint')) && (e.includes('No module') || e.includes('ModuleNotFoundError') || e.includes('not found')),
                        solution: 'python-pptx 未安装',
                        example: `exec_cmd(cmd="pip install python-pptx")`,
                        instruction: `缺少 python-pptx 模块，请先安装: exec_cmd(cmd="pip install python-pptx")`
                    },
                    {
                        id: 'python_pptx_create',
                        match: (t, e) => t === 'exec_cmd' && (typeof e === 'string' && e.includes('pptx') && (e.includes('SyntaxError') || e.includes('NameError'))),
                        solution: 'Python-pptx 创建 PPT 的正确方法',
                        example: `正确做法(两步法):
  步骤1: file_write path="C:\\Users\\13717\\Desktop\\create_ppt.py" content="from pptx import Presentation\\nprs = Presentation()\\nslide = prs.slides.add_slide(prs.slide_layouts[0])\\ntitle = slide.shapes.title\\ntitle.text = '标题'\\nprs.save('C:\\\\Users\\\\13717\\\\Desktop\\\\output.pptx')"
  步骤2: exec_cmd(cmd="python C:\\Users\\13717\\Desktop\\create_ppt.py")`,
                        instruction: `创建PPT请先用 file_write 将Python+python-pptx代码写入.py文件，再用 exec_cmd python 执行该文件。注意路径中的反斜杠需要双写(\\)或使用正斜杠(/)。`
                    }
                ];

                // 匹配知识库, 生成修正指令
                const matchedKB = [];
                for (const tr of errorFeedbacks) {
                    for (const kb of knowledgeBase) {
                        if (kb.match(tr.toolName, tr.error)) {
                            if (!matchedKB.some(m => m.id === kb.id)) {
                                matchedKB.push(kb);
                            }
                            this._strategyBlackboard.avoidedApproaches.add(kb.id);
                        }
                    }
                }

                // 记录失败到黑板
                this._strategyBlackboard.triedApproaches.push({
                    loop,
                    tools: errorFeedbacks.map(e => e.toolName),
                    errorPatterns: matchedKB.map(k => k.id),
                });

                // 构建修正信息
                let correctionMsg = '';
                if (matchedKB.length > 0) {
                    correctionMsg = '错误分析与修正方案:\n';
                    for (const kb of matchedKB) {
                        correctionMsg += `\n⚠️ 问题: ${kb.solution}\n`;
                        correctionMsg += `✅ ${kb.example}\n`;
                    }
                    correctionMsg += `\n请按照上述方案重新执行。`;
                } else {
                    const errorList = errorFeedbacks.map(t => `- ${t.toolName}: ${t.error?.substring(0, 200)}`).join('\n');
                    correctionMsg = `以下工具调用出错:\n${errorList}\n\n请分析错误原因换一种方式重试。`;
                }

                // 连续失败且未匹配到特定知识 → 强制使用标准方法
                const failCount = errorFeedbacks.length;
                const triedCount = this._strategyBlackboard.triedApproaches.length;
                if ((failCount >= 2 || triedCount >= 2) && !matchedKB.some(k => k.id === 'powershell_embed_python' || k.id === 'python_c_nested_quotes')) {
                    correctionMsg += `\n\n【推荐标准方法】
创建Word文档的标准流程(已验证可行):
1. file_write: 将Python脚本写入.py文件 (path="C:\\Users\\用户名\\Desktop\\create.py", content="完整Python代码")
2. exec_cmd: python "C:\\Users\\用户名\\Desktop\\create.py"
注意: python-docx库已安装(1.2.0), 无需pip。路径用正斜杠/避免\\U转义问题。`;
                }

                messages.push({ role: 'user', content: correctionMsg });
            }

            // 自修复验证提示: 如果成功应用了 self_apply_fix，提示验证
            const appliedFix = toolResults.find(r => r.toolName === 'self_apply_fix' && !r.error && r.data?.applied);
            if (appliedFix) {
                messages.push({
                    role: 'user',
                    content: `已修复 ${appliedFix.data?.file || '未知文件'}。请再次运行 self_diagnose 验证修复效果，确认问题已消除。`
                });
            }

            // 工具循环深度保护
            if (consecutiveToolCalls > 10) {
                messages.push({
                    role: 'user',
                    content: `已连续调用 ${consecutiveToolCalls} 次工具，请总结结果。`
                });
            }

            // 连续失败 → 提示切换策略
            if (loop > 0 && hasError) {
                const lastFailed = toolResults.filter(r => r.error).map(r => r.toolName);
                const lastMsg = messages[messages.length - 1];
                if (lastFailed.length > 0 && lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
                    lastMsg.content += `\n(如果已重试过, 请换一种不同的工具或方法)`;
                }
            }
        }

        this.executionState = 'COMPLETED';
        // 不要假装成功 —— 报告实际发生了什么
        const errorCount = this._strategyBlackboard?.triedApproaches?.length || 0;
        if (errorCount > 0 && finalOutput.includes('❌')) {
          return finalOutput || goal + ' (执行完成，但有错误)';
        }
        return finalOutput || goal + ' (执行完成，但无输出结果，请检查文件系统确认)';
    }

    /**
     * 基于花括号平衡的JSON提取解析工具调用
     * 正确处理嵌套引号、前置文本、多行文本
     */
    _parseToolCallsFromText(text, tools) {
        const results = [];
        const toolKeys = ['tool', 'function', 'name', 'action'];
        const argsKeys = ['args', 'parameters', 'params', 'arguments'];

        for (let i = 0; i < text.length; i++) {
            if (text[i] !== '{') continue;
            const jsonStr = this._extractBalancedJSON(text, i);
            if (!jsonStr) continue;
            try {
                const parsed = JSON.parse(jsonStr);
                const toolName = toolKeys.reduce((v, k) => v || parsed[k], null);
                const args = argsKeys.reduce((v, k) => v || parsed[k], null) || {};
                if (toolName && typeof toolName === 'string') {
                    results.push({
                        id: `tc_text_${results.length}`,
                        function: { name: toolName, arguments: args }
                    });
                }
            } catch (e) { /* JSON解析失败 */ }
            i = text.indexOf('}', i);
            if (i < 0) break;
        }

        // 无匹配时检查整个文本是否为纯JSON
        if (results.length === 0) {
            const trimmed = text.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    const toolName = toolKeys.reduce((v, k) => v || parsed[k], null);
                    const args = argsKeys.reduce((v, k) => v || parsed[k], null) || {};
                    if (toolName) {
                        results.push({
                            id: 'tc_text_0',
                            function: { name: toolName, arguments: args }
                        });
                    }
                } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
            }
        }
        return results;
    }

    /**
     * 基于花括号+引号平衡提取完整JSON对象
     */
    _extractBalancedJSON(text, startPos) {
        let depth = 0, inString = false, escape = false, objStart = -1;
        for (let i = startPos; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') { if (depth === 0) objStart = i; depth++; }
            else if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) return text.substring(objStart, i + 1); }
        }
        return null;
    }

    /**
     * 从文本中去除工具调用JSON，保留纯文本内容
     */
    _stripToolCallsFromText(text) {
        // 如果整个文本就是工具调用JSON，返回空
        const trimmed = text.trim();
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.tool || parsed.function) return '';
        } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }

        // 去除行内的JSON工具调用
        return text.replace(/{[^}]*?"(?:tool|function)"[^}]*?"args"[^}]*?}/g, '').trim();
    }

    _buildToolSystemPrompt(goal, tools) {
        const toolDefs = tools.map(t => {
            const fn = t.function;
            const params = fn.parameters?.properties ? '\n    参数: ' + JSON.stringify(fn.parameters.properties) : '';
            return `  - ${fn.name}: ${fn.description}${params}`;
        }).join('\n');
        return `你是一个直接执行任务的工具调用者。调用工具完成用户目标。

可用工具:
${toolDefs || '  无'}

常用任务最佳实践:
- 创建Word文档(.docx): python-docx已安装。写Python脚本, exec_cmd python 执行
- 创建PowerPoint(.pptx): 用 file_write 写Python脚本为 .py 文件(python-pptx已预装), 再用 exec_cmd python 执行
- 创建纯文本文件(.txt): 直接用 file_write
- 执行cmd命令: exec_cmd (默认在用户目录执行)
- 执行PowerShell: exec_powershell
- 查系统信息: sys_info
- 网络请求: http_get (url=网址)

JSON格式: {"tool":"工具名","args":{"参数名":"参数值"}}

执行规则:
1. 第一轮就输出JSON调用工具, 不要分析
2. 只用上面列出的工具, 不编造参数名
3. 工具出错时换一种方法重试
4. 完成后一句话总结

自我诊断与修复 (当用户要求你找问题/修问题时):
1. self_diagnose — 扫描源码找问题（假成功消息、空catch块、静默错误等）
2. file_read — 阅读问题文件确认具体代码
3. self_apply_fix — 应用自动修复（修复前自动备份原文件为.bak）
4. 验证修复效果 — 如有测试则运行测试，没有则确认代码修改正确
注意: 修复 self_diagnose 找到的问题后，再次运行 self_diagnose 确认问题已解决`;
    }

    // ============================================
    // Checkpoints
    // ============================================

    async _saveCheckpoint(goal, subtasks, currentIndex) {
        // 始终保存到 L1 记忆 (快速检索)
        if (this.memoryManager) {
            await this.memoryManager.pushMemory(
                `[检查点] ${typeof goal === 'string' ? goal.substring(0, 80) : '任务'} — 完成 ${subtasks.slice(0, currentIndex + 1).filter(s => s.status === 'completed').length}/${subtasks.length} 步`,
                'L1',
                `checkpoint_${Date.now()}`
            );
        }

        // ============================================
        // Persist full execution context
        // ============================================
        const completedIds = new Set(
            subtasks.slice(0, currentIndex + 1)
                .filter(s => s.status === 'completed')
                .map(s => s.id)
        );
        const completed = subtasks.filter(s => completedIds.has(s.id));

        try {
            const ckptId = await this.checkpointManager.save({
                goal,
                status: this.executionState || 'RUNNING',
                subtasks: subtasks.map(s => ({ ...s })),
                completedSubtasks: completed.map(s => ({ ...s })),
                currentTask: this.taskDecomposition.currentTask,
                progress: this.taskDecomposition.progress || `${completed.length}/${subtasks.length}`,
                messages: this._toolLoopMessages || [],
                toolState: {
                    loopDepth: this._toolLoopDepth || 0,
                    consecutiveToolCalls: this._consecutiveToolCalls || 0,
                    strategyBlackboard: this._strategyBlackboard || null,
                    lastToolResults: []
                },
                metadata: {
                    source: 'coordinator_orchestrator',
                    currentStep: currentIndex
                }
            });
            if (ckptId) {
                console.log(`[Coordinator] Checkpoint saved: ${ckptId} (${completed.length}/${subtasks.length})`);
            }
        } catch (e) {
            console.warn(`[Coordinator] CheckpointManager save failed (non-fatal): ${e.message}`);
        }
    }

    async restoreFromCheckpoint(goal) {
        if (!this.memoryManager) return null;

        const memories = await this.memoryManager.retrieve(goal, {
            searchLevels: ['L1', 'L2'],
            limit: 10
        });

        for (const mem of memories) {
            const content = typeof mem.content === 'string' ? mem.content : '';
            if (content.includes('[检查点]') && content.includes(goal.substring(0, 30))) {
                console.log(`[Orchestrator] 找到检查点: ${content.substring(0, 100)}`);
                return { found: true, checkpoint: content };
            }
        }
        return { found: false };
    }

    // ============================================
    // Stage methods
    // ============================================

    async _stageResearch(goal) {
        const [memories, capabilities] = await Promise.all([
            this.memoryManager.retrieve(goal),
            Promise.resolve(this.registry.getCapabilities())
        ]);
        return { memories, capabilities, timestamp: Date.now() };
    }

    async _stageSynthesis(goal, researchData) {
        // MCTS planning
        if (this.mctsPlanner && typeof this.mctsPlanner.plan === 'function') {
            try {
                const tools = this.executor?.toolExecutor?.getToolDefinitions?.() || [];
                const mctsResult = await this.mctsPlanner.plan(
                    typeof goal === 'string' ? goal : (goal.description || ''),
                    tools,
                    { research: researchData }
                );
                if (mctsResult.plan && mctsResult.plan.length > 0) {
                    console.log(`[Coordinator] MCTS plan: ${mctsResult.plan.length} steps (confidence=${mctsResult.confidence.toFixed(2)})`);
                    return {
                        steps: mctsResult.plan.map((action, i) => ({
                            step: i + 1,
                            action: action,
                            tool: 'auto'
                        })),
                        _source: 'mcts'
                    };
                }
            } catch (e) {
                console.warn('[Coordinator] MCTS plan failed, falling back to SOP:', e.message);
            }
        }

        return await this.sopGenerator.generateSOP(goal, researchData);
    }

    async _stageImplementation(plan) {
        let finalOutput = '';
        const steps = plan.steps || [];

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];

            // 过程反思
            if (i > 0 && i % 2 === 0 && this.metaMonitor) {
                try {
                    const reflectionResult = await this.reflectionEngine.duringReflect({ duration: 0 }, i, plan);
                    if (reflectionResult.needsAdjustment) {
                        console.log(`[Orchestrator] 步骤${i}反思: 检测到潜在问题`);
                    }
                } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
            }

            try {
                const res = await this.executor.executeAction({
                    id: step.id,
                    tool: step.action,
                    params: step.params,
                    expected: step.expected || 'Any'
                });

                // echo 步骤直接返回内容
                if (step.action === 'echo' && res?.data) {
                    const msg = res.data.message || res.data.content || res.data.text || res.data.reply || '';
                    if (msg) { finalOutput = msg; continue; }
                }

                const resultStr = typeof res === 'string' ? res : JSON.stringify(res);
                finalOutput += `\nStep ${step.id} Result: ${resultStr}`;
            } catch (e) {
                // 单步失败尝试修正
                const fix = await this._reflectOnStep(step, e);
                try {
                    const retryRes = await this.executor.executeAction({
                        id: step.id,
                        tool: fix.action || step.action,
                        params: fix.params || step.params,
                        expected: step.expected || 'Any'
                    });
                    const resultStr = typeof retryRes === 'string' ? retryRes : JSON.stringify(retryRes);
                    finalOutput += `\nStep ${step.id} Fixed: ${resultStr}`;
                } catch (retryError) {
                    finalOutput += `\nStep ${step.id} Failed: ${retryError.message}`;
                }
            }
        }
        return finalOutput;
    }

    // ============================================
    // Reflection
    // ============================================

    async _preReflect(goal) {
        try {
            return await this.reflectionEngine.preReflect(goal);
        } catch (e) {
            return { riskLevel: 'low', recommendations: [], knownFailureModes: [] };
        }
    }

    async _postReflect(goal, result, executionData) {
        try {
            const postResult = await this.reflectionEngine.postReflect(goal, result, executionData);
            if (!postResult.success && postResult.canImprove && postResult.qualityScore < 0.3) {
                console.log(`[Orchestrator] 结果质量低(${postResult.qualityScore}), 但不再自动重试`);
            }
        } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
    }

    async _reflectOnStep(step, error) {
        try {
            const correctedStep = await this.llmAdapter.chat([
                {
                    role: 'user',
                    content: `步骤失败: ${error.message}\n原参数: ${JSON.stringify(step.params)}\n返回修正后的JSON: {"action":"工具名","params":{}}`
                }
            ]);
            const cleaned = correctedStep.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return {
                action: parsed.action || step.action,
                params: parsed.params || step.params
            };
        } catch (e) {
            return { action: step.action, params: step.params };
        }
    }

    async _handleFailure(goal, error) {
        console.log(`[Orchestrator] 任务失败, 已达最大重试次数: ${error.message}`);
        if (this.memoryManager) {
            await this.memoryManager.pushMemory(
                `[失败] 任务"${goal.substring(0, 80)}" 失败: ${error.message}`,
                'L2'
            );
        }
        throw error;
    }

    // ============================================
    // Tools
    // ============================================

    _getTools() {
        const capabilities = this.registry.getCapabilities();
        const tools = toToolDefinitions(capabilities);

        // 合并内置工具
        if (this.executor?.toolExecutor?.getToolDefinitions) {
            const localTools = this.executor.toolExecutor.getToolDefinitions();
            const existingNames = new Set(tools.map(t => t.function?.name));
            for (const lt of localTools) {
                if (!existingNames.has(lt.function?.name)) {
                    tools.push(lt);
                }
            }
        }

        return tools;
    }

    _isComplexTask(taskStr) {
        const complexityIndicators = [
            /并且|同时|然后|接着|首先.*然后|第一步.*第二步/i,
            /整理.*分析.*生成|创建.*写入.*验证/i,
            /多步|复杂|综合|完整|[。，]{3,}/,
            /and then|first.*then|create.*write.*verify/i,
            /multi[- ]?step|complex|comprehensive/i,
            /\n.{2,}/
        ];
        const matchCount = complexityIndicators.filter(p => p.test(taskStr)).length;
        return matchCount >= 1 || taskStr.length > 150;
    }

    /**
     * Analyze tool call errors and inject failure info
     */
    _analyzeToolErrors(toolResults) {
        const errors = [];
        for (const tr of toolResults) {
            const r = tr._stateMachineResult || tr.result;
            if (r && r.status === 'error' && r.error) {
                errors.push(r.error);
            } else if (r && r.verified === false && r.error) {
                errors.push(r.error);
            }
        }
        if (errors.length === 0) return null;
        return `以下工具调用失败，请分析原因并修正：\n${errors.map(e => `- ${e}`).join('\n')}`;
    }

    // ============================================
    // Stats
    // ============================================

    getExecutionState() { return this.executionState; }
    getToolLoopDepth() { return this._toolLoopDepth; }
    getProgress() { return this.taskDecomposition.progress; }
}

module.exports = CoordinatorOrchestrator;
