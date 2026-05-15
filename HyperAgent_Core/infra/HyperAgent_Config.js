/**
 * JingxuanAgent_Config.js — 环境变量安全配置
 *
 * 优先级: JingxuanAgent_Ultimate_Config.js > process.env > 默认值
 */

let ultimateConfig = null;
try {
    ultimateConfig = require('./JingxuanAgent_Ultimate_Config.js');
    console.log('[Config] 已加载终极版配置 v' + (ultimateConfig.version || '5.0'));
} catch (e) {
    // 终极版配置不可用，使用内置配置
}

// 从 .env 文件加载
try {
    const dotenv = require('dotenv');
    dotenv.config();
} catch (e) { console.warn(`[infra] Unhandled error: ${e.message}`); }

function env(key, defaultValue) {
    return process.env[key] !== undefined ? process.env[key] : defaultValue;
}

// 如果终极版配置可用，合并并导出
if (ultimateConfig) {
    module.exports = ultimateConfig;
} else {
    module.exports = {
    llm: {
        // 主适配器: deepseek / glm / minimax / qwen / mock
        adapter: env('LLM_ADAPTER', 'deepseek'),

        // 多模型调度配置
        multiModel: {
            enabled: env('MULTI_MODEL_ENABLED', 'true') === 'true',
            costOptimization: env('MULTI_MODEL_COST_OPT', 'true') === 'true',
            defaultModel: env('MULTI_MODEL_DEFAULT', ''),
            models: {
                'deepseek-flash': {
                    adapter: 'deepseek',
                    priority: 10,
                    costPer1K: 0.3,
                    capabilities: ['chat', 'analysis'],
                    maxTokens: 8192,
                    strengths: ['速度', '推理'],
                    config: {
                        model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
                        apiKey: env('DEEPSEEK_API_KEY') || env('ANTHROPIC_AUTH_TOKEN', ''),
                        baseUrl: env('DEEPSEEK_BASE_URL') || env('ANTHROPIC_BASE_URL', 'https://api.deepseek.com'),
                        reasoningEffort: 'high'
                    }
                },
                'deepseek-pro': {
                    adapter: 'deepseek',
                    priority: 8,
                    costPer1K: 0.8,
                    capabilities: ['chat', 'analysis'],
                    maxTokens: 16384,
                    strengths: ['深度分析', '复杂推理'],
                    config: {
                        model: 'deepseek-v4-pro',
                        apiKey: env('DEEPSEEK_API_KEY') || env('ANTHROPIC_AUTH_TOKEN', ''),
                        baseUrl: env('DEEPSEEK_BASE_URL') || env('ANTHROPIC_BASE_URL', 'https://api.deepseek.com'),
                        reasoningEffort: 'high'
                    }
                },
                'glm': {
                    adapter: 'glm',
                    priority: 6,
                    costPer1K: 0.4,
                    capabilities: ['chat'],
                    maxTokens: 8192,
                    strengths: ['中文理解'],
                    config: {
                        apiKey: env('GLM_API_KEY', ''),
                        baseUrl: env('GLM_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
                        model: env('GLM_MODEL', 'glm-4.7-flash'),
                        maxTokens: 8192,
                        temperature: 0.7
                    }
                },
                'qwen': {
                    adapter: 'qwen',
                    priority: 5,
                    costPer1K: 0.2,
                    capabilities: ['chat'],
                    maxTokens: 8192,
                    strengths: ['低成本'],
                    config: {
                        apiKey: env('QWEN_API_KEY', ''),
                        baseUrl: env('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
                        model: env('QWEN_MODEL', 'qwen-plus')
                    }
                },
                'minimax': {
                    adapter: 'minimax',
                    priority: 4,
                    costPer1K: 0.35,
                    capabilities: ['chat'],
                    maxTokens: 8192,
                    strengths: ['创意'],
                    config: {
                        apiKey: env('MINIMAX_API_KEY', ''),
                        baseUrl: env('MINIMAX_BASE_URL', 'https://api.minimax.chat/v1'),
                        model: env('MINIMAX_MODEL', 'MiniMax-Text-01'),
                        maxRetries: 2
                    }
                }
            }
        },

        glm: {
            apiKey: env('GLM_API_KEY', ''),
            baseUrl: env('GLM_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
            model: env('GLM_MODEL', 'glm-4.7-flash'),
            maxTokens: 8192,
            temperature: 0.7
        },

        minimax: {
            apiKey: env('MINIMAX_API_KEY', ''),
            baseUrl: env('MINIMAX_BASE_URL', 'https://api.minimax.chat/v1'),
            model: env('MINIMAX_MODEL', 'MiniMax-Text-01'),
            maxRetries: 2,
            fallback: {
                apiKey: env('MINIMAX_FALLBACK_KEY', ''),
                baseUrl: env('MINIMAX_FALLBACK_URL', 'https://api.deepseek.com'),
                model: env('MINIMAX_FALLBACK_MODEL', 'deepseek-v4-pro')
            }
        },

        deepseek: {
            apiKey: env('DEEPSEEK_API_KEY') || env('ANTHROPIC_AUTH_TOKEN', ''),
            baseUrl: env('DEEPSEEK_BASE_URL') || env('ANTHROPIC_BASE_URL', 'https://api.deepseek.com'),
            model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash')
        },

        qwen: {
            apiKey: env('QWEN_API_KEY', ''),
            baseUrl: env('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
            model: env('QWEN_MODEL', 'qwen-plus')
        }
    },

    // Web 服务器认证 Token (留空 = 不启用认证)
    authToken: env('HYPERAGENT_AUTH_TOKEN', ''),

    // 权限系统配置
    permission: {
        defaultLevel: env('PERM_DEFAULT_LEVEL', 'info'),  // none / info / control / admin
        sessionTimeout: parseInt(env('PERM_SESSION_TIMEOUT', '3600')), // 会话授权超时(秒)
        requireConfirmForDangerous: env('PERM_CONFIRM_DANGEROUS', 'true') === 'true',
        maxPendingRequests: parseInt(env('PERM_MAX_PENDING', '5')),
    },

    // 承载体配置
    device: {
        type: env('DEVICE_TYPE', 'pc'),
        safetyLevel: env('SAFETY_LEVEL', 'medium'),
        stateInterval: parseInt(env('STATE_COLLECT_INTERVAL', '30000'))
    },

    // 协调器配置
    orchestrator: {
        maxRetries: 3,
        retryDelay: 1000,
        maxReflectLoop: 2,
        timeout: 30000
    },

    // 本地小模型配置 (Local Inference Engine)
    // 通过 ollama 运行本地小模型，实现离线推理、自动记忆、持续进化
    localInference: {
        enabled: env('LOCAL_INFERENCE_ENABLED', 'true') === 'true',
        ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434'),
        model: env('LOCAL_MODEL', 'qwen2.5:1.5b'),       // 推理模型 (1.5B 轻量)
        embedModel: env('LOCAL_EMBED_MODEL', 'nomic-embed-text'), // 嵌入模型
        timeout: 30000
    },

    // 持续学习引擎配置 (Continual Learner)
    continualLearning: {
        enabled: env('CONTINUAL_LEARNING_ENABLED', 'true') === 'true',
        absorbInterval: parseInt(env('LEARN_ABSORB_INTERVAL', '60000')),    // 吸收环: 1分钟
        analyzeInterval: parseInt(env('LEARN_ANALYZE_INTERVAL', '300000')), // 分析环: 5分钟
        evolveInterval: parseInt(env('LEARN_EVOLVE_INTERVAL', '900000')),   // 进化环: 15分钟
        learningDir: env('LEARNING_DATA_DIR', 'learning_data')
    },

    // 自建认知框架配置 (Cognitive Framework)
    cognitiveFramework: {
        enabled: env('COGNITIVE_FRAMEWORK_ENABLED', 'true') === 'true',
        storageDir: env('COGNITIVE_STORAGE_DIR', './experience_store'),
        carrierType: env('CARRIER_TYPE', 'pc'),
        debug: env('COGNITIVE_DEBUG', 'false') === 'true'
    },

    // 记忆系统配置
    memory: {
        pageLimit: 500,
        maxHistory: 50,
        autoPromote: true,
        promotionThreshold: 3,
        // Embedding 配置
        embedding: {
            mode: env('EMBEDDING_MODE', 'hybrid'),
            model: env('EMBEDDING_MODEL', 'text-embedding-3-small'),
            apiUrl: env('EMBEDDING_API_URL', ''),
            apiKey: env('EMBEDDING_API_KEY', ''),
            dimension: parseInt(env('EMBEDDING_DIMENSION', '1536')),
            batchSize: parseInt(env('EMBEDDING_BATCH_SIZE', '20')),
            cacheSize: parseInt(env('EMBEDDING_CACHE_SIZE', '5000'))
        }
    },

    // 执行器配置
    executor: {
        defaultTimeout: 30000,
        maxLogSize: 1000
    },

    // 插件配置
    plugins: {
        autoLoad: true,
        pluginDir: 'plugins'
    },

    // MCP 服务器配置
    // 电脑操控功能默认关闭，需用户在对话框中明确授权后统一激活。
    // Shell 服务器已内置安全限制（阻止关机/格式化等危险命令）。
    mcpServers: {
        // 文件系统 — 读/写/编辑/搜索/移动文件
        filesystem: {
            command: 'node',
            args: [
                require('path').join(__dirname, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'),
                process.env.USERPROFILE || 'C:\\Users\\13717'
            ]
        },

        // Shell 命令 — 执行系统操作，内置安全限制
        shell: {
            command: 'node',
            args: [
                require('path').join(__dirname, 'JingxuanAgent_Core', 'mcp_client', 'mcp_server_shell.js')
            ]
        },

        // 浏览器自动化 — 网页操作/截图，使用 puppeteer
        puppeteer: {
            command: 'node',
            args: [
                require('path').join(__dirname, 'node_modules', '@modelcontextprotocol', 'server-puppeteer', 'dist', 'index.js')
            ]
        }
    },

    // 升级模块配置
    // 每个模块可通过环境变量启用/禁用
    upgrade: {
        // 记忆模块
        audnConsolidator: env('UPGRADE_AUDN', 'true') === 'true',
        audnBatchSize: parseInt(env('UPGRADE_AUDN_BATCH', '10')),
        audnInterval: parseInt(env('UPGRADE_AUDN_INTERVAL', '120000')),
        memoryBlocks: env('UPGRADE_MEMBLOCKS', 'true') === 'true',
        bitemporalGraph: env('UPGRADE_BITEMPORAL', 'true') === 'true',
        hierarchicalRAG: env('UPGRADE_HIERARCHICAL_RAG', 'true') === 'true',

        // 决策模块
        treeOfThoughts: env('UPGRADE_TOT', 'true') === 'true',
        skillLibrary: env('UPGRADE_SKILLS', 'true') === 'true',
        mctsPlanner: env('UPGRADE_MCTS', 'false') === 'true',

        // 交互模块
        groupChat: env('UPGRADE_GROUPCHAT', 'false') === 'true',
        groupChatMode: env('UPGRADE_GROUPCHAT_MODE', 'round_robin'),
        adversarialCheck: env('UPGRADE_ADVERSARIAL', 'true') === 'true',
        adversarialDepth: env('UPGRADE_ADVERSARIAL_DEPTH', 'quick'),
        personaInjection: env('UPGRADE_PERSONA', 'true') === 'true',

        // 感知与执行模块
        screenAgent: env('UPGRADE_SCREEN', 'true') === 'true',
        codeActMode: env('UPGRADE_CODEACT', 'false') === 'true',
        durableWorkflow: env('UPGRADE_DURABLE', 'true') === 'true',
    }
};
} // end else block (fallback to built-in config)
