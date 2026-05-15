// QueryEngine — 核心消息循环，支持原生 tool_calls 和 LLM 工具循环

const ContextManager = require('./JingxuanAgent_CC_ContextManager.js');
const { ToolUseContext } = require('./JingxuanAgent_CC_ToolSystem.js');

class QueryEngine {
  constructor(config = {}) {
    this.llmAdapter = config.llmAdapter;
    this.toolRegistry = config.toolRegistry;
    this.contextManager = config.contextManager || new ContextManager();
    this.memoryPipeline = config.memoryPipeline || null;
    this.permissionSystem = config.permissionSystem || null;
    this.deviceManager = config.deviceManager || null;
    this.stateManager = config.stateManager || null;
    this.taskManager = config.taskManager || null;

    this.config = {
      maxToolLoops: config.maxToolLoops || 20,
      maxToolWallTime: config.maxToolWallTime || 300000,
      toolTimeout: config.toolTimeout || 120000,
      maxTokens: config.maxTokens || 8192,
      temperature: config.temperature || 0.7,
      reasoningEffort: config.reasoningEffort || 'high',
      model: config.model || null,
      verbose: config.verbose || false,
      enableThinking: config.enableThinking !== false,
      ...config,
    };

    // 工具循环状态
    this.currentToolLoop = 0;
    this.toolCallHistory = [];
    this.totalToolCalls = 0;

    this.stats = {
      totalQueries: 0,
      totalToolCalls: 0,
      totalTokens: 0,
      totalDuration: 0,
      apiErrors: 0,
      toolErrors: 0,
    };
  }

  async processMessage(userMessage, options = {}) {
    const startTime = Date.now();
    this.stats.totalQueries++;
    this.currentToolLoop = 0;
    this.toolCallHistory = [];

    const analysis = await this._analyzeIntent(userMessage);

    let memoryContext = null;
    if (this.memoryPipeline && analysis.intent !== 'chat') {
      try {
        memoryContext = await this.memoryPipeline.buildContext(userMessage, {
          topK: 5,
          threshold: 0.4,
        });
      } catch (e) {
        if (this.config.verbose) console.warn('[QueryEngine] Memory retrieval failed:', e.message);
      }
    }

    const result = await this._llmToolLoop(userMessage, analysis, memoryContext, options);

    this.contextManager.addMessage('user', userMessage, { analysis: analysis.intent });
    this.contextManager.addMessage('assistant', result.response, {
      toolCalls: this.toolCallHistory.length,
      strategy: result.strategy,
    });
    this.contextManager.updateUserProfile(userMessage, result.response);

    const duration = Date.now() - startTime;
    this.stats.totalDuration += duration;
    result.duration = duration;
    result.analysis = analysis;
    result.toolCallCount = this.toolCallHistory.length;

    return result;
  }

