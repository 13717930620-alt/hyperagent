// LocalInferenceEngine — built-in local inference engine
class LocalInferenceEngine {
    constructor(options = {}) {
        // 后端模式: 'builtin' | 'ollama'
        this.mode = options.mode || 'builtin';

        // Ollama 配置（仅 mode='ollama' 时使用）
        this.ollamaUrl = options.ollamaUrl || 'http://localhost:11434';
        this.ollamaModel = options.model || 'qwen2.5:1.5b';
        this.ollamaEmbedModel = options.embedModel || 'nomic-embed-text';

        // 内置模型配置
        this.model = options.model || 'builtin-default';
        this.embedModel = options.embedModel || 'builtin-ngram';
        this.timeout = options.timeout || 30000;

        // 内置分类器类别库（预置的知识类别，带权重和子类别）
        this._categories = {
            '编程开发': { keywords: ['代码', '程序', '函数', 'API', 'bug', 'debug', '部署', 'git', 'npm', 'node', 'python', 'javascript', 'class', 'module', 'import', 'async', 'promise', '变量', '循环', '递归', '算法', '编译', '接口', '依赖', '包管理', '测试', '单元测试', '重构', '提交', '分支', '合并', 'CI', '流水线', 'docker', '容器', 'sdk', '框架', '前端', '后端', '数据库', 'sql', '查询', 'hook', '回调', '异步'], weight: 1.0 },
            '文件操作': { keywords: ['文件', '目录', '路径', '读写', '删除', '复制', '移动', '重命名', '搜索', '查找', '创建', '打开', '保存', '备份', '解压', '压缩', '上传', '下载', '挂载', '权限', 'chmod', '递归遍历', '通配符', 'glob', '文本', '二进制', '编码', 'utf'], weight: 1.0 },
            '系统管理': { keywords: ['进程', '服务', '系统', '配置', '注册表', 'CPU', '内存', '磁盘', '网络', '防火墙', '端口', '守护进程', 'systemd', '开机启动', '日志', 'syslog', '事件', '任务计划', '定时任务', 'cron', '环境变量', 'PATH', '内核', '驱动', '更新', '补丁'], weight: 1.0 },
            '数据分析': { keywords: ['数据', '分析', '统计', '报告', '图表', '可视化', '趋势', '对比', '汇总', '指标', '均值', '中位数', '标准差', '分布', '频率', '回归', '聚类', '分类', '预测', '模型', '训练', '特征', '样本', '异常检测', '相关系数', 'p值', '置信区间'], weight: 1.0 },
            '网络通信': { keywords: ['HTTP', '请求', 'API', 'URL', '服务器', '客户端', 'WebSocket', 'REST', 'JSON', 'TCP', 'UDP', 'DNS', '路由', '代理', '负载均衡', '证书', 'SSL', 'TLS', '加密', '鉴权', 'token', 'session', 'cookie', 'header', '状态码', 'get', 'post', 'put', 'delete', 'websocket'], weight: 1.0 },
            '用户交互': { keywords: ['对话', '聊天', '问题', '回答', '帮助', '解释', '建议', '推荐', '设置', '配置', '偏好', '自定义', '反馈', '评价', '命令', '指令', '语音', '界面', '快捷键', '提示'], weight: 1.0 },
            '错误处理': { keywords: ['错误', '失败', '异常', '崩溃', '超时', '拒绝', '无效', '无法', 'bug', '越界', '空指针', '未定义', '权限不足', '连接断开', '超时', '堆栈', 'trace', '异常栈', '熔断', '降级', '重试', '回滚'], weight: 1.0 },
            '系统状态': { keywords: ['CPU', '内存', '磁盘', '负载', '进程', '运行', '状态', '性能', '资源', '吞吐量', '延迟', '响应时间', 'QPS', 'IO', '带宽', '饱和度', '可用性', '健康检查', '探活', '监控', '告警', '阈值'], weight: 1.0 },
            '安全风控': { keywords: ['安全', '风险', '漏洞', '攻击', '注入', 'xss', 'csrf', '越权', '认证', '授权', '加密', '解密', '哈希', '签名', '证书', '防火墙', '入侵', '检测', '审计', '合规', '隐私', '脱敏', '权限控制'], weight: 1.0 },
            '项目管理': { keywords: ['项目', '任务', '进度', '里程碑', '迭代', '冲刺', '需求', '评审', '排期', '优先级', '阻塞', '风险', '资源', '人力', '沟通', '会议', '周报', '汇报', 'OKR', 'KPI', '目标', '交付'], weight: 1.0 }
        };

        // 实体提取模式库
        this._entityPatterns = [
            // 中文人名（2-4字）
            { type: 'person', pattern: /([一-鿿]{2,4}(?:先生|女士|老师|同学|总|经理|工|阿[一-鿿]))/g },
            { type: 'person', pattern: /([一-鿿]{2,3})(?:说|表示|提出|认为|强调|指出|提到|回应|解释|补充|认为)/g },
            { type: 'person', pattern: /(?:由|经|通过|让|请|叫)([一-鿿]{2,3})(?:来|做|处理|负责|参与|完成)/g },
            // 组织机构
            { type: 'organization', pattern: /([一-鿿]{2,}(?:公司|集团|组织|团队|部门|委员会|学院|大学|研究院|实验室|中心|局|处|科|室|厂|社))(?:\s|$|[，。、；：])/g },
            // 技术概念（英文专业术语）
            { type: 'concept', pattern: /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g },
            { type: 'concept', pattern: /\b([a-z]{2,}(?:OS|QL|ML|AI|API|SDK|IDE|DBMS?|CDN|DNS|UIX|ORM|AST))\b/gi },
            // 文件路径
            { type: 'file', pattern: /(?:[a-zA-Z]:\\[^\s,;"]+)/g },
            { type: 'file', pattern: /(?:\/[^\s,;"]+\/[^\s,;"]+)/g },
            // 版本号
            { type: 'version', pattern: /\b(\d+\.\d+\.\d+[\w\-\.]*)\b/g },
            // URL
            { type: 'url', pattern: /(https?:\/\/[^\s]+)/g },
            // 电子邮件
            { type: 'email', pattern: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g },
            // IP地址
            { type: 'ip', pattern: /\b((?:\d{1,3}\.){3}\d{1,3})\b/g },
            // 中国手机号
            { type: 'phone', pattern: /\b(1[3-9]\d{9})\b/g },
            // 日期（YYYY-MM-DD 或 YYYY年MM月DD日）
            { type: 'date', pattern: /\b(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)\b/g },
            { type: 'date', pattern: /(?:今|昨|明|前|后)(?:天|日)/g },
            // 金额
            { type: 'currency', pattern: /([¥￥$€£]\s*\d+(?:\.\d{1,2})?)/g },
            { type: 'currency', pattern: /(\d+(?:\.\d{1,2})?\s*[元美元欧元英镑])/g },
            // 百分比
            { type: 'percentage', pattern: /\b(\d+(?:\.\d+)?%)\b/g },
        ];

        // 意图模式库（用于 chat 方法）
        this._intentPatterns = {
            summarize: ['摘要', '总结', '概括', 'summarize', 'summary', '简述', '提炼', '浓缩', '归纳'],
            classify: ['分类', '归类', '类别', 'classify', 'categorize', '类型', '属于哪', '划分'],
            entity: ['实体', '提取', 'extract', 'entity', '识别', '找出', '抽取', '名词', '命名实体'],
            compare: ['比较', '对比', '差异', '区别', 'compare', 'diff', 'different', '差别', '异同', '优劣'],
            analyze: ['分析', 'analyze', '评估', '评价', '诊断', '剖析', '解读', '洞察'],
            explain: ['解释', '说明', '什么是', '意思是', '含义', 'explain', '含义', '概念', '原理', '机制'],
            plan: ['计划', '规划', '步骤', '方案', '流程', 'sop', '路线图', '路线', '策略', '安排'],
            search: ['搜索', '查找', '搜索', '寻找', '查询', '搜一下', 'find', 'search', 'lookup'],
            greet: ['你好', '您好', 'hi', 'hello', 'hey', '在吗', '早上好', '下午好', '晚上好', '嗨'],
            status: ['状态', '情况', '现状', '概况', '快照', 'status', 'overview', 'report'],
        };

        // 响应模板
        this._responseTemplates = {
            summarize: (input) => this.summarize(input),
            classify: (input) => {
                const cats = Object.keys(this._categories);
                const result = this._builtinClassify(input, cats);
                const score = this._lastClassifyScore || 0;
                const confidence = score > 0.3 ? '高' : (score > 0.1 ? '中' : '低');
                return `分类结果：${result}（置信度：${confidence}）`;
            },
            entity: (input) => {
                const entities = this._builtinExtractEntities(input);
                if (entities.length > 0) {
                    const grouped = {};
                    for (const e of entities) {
                        if (!grouped[e.type]) grouped[e.type] = [];
                        grouped[e.type].push(e.name);
                    }
                    const lines = Object.entries(grouped)
                        .map(([type, names]) => `  ${type}(${names.length}个): ${names.join('、')}`)
                        .join('\n');
                    return `识别到${entities.length}个实体：\n${lines}`;
                }
                return '未识别到明显实体。';
            },
            analyze: (input) => this._builtinAnalyze(input, 'general'),
            compare: (input) => `比较分析：${input.substring(0, 100)}...（需要两组数据做对比）`,
            explain: (input) => {
                const topic = input.replace(/解释|说明|什么是|意思|含义|概念|原理/gi, '').trim().substring(0, 50);
                return `关于「${topic}」的简要说明：这是用户询问的概念。建议连接外部LLM获取更深入的解释。内置模式可进行文本分析、分类和摘要。`;
            },
            plan: (input) => {
                const task = input.replace(/计划|规划|步骤|方案|流程/gi, '').trim().substring(0, 60);
                return `针对「${task}」的规划建议：\n1. 明确目标和范围\n2. 分解为可执行的子任务\n3. 按优先级排序\n4. 逐步执行并验证\n5. 总结与复盘\n\n如需详细步骤，建议连接外部LLM进一步分析。`;
            },
            search: (input) => {
                const query = input.replace(/搜索|查找|搜一下|查询|search/gi, '').trim().substring(0, 50);
                return `收到搜索请求：「${query}」。内置模式不支持实时搜索。如需查询信息，请在配置LLM后重试。`;
            },
            greet: () => {
                const greetings = [
                    '你好！我是 HyperAgent 内置助手。我可以帮你做文本分析、分类、摘要、实体提取等工作，有什么需要帮助的吗？',
                    '嗨！随时为你服务。我可以处理文本分析、分类、摘要、实体识别等任务。',
                    '你好！HyperAgent 已就绪。内置引擎支持分析、分类、摘要和实体提取等功能。'
                ];
                return greetings[Math.floor(Math.random() * greetings.length)];
            },
            status: (input) => {
                return `当前状态概要：\n- 运行模式：内置引擎(built-in)\n- 可用分类：${Object.keys(this._categories).join('、')}\n- 支持功能：摘要、分类、实体提取、文本分析、嵌入生成\n- 处理统计：共${this._stats.totalCalls}次调用，${this._stats.failedCalls}次失败`;
            },
        };

        this._ready = false;
        this._stats = {
            totalCalls: 0,
            failedCalls: 0,
            avgLatency: 0,
            mode: this.mode,
            backend: 'builtin'
        };

        // Ollama 状态（仅 ollama 模式）
        this._ollamaReady = false;
        this._capabilities = {
            chat: true,
            embed: true,
            hasModel: true,
            hasEmbed: true,
            availableModels: ['builtin']
        };
    }

    async init() {
        if (this.mode === 'ollama') {
            return this._initOllama();
        }
        // builtin 模式立即就绪
        this._ready = true;
        this._capabilities = {
            chat: true,
            embed: true,
            hasModel: true,
            hasEmbed: true,
            availableModels: ['builtin-ngram-v1']
        };
        console.log(`[LocalInference] Built-in engine READY (chat + embed + classify + summarize)`);
        return true;
    }

    async _initOllama() {
        try {
            const http = require('http');
            const https = require('https');
            const url = new URL(this.ollamaUrl);

            const available = await new Promise((resolve) => {
                const opts = {
                    hostname: url.hostname,
                    port: url.port,
                    path: '/api/tags',
                    method: 'GET',
                    timeout: 5000
                };
                const client = url.protocol === 'https:' ? https : http;
                const req = client.request(opts, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); }
                        catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
                req.end();
            });

            if (available && available.models && available.models.length > 0) {
                const modelNames = available.models.map(m => m.name);
                this._ollamaReady = true;
                this._capabilities = {
                    chat: modelNames.some(n => n.startsWith(this.ollamaModel.split(':')[0])),
                    embed: modelNames.some(n => n.startsWith(this.ollamaEmbedModel.split(':')[0])),
                    hasModel: true,
                    hasEmbed: true,
                    availableModels: modelNames
                };
                this._ready = true;
                console.log(`[LocalInference] Ollama backend READY (${modelNames.length} models available)`);
                return true;
            }
        } catch (e) {
            console.warn('[LocalInference] Ollama init failed:', e.message);
        }

        // Ollama 不可用，回退到 builtin
        console.warn('[LocalInference] Ollama not available, falling back to built-in engine');
        this.mode = 'builtin';
        this._ready = true;
        this._capabilities = {
            chat: true, embed: true, hasModel: true, hasEmbed: true,
            availableModels: ['builtin-ngram-v1']
        };
        return true;
    }

    isReady() { return this._ready; }
    getCapabilities() { return { ...this._capabilities, mode: this.mode }; }
    getStats() {
        return {
            ...this._stats,
            model: this.mode === 'ollama' ? this.ollamaModel : 'builtin-default',
            embedModel: this.mode === 'ollama' ? this.ollamaEmbedModel : 'builtin-ngram'
        };
    }

    // 公用入口：根据后端模式分发

    async generateEmbedding(text) {
        this._timedCall('embed');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady) {
            try {
                const result = await this._ollamaEmbed(text);
                this._recordLatency(start);
                return result;
            } catch (e) { /* fallthrough */ }
        }
        const result = this._builtinEmbedding(text);
        this._recordLatency(start);
        return result;
    }

    async chat(messages, options = {}) {
        this._timedCall('chat');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const result = await this._ollamaChat(messages, options);
                this._recordLatency(start);
                return result;
            } catch (e) { /* fallthrough */ }
        }
        const result = this._builtinChat(messages);
        this._recordLatency(start);
        return result;
    }

    async summarize(text) {
        this._timedCall('summarize');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const msgs = [
                    { role: 'system', content: 'Summarize concisely in Chinese, 3 sentences max.' },
                    { role: 'user', content: text.substring(0, 2048) }
                ];
                const result = await this._ollamaChat(msgs, { maxTokens: 256 });
                this._recordLatency(start);
                return result;
            } catch (e) {
                console.warn('[LocalInference] Ollama summarize failed:', e.message);
            }
        this._recordLatency(start);
        return result;
    }

    async classify(text, categories) {
        this._timedCall('classify');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const catList = Array.isArray(categories) ? categories.join(', ') : categories;
                const msgs = [
                    { role: 'system', content: `你是一个分类器。从以下类别中选择一个最匹配的，只输出类别名称：${catList}` },
                    { role: 'user', content: text.substring(0, 1024) }
                ];
                const result = await this._ollamaChat(msgs, { temperature: 0.1, maxTokens: 32 });
                this._recordLatency(start);
                return result;
            } catch (e) {
                console.warn('[LocalInference] Ollama classify failed:', e.message);
            }
        this._recordLatency(start);
        return result;
    }

    async extractEntities(text) {
        this._timedCall('extract');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const msgs = [
                    { role: 'system', content: 'Extract named entities. Return JSON array: [{"type":"...","name":"..."}]' },
                    { role: 'user', content: text.substring(0, 1024) }
                ];
                const result = await this._ollamaChat(msgs, { temperature: 0.1, maxTokens: 256 });
                const jsonMatch = result.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    this._recordLatency(start);
                    return JSON.parse(jsonMatch[0]);
                }
            } catch (e) {
                console.warn('[LocalInference] Ollama entity extract failed:', e.message);
            }
        this._recordLatency(start);
        return result;
    }

    async analyze(text, task = 'analyze') {
        this._timedCall('analyze');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const msgs = [
                    { role: 'system', content: `你是数据分析引擎。Task: ${task}。输出结构化中文结论，不超过100字。` },
                    { role: 'user', content: text.substring(0, 2048) }
                ];
                const result = await this._ollamaChat(msgs, { maxTokens: 256 });
                this._recordLatency(start);
                return result;
            } catch (e) {
                console.warn('[LocalInference] Ollama analyze failed:', e.message);
            }
        this._recordLatency(start);
        return result;
    }

    async compare(current, previous) {
        this._timedCall('compare');
        const start = Date.now();
        if (this.mode === 'ollama' && this._ollamaReady && this._capabilities.chat) {
            try {
                const msgs = [
                    { role: 'system', content: '比较两组数据的变化，输出关键差异和趋势。中文，不超过100字。' },
                    { role: 'user', content: `Before:\n${JSON.stringify(previous)}\n\nAfter:\n${JSON.stringify(current)}` }
                ];
                const result = await this._ollamaChat(msgs, { maxTokens: 128 });
                this._recordLatency(start);
                return result;
            } catch (e) {
                console.warn('[LocalInference] Ollama compare failed:', e.message);
            }
        this._recordLatency(start);
        return result;
    }

    // 内置实现：文本嵌入

    _builtinEmbedding(text) {
        const dim = 384;
        const vec = new Float64Array(dim);
        const str = text.toLowerCase();
        const totalGrams = {};

        // 提取 1-3 gram 并计算 TF
        for (let n = 1; n <= 3; n++) {
            for (let i = 0; i <= str.length - n; i++) {
                const gram = str.substring(i, i + n);
                const hash = this._hashCode(gram);
                const idx = Math.abs(hash) % dim;
                // TF 加权：短 gram 权重低，长 gram 权重高
                const weight = n * (1 / (1 + Math.abs(hash % 7)));
                vec[idx] += weight;
                totalGrams[gram] = (totalGrams[gram] || 0) + 1;
            }
        }

        //  IDF 近似：罕见 gram 加权
        const uniqueGrams = Object.keys(totalGrams).length;
        for (let i = 0; i < dim; i++) {
            if (vec[i] > 0) {
                vec[i] *= Math.log1p(uniqueGrams);
            }
        }

        // L2 归一化
        const norm = Math.sqrt(Array.from(vec).reduce((s, v) => s + v * v, 0));
        if (norm > 0) {
            for (let i = 0; i < dim; i++) vec[i] /= norm;
        }

        return Array.from(vec);
    }

    // 内置实现：聊天/对话

    _builtinChat(messages) {
        const lastMsg = messages[messages.length - 1];
        const content = (lastMsg?.content || '').toLowerCase();
        const allContent = messages.map(m => (m.content || '')).join('\n');

        // 检查 system prompt 中的任务类型
        const systemMsg = messages.find(m => m.role === 'system');
        const sysContent = (systemMsg?.content || '').toLowerCase();

        // 摘要请求
        if (sysContent.includes('summar') || sysContent.includes('摘要') || sysContent.includes('概括')) {
            return this._builtinSummarize(allContent);
        }

        // 分类请求
        if (sysContent.includes('classif') || sysContent.includes('分类')) {
            const catMatch = sysContent.match(/(?:类别|categories|from):?\s*([^。\n]+)/);
            const cats = catMatch ? catMatch[1].split(/[,，、\s]+/).filter(Boolean) : Object.keys(this._categories);
            const textToClassify = messages.find(m => m.role === 'user')?.content || '';
            return this._builtinClassify(textToClassify, cats);
        }

        // 实体提取请求
        if (sysContent.includes('entity') || sysContent.includes('实体')) {
            const text = messages.find(m => m.role === 'user')?.content || '';
            const entities = this._builtinExtractEntities(text);
            return JSON.stringify(entities);
        }

        // 意图匹配
        for (const [intent, patterns] of Object.entries(this._intentPatterns)) {
            if (patterns.some(p => content.includes(p))) {
                const handler = this._responseTemplates[intent];
                if (handler) return handler(allContent);
            }
        }

        // 默认回复：基于内容的智能响应
        return this._builtinGenerateReply(messages);
    }

    _builtinGenerateReply(messages) {
        const lastMsg = messages[messages.length - 1]?.content || '';
        const text = lastMsg.toLowerCase();

        // 问题检测——带主题提取
        if (text.includes('?') || text.includes('？') || text.startsWith('what') || text.startsWith('how') || text.startsWith('why') || text.startsWith('can') || text.startsWith('does')) {
            const keywords = text.split(/\s+/).filter(w => w.length > 2).slice(0, 5);
            // 先尝试分类
            const category = this._builtinClassify(lastMsg, Object.keys(this._categories));
            if (keywords.length > 0) {
                const topic = keywords.join('、');
                return `关于「${topic}」的问题（归类：${category}）：\n\n该问题需要更深入的分析。目前内置引擎可提供以下帮助：\n1. 文本分析 — 对相关文本进行多维度分析\n2. 分类 — 判断内容所属类别\n3. 摘要 — 提炼核心内容\n4. 实体提取 — 识别关键实体\n\n如需准确回答，建议连接外部 LLM。`;
            }
            return `已收到问题（归类：${category}）。作为内置助手，我可以进行文本分析、分类、摘要和实体提取。如需更深入的答复，建议配置外部 LLM。`;
        }

        // 指令型——多意图匹配
        if (text.includes('分析') || text.includes('检查') || text.includes('评估') || text.includes('诊断')) {
            return this._builtinAnalyze(lastMsg, 'general');
        }
        if (text.includes('总结') || text.includes('摘要') || text.includes('概括') || text.includes('提炼')) {
            return this._builtinSummarize(lastMsg);
        }
        if (text.includes('分类') || text.includes('归类')) {
            const cats = Object.keys(this._categories);
            return `分类结果：${this._builtinClassify(lastMsg, cats)}`;
        }
        if (text.includes('实体') || text.includes('提取')) {
            const entities = this._builtinExtractEntities(lastMsg);
            return entities.length > 0
                ? `提取到${entities.length}个实体: ${entities.map(e => `${e.name}(${e.type})`).join(', ')}`
                : '未提取到明显实体。';
        }

        // 默认回复：简短友好的能力介绍
        return `收到！目前以内置模式运行，支持以下功能：\n· 📊 文本分析（长度、情感、可读性）\n· 🏷️ 分类（${Object.keys(this._categories).length}个预置类别）\n· 📝 摘要（TextRank 自动提取）\n· 🔍 实体提取（人名/组织/技术概念/时间/金额等）\n· 🔢 文本嵌入（384维 n-gram TF-IDF）\n\n直接告诉我你想做什么？`;
    }

    // 内置实现：自动摘要（TextRank 风格句子评分）

    _builtinSummarize(text) {
        const sentences = this._splitSentences(text);
        if (sentences.length <= 2) return text.substring(0, 200);

        // 构建句子相似度矩阵（TextRank 风格）
        const n = sentences.length;
        const similarityMatrix = Array.from({ length: n }, () => new Array(n).fill(0));

        for (let i = 0; i < n; i++) {
            const wordsI = this._tokenize(sentences[i]);
            const setI = new Set(wordsI);
            for (let j = i + 1; j < n; j++) {
                const wordsJ = this._tokenize(sentences[j]);
                const setJ = new Set(wordsJ);
                const intersection = new Set([...setI].filter(w => setJ.has(w)));
                const union = new Set([...setI, ...setJ]);
                const sim = intersection.size / Math.max(union.size, 1);
                similarityMatrix[i][j] = sim;
                similarityMatrix[j][i] = sim;
            }
        }

        // PageRank 迭代计算句子权重
        const d = 0.85; // 阻尼系数
        let scores = new Array(n).fill(1 / n);
        for (let iter = 0; iter < 30; iter++) {
            const newScores = new Array(n).fill(0);
            for (let i = 0; i < n; i++) {
                let sum = 0;
                for (let j = 0; j < n; j++) {
                    if (i !== j) {
                        const rowSum = similarityMatrix[j].reduce((a, b) => a + b, 0);
                        if (rowSum > 0) {
                            sum += similarityMatrix[j][i] / rowSum * scores[j];
                        }
                    }
                }
                newScores[i] = (1 - d) / n + d * sum;
            }
            scores = newScores;
        }

        // 位置偏置：前两句和后一句加权
        for (let i = 0; i < n; i++) {
            if (i < 2) scores[i] *= 1.3;
            if (i === n - 1) scores[i] *= 1.15;
            // 长度惩罚：太短(<15字)或太长(>300字)
            if (sentences[i].length < 15) scores[i] *= 0.4;
            if (sentences[i].length > 300) scores[i] *= 0.6;
        }

        // 选 top 句（按文本长度动态决定数量）
        const summaryLen = Math.max(2, Math.min(5, Math.ceil(n / 4)));
        const ranked = sentences.map((s, i) => ({ sentence: s, score: scores[i], index: i }))
            .sort((a, b) => b.score - a.score)
            .slice(0, summaryLen)
            .sort((a, b) => a.index - b.index);

        const summary = ranked.map(s => s.sentence).join('。');
        return summary || text.substring(0, 200);
    }

    _tokenize(text) {
        // 简单中文分词：按字符和英文单词分割
        const tokens = [];
        // 匹配中文单字/词
        const chineseChars = text.match(/[一-鿿]{1,4}/g);
        if (chineseChars) tokens.push(...chineseChars);
        // 匹配英文单词
        const englishWords = text.match(/\b[a-zA-Z]{2,}\b/g);
        if (englishWords) tokens.push(...englishWords.map(w => w.toLowerCase()));
        // 匹配数字
        const numbers = text.match(/\b\d+\b/g);
        if (numbers) tokens.push(...numbers);
        return tokens.filter(t => t.length > 0);
    }

    // 内置实现：文本分类（TF-IDF 加权 + 多级匹配）

    _builtinClassify(text, categories) {
        const catList = Array.isArray(categories) ? categories : (typeof categories === 'string' ? [categories] : Object.keys(this._categories));
        const textLower = text.toLowerCase();
        const textWords = new Set(textLower.split(/[\s,，。、；：()（）\[\]【】{}]+/).filter(w => w.length >= 2));

        let bestCategory = catList[0] || 'general';
        let bestScore = -1;
        let secondBest = { category: null, score: -1 };

        for (const cat of catList) {
            const catDef = this._categories[cat];
            const keywords = catDef ? catDef.keywords : null;
            const weight = catDef ? (catDef.weight || 1.0) : 1.0;

            if (!keywords) {
                // 未知类别，用名称本身做关键词匹配
                const catWords = cat.toLowerCase().split(/[\s_\-]+/);
                const matchCount = catWords.filter(w => textWords.has(w) || textLower.includes(w)).length;
                const score = (matchCount / Math.max(catWords.length, 1)) * weight * 0.5;
                if (score > bestScore) { secondBest = { category: bestCategory, score: bestScore }; bestScore = score; bestCategory = cat; }
                else if (score > secondBest.score) secondBest = { category: cat, score };
                continue;
            }

            // TF 分数: 关键词在文本中出现频率
            let matchCount = 0;
            let weightedSum = 0;
            for (const kw of keywords) {
                const kwLower = kw.toLowerCase();
                // 精确匹配（整个词匹配）
                if (textWords.has(kwLower)) {
                    matchCount++;
                    weightedSum += 1.0;
                } else if (textLower.includes(kwLower)) {
                    // 部分匹配（子串匹配）
                    matchCount++;
                    weightedSum += 0.6;
                }
            }

            // IDF 近似: 关键词在多少类别中出现（稀有词权重高）
            let idfSum = 0;
            for (const kw of keywords) {
                const kwLower = kw.toLowerCase();
                let categoryCount = 0;
                for (const [otherCat, otherDef] of Object.entries(this._categories)) {
                    if (otherCat === cat) continue;
                    if ((otherDef.keywords || []).some(k => k.toLowerCase().includes(kwLower) || kwLower.includes(k.toLowerCase()))) {
                        categoryCount++;
                    }
                }
                idfSum += Math.log((Object.keys(this._categories).length + 1) / (categoryCount + 1)) + 1;
            }
            const avgIdf = idfSum / Math.max(keywords.length, 1);

            // 综合得分 = 匹配率 * 权重 * IDF
            const matchRatio = weightedSum / Math.max(keywords.length, 1);
            const score = matchRatio * weight * (0.5 + avgIdf * 0.5);

            if (score > bestScore) {
                secondBest = { category: bestCategory, score: bestScore };
                bestScore = score;
                bestCategory = cat;
            } else if (score > secondBest.score) {
                secondBest = { category: cat, score };
            }
        }

        // 如果最佳与次佳差距小于15%，标记为低置信度
        const margin = bestScore - secondBest.score;
        this._lastClassifyScore = margin > 0.05 ? bestScore : bestScore * 0.5;

        return bestCategory;
    }

    // 内置实现：实体提取

    _builtinExtractEntities(text) {
        const entities = [];
        const seen = new Set();

        for (const { type, pattern } of this._entityPatterns) {
            const matches = text.matchAll(pattern);
            for (const m of matches) {
                const name = m[1] || m[0];
                if (name && name.length > 1 && !seen.has(name)) {
                    seen.add(name);
                    entities.push({ type, name: name.trim() });
                }
            }
        }

        // 技术术语提取（驼峰式 + 大写缩写）
        const techTerms = text.match(/\b([A-Z]{2,})\b/g);
        if (techTerms) {
            for (const t of techTerms) {
                if (!seen.has(t) && t.length >= 2) {
                    seen.add(t);
                    entities.push({ type: 'concept', name: t });
                }
            }
        }

        // 数字表达式提取（百分比、数值）
        const numbers = text.match(/\b(\d+[.%])\b/g);
        if (numbers) {
            for (const n of numbers) {
                if (!seen.has(n)) {
                    seen.add(n);
                    entities.push({ type: 'metric', name: n });
                }
            }
        }

        return entities;
    }

    // 内置实现：文本分析（多维度统计分析）

    _builtinAnalyze(text, task) {
        const sentences = this._splitSentences(text);
        const words = text.split(/\s+/).filter(w => w.length > 0);
        const chars = text.length;

        // 关键词提取（TF-IDF 加权）
        const wordFreq = {};
        for (const w of words) {
            const clean = w.toLowerCase().replace(/[^a-zA-Z一-鿿0-9]/g, '');
            if (clean.length > 1) wordFreq[clean] = (wordFreq[clean] || 0) + 1;
        }

        // 计算 IDF 近似
        const topKeywords = Object.entries(wordFreq)
            .map(([w, freq]) => {
                const df = sentences.filter(s => s.toLowerCase().includes(w)).length;
                const idf = Math.log((sentences.length + 1) / (df + 1)) + 1;
                return { word: w, score: freq * idf };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map(({ word, score }) => `${word}(${score.toFixed(1)})`)
            .join('、');

        // 情感倾向（扩展关键词库 + 加权）
        const sentimentLexicon = {
            positive: ['好', '优秀', '成功', '完成', '通过', '提升', '增长', '改进', '稳定', '恢复', '优势', '突破', '创新', '领先', '高效', '满意', '赞', '顺利', '达成', '进展', '利好', '突破', '增益', '增强', '优化', '改善'],
            negative: ['错误', '失败', '问题', '崩溃', '异常', '下降', '风险', '警告', '停止', '无法', '缺陷', '损坏', '丢失', '拒绝', '违规', '超时', '中断', '故障', '损失', '恶化', '延迟', '阻塞', '退化']
        };
        const posScore = sentimentLexicon.positive.reduce((sum, w) => {
            const matches = (text.match(new RegExp(w, 'g')) || []).length;
            return sum + matches;
        }, 0);
        const negScore = sentimentLexicon.negative.reduce((sum, w) => {
            const matches = (text.match(new RegExp(w, 'g')) || []).length;
            return sum + matches;
        }, 0);
        const totalSentiment = posScore + negScore;
        const sentiment = totalSentiment > 0
            ? (posScore / totalSentiment > 0.6 ? '积极' : (negScore / totalSentiment > 0.6 ? '消极' : '中性'))
            : '中性';

        // 可读性分析
        const avgSentenceLength = sentences.length > 0 ? (chars / sentences.length).toFixed(1) : '0';
        const longSentences = sentences.filter(s => s.length > 100).length;
        const shortSentences = sentences.filter(s => s.length < 20).length;
        const polysyllabicWords = words.filter(w => w.length > 6).length;
        const readabilityScore = Math.min(100, Math.max(0,
            100 - (parseFloat(avgSentenceLength) * 1.5 + (polysyllabicWords / Math.max(words.length, 1)) * 50)
        ));

        // 实体提取
        const entities = this._builtinExtractEntities(text);
        const entityTypes = {};
        for (const e of entities) {
            entityTypes[e.type] = (entityTypes[e.type] || 0) + 1;
        }

        // 复杂度分级
        const complexityScore = (chars * 0.01 + words.length * 0.05 + sentences.length * 0.1 + polysyllabicWords * 0.2);
        const complexity = complexityScore > 20 ? '较复杂' : (complexityScore > 8 ? '中等' : '简短');

        const result = [
            `文本分析结果：`,
            `- 长度：${chars}字符，${words.length}词，${sentences.length}句`,
            `- 情感倾向：${sentiment}(积极词${posScore}/消极词${negScore})`,
            `- 可读性：${readabilityScore.toFixed(0)}分（均句长${avgSentenceLength}字，长句${longSentences}句，短句${shortSentences}句）`,
            `- 关键词：${topKeywords || '无显著关键词'}`,
            `- 实体：${entities.length > 0 ? Object.entries(entityTypes).map(([t, c]) => `${t}×${c}`).join('、') : '未识别到实体'}`,
            `- 复杂度：${complexity}(词汇丰富度: ${Object.keys(wordFreq).length}/${words.length})`
        ];

        // 根据 task 调整输出
        if (task.includes('state') || task.includes('状态') || task.includes('device')) {
            const keyAreas = topKeywords ? topKeywords.substring(0, 80) : '状态稳定';
            return `承载体状态分析：${sentiment}趋势。关注点：${keyAreas}。可读性${readabilityScore.toFixed(0)}分，${complexity}。`;
        }

        return result.join('\n');
    }

    // 内置实现：差异比较（结构化 diff + 统计变化检测）

    _builtinCompare(current, previous) {
        const curStr = typeof current === 'string' ? current : JSON.stringify(current, null, 2);
        const prevStr = typeof previous === 'string' ? previous : JSON.stringify(previous, null, 2);

        const curLines = curStr.split('\n');
        const prevLines = prevStr.split('\n');

        // 改进的行 diff（保留上下文）
        const lcs = this._longestCommonSubsequence(curLines, prevLines);
        const additions = curLines.length - lcs;
        const deletions = prevLines.length - lcs;

        // 结构化变化分析
        const curKeys = new Set(curStr.match(/"\w+":/g) || []);
        const prevKeys = new Set(prevStr.match(/"\w+":/g) || []);
        const newKeys = [...curKeys].filter(k => !prevKeys.has(k));
        const removedKeys = [...prevKeys].filter(k => !curKeys.has(k));

        // 数值变化检测（独立统计每个数值字段）
        const numPattern = /(\d+\.?\d*)/g;
        const curNums = [...curStr.matchAll(numPattern)].map(m => parseFloat(m[1])).filter(n => !isNaN(n));
        const prevNums = [...prevStr.matchAll(numPattern)].map(m => parseFloat(m[1])).filter(n => !isNaN(n));

        // 统计检验：均值变化 + 分布变化
        let trend = '';
        let significantChange = false;
        if (curNums.length > 0 && prevNums.length > 0) {
            const avgCur = curNums.reduce((a, b) => a + b, 0) / curNums.length;
            const avgPrev = prevNums.reduce((a, b) => a + b, 0) / prevNums.length;
            const changeRatio = avgPrev > 0 ? (avgCur - avgPrev) / avgPrev : 0;

            if (Math.abs(changeRatio) > 0.2) {
                significantChange = true;
                trend = changeRatio > 0
                    ? `（数值整体上升${(changeRatio * 100).toFixed(0)}%）`
                    : `（数值整体下降${(Math.abs(changeRatio) * 100).toFixed(0)}%）`;
            } else {
                // 检查方差变化
                const varCur = curNums.reduce((sum, n) => sum + Math.pow(n - avgCur, 2), 0) / curNums.length;
                const varPrev = prevNums.reduce((sum, n) => sum + Math.pow(n - avgPrev, 2), 0) / prevNums.length;
                if (varPrev > 0 && varCur / varPrev > 2) {
                    significantChange = true;
                    trend = '（数值波动显著增大）';
                } else if (varPrev > 0 && varCur / varPrev < 0.5) {
                    significantChange = true;
                    trend = '（数值波动显著减小）';
                } else {
                    trend = '（数值基本持平）';
                }
            }
        } else if (curNums.length > 0 && prevNums.length === 0) {
            trend = '（新增数值数据）';
            significantChange = true;
        } else if (curNums.length === 0 && prevNums.length > 0) {
            trend = '（数值数据消失）';
            significantChange = true;
        }

        // 组成详细报告
        const parts = [`检测到${additions}处新增、${deletions}处移除${trend}`];
        if (newKeys.length > 0) parts.push(`新增字段: ${newKeys.slice(0, 3).join(', ')}`);
        if (removedKeys.length > 0) parts.push(`消失字段: ${removedKeys.slice(0, 3).join(', ')}`);
        if (significantChange) parts.push('变化幅度较大，建议关注');
        else if (additions + deletions > 5) parts.push('有较多行变化');
        else parts.push('变化较小');

        return parts.join('。');
    }

    _longestCommonSubsequence(a, b) {
        const m = a.length, n = b.length;
        if (m === 0 || n === 0) return 0;
        // 使用滚动数组优化空间
        let prev = new Array(n + 1).fill(0);
        let curr = new Array(n + 1).fill(0);
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1] + 1;
                else curr[j] = Math.max(prev[j], curr[j - 1]);
            }
            [prev, curr] = [curr, prev];
        }
        return prev[n];
    }

    // Ollama 后端

    async _ollamaChat(messages, options = {}) {
        const http = require('http');
        const url = new URL(this.ollamaUrl);
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                model: this.ollamaModel,
                messages: messages.map(m => ({
                    role: m.role || 'user',
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                })),
                stream: false,
                options: { temperature: options.temperature ?? 0.3, num_predict: options.maxTokens || 512 }
            });
            const req = http.request({
                hostname: url.hostname, port: url.port,
                path: '/api/chat', method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: this.timeout
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed.message?.content || '');
                    } catch { reject(new Error('Ollama parse error')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(data);
            req.end();
        });
    }

    async _ollamaEmbed(text) {
        const http = require('http');
        const url = new URL(this.ollamaUrl);
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({ model: this.ollamaEmbedModel, prompt: text.substring(0, 2048) });
            const req = http.request({
                hostname: url.hostname, port: url.port,
                path: '/api/embeddings', method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: this.timeout
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed.embedding);
                    } catch { reject(new Error('Ollama embed parse error')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(data);
            req.end();
        });
    }

    // 工具方法

    _splitSentences(text) {
        return text
            .replace(/([。！？.!?\n])\s*/g, '$1||')
            .split('||')
            .map(s => s.trim())
            .filter(s => s.length > 5);
    }

    _hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }

    _timedCall(name) {
        this._stats.totalCalls++;
    }

    _recordLatency(start) {
        const lat = Date.now() - start;
        this._stats.avgLatency = this._stats.avgLatency * 0.9 + lat * 0.1;
    }
}

module.exports = LocalInferenceEngine;