  async _llmToolLoop(userMessage, analysis, memoryContext, options) {
    const tools = this.toolRegistry.getToolSchemasForAPI();
    const loopStartTime = Date.now();
    const wallDeadline = loopStartTime + this.config.maxToolWallTime;

    // 初始系统消息
    const systemContent = this.contextManager.buildSystemContext({
      analysis,
      memoryContext,
      tools,
    });

    // 构建 messages
    const messages = [
      { role: 'system', content: systemContent },
      ...this.contextManager.getHistory({ maxMessages: 20 }),
      { role: 'user', content: userMessage },
    ];

    let finalResponse = '';
    let fullToolResults = [];
    let needsTools = false;
    let strategyType = 'directChat';

    // 工具循环
    for (let loop = 0; loop < this.config.maxToolLoops; loop++) {
      this.currentToolLoop = loop;

      // 墙钟超时检查：防止工具循环跑死
      if (Date.now() > wallDeadline) {
        this.stats.toolErrors++;
        finalResponse = `[工具循环超时] 总执行时间超过 ${this.config.maxToolWallTime / 1000} 秒，已自动终止。已完成 ${fullToolResults.length} 次工具调用。`;
        break;
      }

      // 调用 LLM
      let llmResponse;
      try {
        llmResponse = await Promise.race([
          this._callLLM(messages, tools),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`LLM 调用超时 (${this.config.maxToolWallTime / 1000}s)`)),
              this.config.maxToolWallTime)
          )
        ]);
      } catch (error) {
        this.stats.apiErrors++;
        if (loop === 0) {
          return {
            response: `抱歉，处理时出错了: ${error.message}`,
            needsTools: false,
            strategy: { type: 'error' },
            toolCallCount: 0,
          };
        }
        break;
      }

      const toolCalls = llmResponse.toolCalls || [];

      if (!toolCalls || toolCalls.length === 0) {
        finalResponse = llmResponse.content || '';
        needsTools = false;
        strategyType = 'directChat';
        break;
      }

      needsTools = true;
      strategyType = 'executing';
      this.totalToolCalls += toolCalls.length;

      this.toolCallHistory.push(...toolCalls.map(tc => ({
        name: tc.function?.name || tc.name,
        input: tc.function?.arguments || tc.input,
        loop,
      })));

      const assistantMsg = this._buildAssistantMessage(llmResponse);
      messages.push(assistantMsg);

      for (const tc of toolCalls) {
        const toolCall = {
          name: tc.function?.name || tc.name,
          input: this._parseToolInput(tc.function?.arguments || tc.input || '{}'),
          id: tc.id,
        };

        const toolCtx = new ToolUseContext({
          llmAdapter: this.llmAdapter,
          memoryPipeline: this.memoryPipeline,
          taskManager: this.taskManager,
          permissionSystem: this.permissionSystem,
          deviceManager: this.deviceManager,
          stateManager: this.stateManager,
          conversationHistory: messages,
          userMessage,
        });

        let toolResult;
        try {
          toolResult = await Promise.race([
            this.toolRegistry.executeToolCall(toolCall, toolCtx),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`工具调用 ${toolCall.name} 超时 (${this.config.toolTimeout / 1000}s)`)),
                this.config.toolTimeout)
            )
          ]);
        } catch (error) {
          this.stats.toolErrors++;
          toolResult = {
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: JSON.stringify({ error: error.message }),
            is_error: true,
          };
        }

        // 检查工具结果是否包含图片数据
        let imageData = null;
        try {
          const parsed = JSON.parse(toolResult.content);
          if (parsed._type === 'image_data' && parsed.base64) {
            imageData = parsed;
          }
        } catch (e) { console.warn(`[cc_mode] Unhandled error: ${e.message}`); }

        if (imageData) {
          // tool_result 中包含完整的文本分析（OCR + 元数据），供所有模型使用
          const analysisText = imageData.text || `[图片] ${imageData.fileName} (${imageData.width || '?'}x${imageData.height || '?'})`;
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolResult.tool_use_id,
              content: analysisText,
              is_error: false,
            }],
          });
          // 再推一个带 image_url 的用户消息供视觉模型使用
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `分析这张图片中的内容${imageData.ocrText ? '（包含OCR识别的文字）' : ''}: ${imageData.fileName}` },
              { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
            ],
          });
        } else {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolResult.tool_use_id,
              content: toolResult.content,
              is_error: toolResult.is_error,
            }],
          });
        }

        fullToolResults.push(toolResult);
      }
    }

    // 防幻觉验证：用户要求执行操作，但 LLM 没有调用任何工具
    const userWantsAction = analysis.requiresTools || analysis.intent === 'control' || analysis.intent === 'task';
    if (userWantsAction && this.toolCallHistory.length === 0 && !needsTools) {
      finalResponse = `[防幻觉拦截] 您要求执行操作，但 LLM 没有调用任何工具就生成了回复。这是假成功。请明确告诉我需要执行的具体操作。`;
    }

    // 验证层 2：磁盘校验失败的工具结果 — 不允许 LLM 总结，直接硬报告
    if (!finalResponse && fullToolResults.length > 0) {
      const verificationFailures = fullToolResults.filter(
        r => r._verification && !r._verification.passed
      );
      if (verificationFailures.length > 0) {
        const detail = verificationFailures.map(v => {
          let parsed;
          try { parsed = typeof v.content === 'string' ? JSON.parse(v.content) : v.content; } catch (e) { parsed = v.content; }
          return parsed.error || JSON.stringify(parsed);
        }).join('\n');
        finalResponse = `[磁盘验证失败] 以下工具调用未能通过实战检验:\n${detail}`;
      }
    }

    // 如果工具循环结束但没有最终回复，用 LLM 总结
    if (!finalResponse && fullToolResults.length > 0) {
      try {
        const summary = await Promise.race([
          this._summarizeResults(messages, userMessage),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('总结超时')), 30000)
          )
        ]);
        finalResponse = summary;
      } catch (e) {
        // 不要假装成功 —— 报告实际工具执行结果（无论成功还是失败）
        const resultSummaries = fullToolResults.slice(-3).map(r => {
          const content = typeof r.content === 'string' ? r.content.substring(0, 200)
            : (typeof r.content === 'object' ? JSON.stringify(r.content).substring(0, 200) : '');
          const error = r.is_error ? '[错误]' : '';
          return `${error} ${content}`;
        }).filter(Boolean).join(' | ');
        finalResponse = `工具执行完毕(共${fullToolResults.length}次调用)，${resultSummaries ? '结果: ' + resultSummaries : '请检查输出以确认任务是否完成。'}`;
      }
    }

    return {
      response: finalResponse || '(没有产生回复)',
      needsTools,
      strategy: { type: strategyType, loops: this.currentToolLoop + 1 },
      toolCallCount: this.toolCallHistory.length,
    };
  }

  // LLM 调用

  async _callLLM(messages, tools) {
    if (!this.llmAdapter) {
      const lastMsg = messages[messages.length - 1]?.content || '';
      return {
        content: `[Mock] 收到: ${lastMsg.substring(0, 100)}...`,
        toolCalls: [],
      };
    }

    if (this.llmAdapter.chatWithTools && tools.length > 0) {
      const result = await this.llmAdapter.chatWithTools(messages, tools, {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        thinking: this.config.enableThinking,
        reasoningEffort: this.config.reasoningEffort,
        model: this.config.model,
      });
      // DeepSeek 思维链透传
      this._lastReasoningContent = result.reasoningContent || null;
      return result;
    }

    const response = await this.llmAdapter.chat(messages, {
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });

    return { content: response, toolCalls: [] };
  }

  // 辅助方法

  _buildAssistantMessage(llmResponse) {
    const content = llmResponse.content || '';
    const toolCalls = (llmResponse.toolCalls || []).map(tc => ({
      id: tc.id,
      type: 'tool_use',
      name: tc.function?.name || tc.name,
      input: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function?.arguments || '{}')
        : (tc.function?.arguments || tc.input || {}),
    }));

    // DeepSeek 思维链：透传 reasoning_content
    const extra = this._lastReasoningContent ? { reasoning_content: this._lastReasoningContent } : {};
    this._lastReasoningContent = null; // 一次性透传

    if (toolCalls.length > 0 && !content) {
      return { role: 'assistant', content: toolCalls, ...extra };
    }

    if (toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: content },
          ...toolCalls,
        ],
      };
    }

    return { role: 'assistant', content };
  }

  _parseToolInput(input) {
    if (typeof input === 'string') {
      try {
        return JSON.parse(input);
      } catch {
        return { _raw: input };
      }
    }
    return input || {};
  }

  async _summarizeResults(messages, userMessage) {
    if (!this.llmAdapter) return '执行完成。';

    // 从消息中提取纯文本内容，丢弃 tool_use/tool_result 块避免格式转换问题
    const textMsgs = [];
    for (const m of messages.slice(-8)) {
      if (m.role === 'system') { textMsgs.push(m); continue; }
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') text += block.text + '\n';
          else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string' ? block.content
              : (typeof block.content === 'object' ? JSON.stringify(block.content).substring(0, 200) : '');
            text += '[工具执行结果] ' + resultContent + '\n';
          }
          else if (typeof block === 'string') text += block + '\n';
        }
      }
      if (text.trim()) textMsgs.push({ role: m.role, content: text.trim() });
    }

    // 如果只有系统消息，追加用户消息
    if (textMsgs.length <= 1 && userMessage) {
      textMsgs.push({ role: 'user', content: userMessage.substring(0, 200) });
    }

    const summaryPrompt = [
      { role: 'system', content: '基于工具执行结果，用用户的语言给出简洁的最终回复。只总结，不要编造，不要添加工具执行结果以外的信息。' },
      ...textMsgs.slice(-6),
    ];

    // 检查最终消息中是否有工具报错
    const hasErrors = messages.some(m => {
      if (typeof m.content === 'string') return m.content.includes('is_error') || m.content.includes('[ERROR]');
      if (Array.isArray(m.content)) return m.content.some(b => b.is_error);
      return false;
    });

    if (hasErrors) {
      summaryPrompt.push({
        role: 'user',
        content: '注意：以上工具执行中有错误发生。你的回复必须如实反映错误，不得忽略或掩盖。如果工具调用报错，直接告诉用户错误信息，不要假装成功。'
      });
    }

    try {
      const summary = await this.llmAdapter.chat(summaryPrompt, {
        maxTokens: 1024,
        temperature: 0.3,
      });
      if (summary?.trim()) return summary.trim();
      // LLM 返回空 → 报告实际工具结果而非假成功
      throw new Error('LLM returned empty summary');
    } catch (e) {
      // 构造包含工具结果概要的 fallback 消息
      const lastResults = messages.filter(m => {
        if (typeof m.content === 'string') return false;
        if (Array.isArray(m.content)) return m.content.some(b => b.type === 'tool_result');
        return false;
      }).slice(-2).map(m => {
        const blocks = Array.isArray(m.content) ? m.content : [];
        const toolBlock = blocks.find(b => b.type === 'tool_result');
        if (!toolBlock) return '';
        const content = typeof toolBlock.content === 'string' ? toolBlock.content.substring(0, 150)
          : (toolBlock.content ? JSON.stringify(toolBlock.content).substring(0, 150) : '');
        return content;
      }).filter(Boolean);
      return lastResults.length > 0
        ? `执行结果: ${lastResults.join('; ')}`
        : '我没有执行具体操作。请告诉我您想要的具体操作，我会用工具来执行。';
    }
  }

  // 意图分析

  async _analyzeIntent(userMessage) {
    const msg = userMessage.trim();

    // Layer 1: 改写检测（问"如何做X"不是"做X"）
    if (this._isInformationQuestion(msg)) {
      return this._makeAnalysis('chat', 'simple', {
        guard: 'rephrase',
        confidence: 0.95,
        summary: msg.substring(0, 80),
      });
    }

    // Layer 2: 启发式分析
    const heuristic = this._heuristicAnalysis(msg);
    if (heuristic.confidence > 0.85) {
      return heuristic;
    }

    // Layer 3: LLM 分析
    try {
      return await this._llmIntentAnalysis(msg, heuristic);
    } catch (e) {
      return heuristic;
    }
  }

  _isInformationQuestion(message) {
    const patterns = [
      /如何\s*(才能|可以|用|通过|实现)/i,
      /怎么\s*(才能|可以|用|通过)/i,
      /(什么|哪些|哪)\s*(命令|方法|步骤|方式|API|库|工具|配置).*(可以|能|用来|用于)/i,
      /(请问|想请教).*(如何|怎么|怎样|什么)/i,
      /how (to|do|can|would|should|could)/i,
      /what (is|are|the|command|function|method)/i,
      /please (explain|describe|tell|show)/i,
      /tutorial|guide|documentation|docs|reference/i,
    ];
    return patterns.some(p => p.test(message));
  }

  _isExplicitCommand(message) {
    const patterns = [
      /^(帮我把|帮我|给我|请|你)\s*(分析|创建|删除|打开|关闭|运行|执行|启动|停止|复制|移动|修改|设置|安装|写|保存|搜索|查询|截屏|截图|下载|上传)/i,
      /^(分析|统计|比较|创建|删除|打开|关闭|运行|执行|启动|停止|复制|移动|修改|设置|安装|写|保存|搜索|查询|截屏|截图)\s*.{2,}/i,
      /(帮我|给我|替我)\s*.{3,}/i,
      /^(please )?(create|delete|open|close|run|execute|start|stop|copy|move|set|install|write|save|search|find|screenshot)\s/i,
    ];
    return patterns.some(p => p.test(message));
  }

  _heuristicAnalysis(message) {
    if (this._isInformationQuestion(message)) {
      return this._makeAnalysis('chat', 'simple', {
        guard: 'heuristic_rephrase',
        confidence: 0.95,
      });
    }

    let intent = 'chat';
    let complexity = 'simple';
    let confidence = 0.5;

    if (this._isExplicitCommand(message)) {
      intent = 'control';
      confidence = 0.9;
    }

    complexity = message.length > 150 ? 'complex' : message.length > 50 ? 'medium' : 'simple';

    return this._makeAnalysis(intent, complexity, {
      confidence,
      summary: message.substring(0, 80),
      requiresTools: intent === 'control',
    });
  }

  async _llmIntentAnalysis(userMessage, heuristic) {
    if (!this.llmAdapter) return heuristic;

    try {
      const response = await this.llmAdapter.chat([
        {
          role: 'system',
          content: `分析用户意图，返回 JSON：{"intent":"query|control|task|config|chat","complexity":"simple|medium|complex","requiresTools":true/false,"summary":"一句话总结"}

规则：
- "如何/怎么/什么/为什么"等疑问 → chat, requiresTools=false
- "帮我做X""创建文件""运行命令"等指令 → requiresTools=true
- 涉及实际操作（创建/删除/修改/运行）→ requiresTools=true
- 不确定时，倾向于 requiresTools=true`,
        },
        { role: 'user', content: `分析: "${userMessage}"` },
      ], { temperature: 0.1, maxTokens: 256 });

      const cleaned = response.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return this._makeAnalysis(
        parsed.intent || 'chat',
        parsed.complexity || 'simple',
        {
          confidence: parsed.confidence || 0.7,
          summary: parsed.summary || '',
          requiresTools: parsed.requiresTools === true,
        }
      );
    } catch (e) {
      return heuristic;
    }
  }

  _makeAnalysis(intent, complexity, extra = {}) {
    return {
      intent,
      complexity: complexity || 'simple',
      requiresTools: extra.requiresTools || false,
      confidence: extra.confidence || 0.5,
      summary: extra.summary || '',
      guard: extra.guard || null,
    };
  }

  // 流式处理

  async processMessageStream(userMessage, callbacks = {}) {
    const startTime = Date.now();
    const { onChunk, onToolCall, onDone, onError } = callbacks;

    try {
      const analysis = await this._analyzeIntent(userMessage);
      let memoryContext = null;
      if (this.memoryPipeline) {
        try {
          memoryContext = await this.memoryPipeline.buildContext(userMessage, { topK: 5 });
        } catch (e) { console.warn(`[cc_mode] Unhandled error: ${e.message}`); }
      }

      const tools = this.toolRegistry.getToolSchemasForAPI();
      const systemContent = this.contextManager.buildSystemContext({ analysis, memoryContext, tools });

      const messages = [
        { role: 'system', content: systemContent },
        ...this.contextManager.getHistory({ maxMessages: 20 }),
        { role: 'user', content: userMessage },
      ];

      let fullContent = '';
      let allToolCalls = [];

      // 第一次 LLM 调用（可能带流式）
      if (this.llmAdapter?.streamChat) {
        await this.llmAdapter.streamChat(messages, (chunk) => {
          fullContent += chunk;
          if (onChunk) onChunk(chunk);
        }, {
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
        });
      } else {
        const result = await this._callLLM(messages, tools);
        fullContent = result.content || '';
        allToolCalls = result.toolCalls || [];
        if (onChunk) onChunk(fullContent);
      }

      // 处理 tool calls
      if (allToolCalls.length > 0) {
        for (const tc of allToolCalls) {
          if (onToolCall) onToolCall(tc);
          const toolCtx = new ToolUseContext({
            llmAdapter: this.llmAdapter,
            memoryPipeline: this.memoryPipeline,
            taskManager: this.taskManager,
          });
          await this.toolRegistry.executeToolCall({
            name: tc.function?.name || tc.name,
            input: this._parseToolInput(tc.function?.arguments || tc.input),
            id: tc.id,
          }, toolCtx);
        }
      }

      this.contextManager.addMessage('user', userMessage);
      this.contextManager.addMessage('assistant', fullContent);

      if (onDone) onDone({ response: fullContent, duration: Date.now() - startTime });
    } catch (error) {
      this.stats.apiErrors++;
      if (onError) onError(error);
    }
  }

  // 统计

  getStats() {
    return {
      totalQueries: this.stats.totalQueries,
      totalToolCalls: this.totalToolCalls,
      apiErrors: this.stats.apiErrors,
      toolErrors: this.stats.toolErrors,
      totalDuration: this.stats.totalDuration,
      contextManager: this.contextManager.getStats(),
    };
  }
}

module.exports = QueryEngine;
