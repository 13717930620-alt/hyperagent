const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');

const { ToolRegistry, ToolDefinition, ToolUseContext, createBuiltinTools, Schema }
  = require('./JingxuanAgent_Core/cc_mode/JingxuanAgent_CC_ToolSystem.js');
const CCContextManager = require('./JingxuanAgent_Core/cc_mode/JingxuanAgent_CC_ContextManager.js');
const CCQueryEngine = require('./JingxuanAgent_Core/cc_mode/JingxuanAgent_CC_QueryEngine.js');
const PluginLoader = require('./JingxuanAgent_PluginAPI.js');
const SelfLearning = require('./JingxuanAgent_Learning.js');

const { Logger, CircuitBreaker, retry, Metrics, HealthCheck, RateLimiter } = require('./JingxuanAgent_Core/infra/JingxuanAgent_Infra.js');
const Storage = require('./JingxuanAgent_Core/infra/JingxuanAgent_Storage.js');
const SecuritySandbox = require('./JingxuanAgent_Core/infra/JingxuanAgent_Security.js');

const StateManager = require('./JingxuanAgent_Implementation/state_manager/StateManager');
const MemoryManager = require('./JingxuanAgent_Implementation/memory_engine/MemoryManager');
const AtomicExecutor = require('./JingxuanAgent_Implementation/atomic_executor/AtomicExecutor');
const ToolExecutor = require('./JingxuanAgent_Implementation/atomic_executor/ToolExecutor');
const SOPGenerator = require('./JingxuanAgent_Implementation/sop_generator/SOPGenerator');
const SOPOptimizer = require('./JingxuanAgent_Implementation/sop_generator/SOPOptimizer');
const CoordinatorOrchestrator = require('./JingxuanAgent_Implementation/orchestrator/CoordinatorOrchestrator');
const PluginRegistry = require('./JingxuanAgent_Core/plugin_system/PluginRegistry');
const ContextManager = require('./JingxuanAgent_Implementation/context_manager/ContextManager');
const ConversationEngine = require('./JingxuanAgent_Implementation/conversation/ConversationEngine');
const EpisodicMemoryConsolidator = require('./JingxuanAgent_Implementation/memory_engine/EpisodicMemoryConsolidator');
const LocalInferenceEngine = require('./JingxuanAgent_Implementation/memory_engine/LocalInferenceEngine');
const ContinualLearner = require('./JingxuanAgent_Implementation/memory_engine/ContinualLearner');
const MemoryPipeline = require('./JingxuanAgent_Implementation/memory_engine/MemoryPipeline');
const WorkRecordManager = require('./JingxuanAgent_Implementation/memory_engine/WorkRecordManager');
const CognitiveFramework = require('./JingxuanAgent_Core/cognitive_core/CognitiveFramework');
const CognitiveOrchestrator = require('./JingxuanAgent_Core/cognitive_core/CognitiveOrchestrator');
const DeviceManager = require('./JingxuanAgent_Implementation/device_abstraction/DeviceManager');
const { PermissionSystem } = require('./JingxuanAgent_Implementation/permission/PermissionSystem');
const TunnelService = require('./services/TunnelService');
const ConfigManager = require('./services/ConfigManager');

let ExecutionLogger, MetricsCollector, ModelRouter, ModelFallbackChain;
try { ExecutionLogger = require('./JingxuanAgent_Monitoring/ExecutionLogger'); } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
try { MetricsCollector = require('./JingxuanAgent_Monitoring/MetricsCollector'); } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
try {
    ModelRouter = require('./JingxuanAgent_Core/llm_adapter/ModelRouter');
    ModelFallbackChain = require('./JingxuanAgent_Core/llm_adapter/ModelFallbackChain');
} catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }

const JingxuanAgentUpgradeIntegrator = require('./JingxuanAgent_Implementation/orchestrator/JingxuanAgentUpgradeIntegrator');

class JingxuanAgent {
    constructor() {
        this.version = '5.2.0';
        this.name = 'JingxuanAgent';
        this.ready = false;
        this.components = {};
        this.startTime = Date.now();
        this._computerControlEnabled = true;
        this._mcpConfig = null;
        this._tunnelService = new TunnelService();
        this._pendingConfigChange = null;
        this._pendingApiKeyProvider = null;
        this._configManager = null;
        this._permissionSystem = new PermissionSystem();
        this._authMessageCache = new Map();

        this.log = new Logger('JingxuanAgent', process.env.LOG_LEVEL || 'info');
        this.metrics = new Metrics();
        this.health = new HealthCheck();
        this.llmCircuitBreaker = new CircuitBreaker('llm', { maxFailures: 5, resetTimeout: 30000 });
        this.rateLimiter = new RateLimiter(parseInt(process.env.API_RATE_LIMIT || '60'));
        this.storage = new Storage(process.env.HYPERAGENT_DB_PATH || path.join(process.cwd(), 'data', 'hyperagent.db'));
        this.security = new SecuritySandbox();

        this.toolRegistry = new ToolRegistry();
        this.ccContextManager = new CCContextManager({
            maxHistoryMessages: 50,
            enableTimeInjection: true,
            enableToolDescriptions: true,
        });
        this.ccQueryEngine = null;
        this._ccTaskManager = {
            _tasks: new Map(),
            _id: 0,
            _storage: this.storage,
            createTask: async (params) => {
                const id = `task_${Date.now()}_${++this._ccTaskManager._id}`;
                const task = {
                    id, subject: params.subject || '', description: params.description || '',
                    status: 'pending', createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                this._ccTaskManager._tasks.set(id, task);
                // 持久化到 Storage (SQLite)
                try {
                    if (this._ccTaskManager._storage?._ready) {
                        this._ccTaskManager._storage.setKnowledge(`task:${id}`, JSON.stringify(task), 'task');
                    }
                    // 同步写入长期记忆
                    if (this.components?.memoryManager) {
                        await this.components.memoryManager.pushMemory(
                            `[任务] ${task.subject}: ${task.description}`,
                            'L2', `task_${id}`
                        );
                    }
                } catch (e) { /* 持久化失败不影响主流程 */ }
                return task;
            },
            updateTask: async (params) => {
                const task = this._ccTaskManager._tasks.get(params.taskId);
                if (!task) return { error: `Task ${params.taskId} not found` };
                if (params.status) task.status = params.status;
                task.updatedAt = new Date().toISOString();
                try {
                    if (this._ccTaskManager._storage?._ready) {
                        this._ccTaskManager._storage.setKnowledge(`task:${task.id}`, JSON.stringify(task), 'task');
                    }
                } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
                return task;
            },
            getTasks: () => Array.from(this._ccTaskManager._tasks.values()),
        };
        this.learning = null;
    }

    _validateConfig() {
        try {
            const config = require('./JingxuanAgent_Config.js');
            const adapter = (config.llm || {}).adapter || 'mock';
            if (adapter !== 'mock') {
                const provider = config.llm[adapter];
                if (!provider || !provider.apiKey) {
                    console.warn(`[JingxuanAgent] "${adapter}" selected but no API key set`);
                }
            }
        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
    }

    async init() {
        this._validateConfig();
        try {
            let config = { memory: { embedding: {} } };
            try { config = require('./JingxuanAgent_Config.js'); } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
            const embedConfig = config.memory?.embedding || {};

            this.components.stateManager = new StateManager();
            this.components.memoryManager = new MemoryManager({
                embedding: embedConfig,
                localInference: null
            });
            this.components.contextManager = new ContextManager();
            this.components.registry = new PluginRegistry();
            this.components.llmAdapter = await this._initLLM();

            this._registerCCTools();
            this.ccQueryEngine = new CCQueryEngine({
                llmAdapter: this.components.llmAdapter,
                toolRegistry: this.toolRegistry,
                contextManager: this.ccContextManager,
                memoryPipeline: null,
                permissionSystem: this._permissionSystem,
                deviceManager: null,
                stateManager: null,
                taskManager: this._ccTaskManager,
                maxToolLoops: 20,
                verbose: false,
                enableThinking: true,
            });
            this.ccContextManager.setSystemPrompt(`[核心知识]
- 你是 JingxuanAgent，运行在 Windows 电脑上
- 你能读写文件、执行命令、搜索代码、联网搜索
- Windows 路径用正斜杠 C:/Users/xxx/Desktop/file.txt

[工具执行铁律]
- 用户要求执行操作时，必须调用工具实际执行。"好的""已完成"等确认语但没调用工具 = 假成功。
- 工具结果以磁盘/系统实际情况为准，不允许捏造。
- 工具执行出错则如实报告错误。

[自我诊断与修复]
- 可用 Read/file_read 读取源码分析，用 self_diagnose 扫描代码问题
- 找到问题后用 self_apply_fix 修复，用 exec_cmd 验证
- 被要求"找问题、修问题"时按: 诊断 → 分析 → 修复 → 验证 流程执行`);
            console.log(`[JingxuanAgent] CC模式: ${this.toolRegistry.getEnabledTools().length} tools ready`);

            this.pluginLoader = new PluginLoader(this.toolRegistry);
            const pluginResult = await this.pluginLoader.discover();
            if (pluginResult.loaded.length > 0) {
                console.log(`[JingxuanAgent] 插件: ${pluginResult.loaded.length} 加载, ${pluginResult.failed.length} 失败`);
            }
            this.health.register('plugins', () => this.pluginLoader?.loaded?.length > 0);

        this.learning = new SelfLearning({
            storage: this.storage,
            metrics: this.metrics,
            log: this.log,
            ccContextManager: this.ccContextManager,
            toolRegistry: this.toolRegistry,
            extractKnowledge: true,
            trackToolEffectiveness: true,
            learnUserPreferences: true,
        });
        this.log.info('SelfLearning ready');

            try {
                this.storage.init();
                this._sessionId = this.storage.createSession(`session_${Date.now()}`, { version: this.version });
                this.log.info('Storage ready', { db: this.storage.getStats().size + ' bytes', tables: this.storage.getStats().tables });
            } catch (e) {
                this.log.warn('Storage init failed (non-fatal)', { error: e.message });
            }

            this.health.register('storage', () => !!this.storage._ready);
            this.health.register('llm', () => !!this.components.llmAdapter?.chat);
            if (this.components.memoryPipeline) {
                this.health.register('memory', () => this.components.memoryPipeline.getStats ? true : false);
            }
            this.health.register('tools', () => this.toolRegistry.getEnabledTools().length > 0);

            this.components.memoryPipeline = new MemoryPipeline({
                memoryManager: this.components.memoryManager,
                llmAdapter: this.components.llmAdapter,
                localInference: null,
                maxMemoryItems: 2000,
                autoIndexInterval: 30000,
                embedding: embedConfig
            });
            await this.components.memoryPipeline.init();
            console.log(`[JingxuanAgent] MemoryPipeline READY`);

            this.components.workRecord = new WorkRecordManager({
                storageDir: path.join(process.cwd(), 'work_records'),
                memoryPipeline: this.components.memoryPipeline,
                contextManager: this.components.contextManager,
                llmAdapter: this.components.llmAdapter
            });
            await this.components.workRecord.init();

            // 存在上次工作记录则注入恢复上下文
            const resumeText = this.components.workRecord.getFormattedResume(true);
            if (resumeText) {
                this.components.contextManager.addMessage('system', resumeText);
                console.log(`[JingxuanAgent] 已加载工作记录恢复上下文`);
            }

            // 允许 LLM 适配器注入（为智能压缩/标签提供能力）
            this.components.memoryManager.setLLMAdapter(this.components.llmAdapter);
            this.components.contextManager.setLLMAdapter(this.components.llmAdapter);

            // 跨会话记忆 + 自动剪枝
            try {
                await this.components.memoryManager.loadCrossSessionMemories();
                await this.components.contextManager.loadCrossSession();
                setInterval(() => {
                    this.components.memoryManager.autoPrune().catch(e => console.warn(`[.] Caught: ${e.message}`));
                }, 1800000);
            } catch (e) {
                console.warn('[JingxuanAgent] Cross-session memory load failed:', e.message);
            }

            this.components.executor = new AtomicExecutor(this.components.stateManager);
            this.components.sopGenerator = new SOPGenerator(this.components.memoryManager, this.components.llmAdapter);
            this.components.optimizer = new SOPOptimizer(this.components.memoryManager, this.components.llmAdapter);

            let deviceConfig = { type: 'pc', safetyLevel: 'medium', stateInterval: 30000 };
            try {
                const cfg = require('./JingxuanAgent_Config.js');
                if (cfg.device) deviceConfig = cfg.device;
            } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
            this.components.deviceManager = new DeviceManager(deviceConfig);

            // 注入 PermissionSystem 到 SafetyEngine
            this.components.deviceManager.safety.setPermissionSystem(this._permissionSystem);

            await this.components.deviceManager.init();

            this._registerBuiltinDevices();

            // 认知框架
            try {
                const config = require('./JingxuanAgent_Config.js');
                const cfConfig = config.cognitiveFramework || {};
                if (cfConfig.enabled !== false) {
                    this.components.cognitiveFramework = new CognitiveFramework({
                        storageDir: cfConfig.storageDir || './experience_store',
                        carrierType: deviceConfig.type || 'pc',
                        name: deviceConfig.name || `JingxuanAgent-${deviceConfig.type}`,
                        debug: cfConfig.debug || false
                    });

                    // 注入外部组件
                    this.components.cognitiveFramework.integrate({
                        deviceManager: this.components.deviceManager,
                        toolExecutor: this.components.executor,
                        memoryManager: this.components.memoryManager,
                        llmAdapter: this.components.llmAdapter
                    });

                    await this.components.cognitiveFramework.init();
                    this.components.cognitiveFramework.start();

                    console.log(`[JingxuanAgent] CognitiveFramework READY (stage: ${this.components.cognitiveFramework.getStatus().cognition.stage})`);
                }
            } catch (e) {
                console.warn('[JingxuanAgent] CognitiveFramework init failed:', e.message);
            }

            this.components.conversationEngine = new ConversationEngine(
                this.components.llmAdapter, this.components.contextManager
            );
            this.components.conversationEngine.setPermissionSystem(this._permissionSystem);
            this.components.conversationEngine.setDeviceManager(this.components.deviceManager);
            this.components.conversationEngine.setMemoryPipeline(this.components.memoryPipeline);

            // 编排器（保留现有编排器作为后备）
            this.components.orchestrator = new CoordinatorOrchestrator({
                stateManager: this.components.stateManager,
                memoryManager: this.components.memoryManager,
                registry: this.components.registry,
                executor: this.components.executor,
                sopGenerator: this.components.sopGenerator,
                optimizer: this.components.optimizer,
                deviceManager: this.components.deviceManager,
                llmAdapter: this.components.llmAdapter,
                conversationEngine: this.components.conversationEngine,
                config: { maxRetries: 5, retryDelay: 2000, maxReflectLoop: 3, timeout: 60000 }
            });

            // 认知编排器
            try {
                if (this.components.cognitiveFramework) {
                    this.components.cognitiveOrchestrator = new CognitiveOrchestrator({
                        cognitiveFramework: this.components.cognitiveFramework,
                        toolExecutor: this.components.executor,
                        stateManager: this.components.stateManager,
                        memoryManager: this.components.memoryManager,
                        deviceManager: this.components.deviceManager,
                        safetyEngine: this.components.deviceManager?.safety,
                        debug: false
                    });
                    this.components.cognitiveOrchestrator.init();
                    console.log('[JingxuanAgent] CognitiveOrchestrator READY');
                }
            } catch (e) {
                console.warn('[JingxuanAgent] CognitiveOrchestrator init failed:', e.message);
            }

            try {
                const GenericMemoryEngine = require('./extensions/productivity_core/generic_memory_engine.js');
                const UniversalCoordinator = require('./extensions/productivity_core/universal_coordinator.js');
                const LocalDeliveryFramework = require('./extensions/productivity_core/local_delivery_framework.js');

                this.components.productivity = {
                    memoryEngine: new GenericMemoryEngine(this),
                    coordinator: UniversalCoordinator,
                    delivery: new LocalDeliveryFramework(this)
                };

                setInterval(() => {
                    this.components.productivity.memoryEngine.runAutoDream().catch(e => console.warn(`[.] Caught: ${e.message}`));
                }, 21600000);

                console.log('[JingxuanAgent] Productivity Core READY');
            } catch (e) {
                console.error('[JingxuanAgent] Productivity Core integration failed:', e);
            }

            this._initOptionalComponents();

            try {
                const config = require('./JingxuanAgent_Config.js');
                const liConfig = config.localInference || {};
                if (liConfig.enabled !== false) {
                    this.components.localInference = new LocalInferenceEngine(liConfig);
                    const liReady = await this.components.localInference.init();
                    console.log(`[JingxuanAgent] LocalInference ${liReady ? 'READY' : 'DISABLED'} (${liConfig.model || 'none'})`);

                    if (liReady) {
                        this.components.memoryManager.vectorStore.localInference = this.components.localInference;
                        this.components.memoryPipeline.vectorStore.localInference = this.components.localInference;
                        const embedMode = (process.env.EMBEDDING_MODE || 'hybrid');
                        if (embedMode === 'local' || embedMode === 'hybrid') {
                            setImmediate(() => {
                                this.components.memoryPipeline.vectorStore.buildEmbeddings({ force: false })
                                    .then(r => console.log(`[JingxuanAgent] Local embeddings: ${r.indexed}/${r.total}`))
                                    .catch(e => console.warn(`[.] Caught: ${e.message}`));
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn('[JingxuanAgent] LocalInference init failed:', e.message);
            }

            try {
                const config = require('./JingxuanAgent_Config.js');
                const clConfig = config.continualLearning || {};
                if (clConfig.enabled !== false && this.components.localInference) {
                    this.components.continualLearner = new ContinualLearner({
                        memoryManager: this.components.memoryManager,
                        localInference: this.components.localInference,
                        deviceManager: this.components.deviceManager,
                        ...clConfig
                    });
                    this.components.continualLearner.start();
                }
            } catch (e) {
                console.warn('[JingxuanAgent] ContinualLearner init failed:', e.message);
            }

            await this.components.registry.autoDiscover().catch(e => console.warn(`[.] Caught: ${e.message}`));
            if (this.components.registry.capabilityMap.size > 0) {
                this.components.sopGenerator.setCapabilityMap(this.components.registry.capabilityMap);
            }

            // 跟踪 MCP 桥接
            try {
                const mcpPlugin = this.components.registry.plugins.get('mcp_bridge_002');
                if (mcpPlugin && !this.components.mcpBridge) {
                    this.components.mcpBridge = mcpPlugin;
                    console.log('[JingxuanAgent] MCP Bridge plugin tracked in components');
                }
            } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }

            this._permissionSystem.grant('pc:admin', 4, 'permanent');

            try {
                const config = require('./JingxuanAgent_Config.js');
                const upgradeConfig = config.upgrade || {};

                this.components.upgrade = await JingxuanAgentUpgradeIntegrator.integrate(
                    this.components, upgradeConfig
                );

                if (this.components.upgrade.memoryBlocks) {
                    this._registerUpgradeTools('memoryBlocks', this.components.upgrade.memoryBlocks.getToolHandlers());
                }
            } catch (e) {
                console.warn('[JingxuanAgent] v4.0 upgrade integration warning (non-fatal):', e.message);
            }

            this.health.runAll().then(h => this.log.info('Health check', { status: h.status })).catch(e => console.warn(`[.] Caught: ${e.message}`));

            console.log(`[JingxuanAgent] v${this.version} 启动完成`);
            console.log(`[JingxuanAgent] 模块: 记忆系统=${!!this.components.memoryManager} 编排器=${!!this.components.orchestrator} 执行器=${!!this.components.atomicExecutor}`);
            console.log(`[JingxuanAgent] 工具: ${this.toolRegistry?.getEnabledTools().length || 0} 个已注册`);
            console.log(`[JingxuanAgent] 配置: ${this._configManager?.getConfigSource() || '内置'}`);
            this.ready = true;
            return {
                success: true,
                pluginsLoaded: this.components.registry.plugins.size,
                version: this.version,
                features: this._getEnabledFeatures()
            };
        } catch (e) {
            console.error('[JingxuanAgent] Init failed:', e);
            return { success: false, error: e.message };
        }
    }

    _registerBuiltinDevices() {
        try {
            const AD = require('./JingxuanAgent_Implementation/device_abstraction/AutomotiveDevice');
            this.components.deviceManager.registerDevice('automotive', new AD({ vehicleName: 'Connected Vehicle' }));
        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
    }

    _initOptionalComponents() {
        if (ModelRouter && ModelFallbackChain) {
            try {
                this.components.modelRouter = new ModelRouter({ costOptimization: true });
                this.components.fallbackChain = new ModelFallbackChain(this.components.modelRouter);

                const config = require('./JingxuanAgent_Config.js');
                const multiModelConfig = config.llm?.multiModel;
                if (multiModelConfig?.enabled && multiModelConfig.models) {
                    for (const [name, modelCfg] of Object.entries(multiModelConfig.models)) {
                        try {
                            const adapter = this._initModelAdapter(modelCfg);
                            if (adapter) {
                                this.components.modelRouter.registerModel(name, adapter, {
                                    priority: modelCfg.priority || 5,
                                    costPer1K: modelCfg.costPer1K || 0.5,
                                    capabilities: modelCfg.capabilities || ['chat'],
                                    maxTokens: modelCfg.maxTokens || 8192,
                                    strengths: modelCfg.strengths || []
                                });
                            }
                        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
                    }
                }

                if (this.components.llmAdapter) {
                    this.components.modelRouter.registerModel('default', this.components.llmAdapter, {
                        priority: 5, costPer1K: 0.5, capabilities: ['chat', 'analysis']
                    });
                }

                console.log(`[JingxuanAgent] ModelRouter: ${this.components.modelRouter.models.size} models registered`);
            } catch (e) {
                console.warn('[JingxuanAgent] ModelRouter init failed:', e.message);
            }
        }

        if (ExecutionLogger) this.components.logger = new ExecutionLogger({ level: 2 });
        if (MetricsCollector) this.components.metrics = new MetricsCollector({ interval: 60000, windowSize: 3600 });

        try {
            const config = require('./JingxuanAgent_Config.js');
            if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
                this._mcpConfig = { mcpServers: config.mcpServers };
                console.log('[JingxuanAgent] Computer control capability loaded (inactive, requires user permission)');
            }
        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
    }

    _getEnabledFeatures() {
        const dm = this.components.deviceManager, up = this.components.upgrade || {};
        const modules = ['cognitiveFramework','cognitiveOrchestrator','monitoring','mcpBridge','memoryPipeline',
          'modelRouter','fallbackChain','audnConsolidator','memoryBlocks','bitemporalGraph','hierarchicalRAG',
          'stateGraph','treeOfThoughts','skillLibrary','mctsPlanner','messagePool','groupChatManager',
          'adversarialVerifier','personaInjection','screenAgent','codeActMode','durableWorkflow'];
        const r = { deviceManager: !!dm, permissionLevel: this._permissionSystem.getEffectiveLevel() };
        if (dm) { r.deviceTypes = dm.listDeviceTypes().map(d => d.type); r.activeDevice = dm._activeDeviceType; }
        for (const m of modules) r[m] = !!(this.components[m] || up[m]);
        return r;
    }

    _registerUpgradeTools(moduleName, toolHandlers) {
        const ex = this.components.executor?.toolExecutor;
        if (!ex) return;
        for (const [name, handler] of Object.entries(toolHandlers || {})) ex.registerHandler(name, handler);
    }

    // 授权系统

    _detectPermissionGrant(message) {
        const dm = this.components.deviceManager;
        const deviceType = dm ? dm._activeDeviceType : 'pc';
        return this._permissionSystem.detectIntent(message, deviceType);
    }

    async _handlePermissionAction(intent) {
        const dm = this.components.deviceManager;
        const deviceType = dm ? dm._activeDeviceType : 'pc';

        if (intent.action === 'revoke') {
            this._permissionSystem.revokeAll(deviceType);
            this._computerControlEnabled = false;
            ToolExecutor.computerControlEnabled = false;
            if (this.components.conversationEngine) {
                this.components.conversationEngine.setComputerControlEnabled(false, []);
            }
            return { notification: '🔒 权限已撤销。需要时可重新授权。' };
        }

        if (intent.action === 'grant') {
            const scope = `${deviceType}:${intent.level >= 3 ? 'admin' : intent.level >= 2 ? 'control' : 'info'}`;
            const result = this._permissionSystem.grant(scope, intent.level, intent.grantType, {
                sourceMessage: intent.scope
            });

            if (result.alreadyGranted) {
                return { notification: '', alreadyEnabled: true };
            }

            // 同步开启 ToolExecutor
            if (intent.level >= 2 && !ToolExecutor.computerControlEnabled) {
                ToolExecutor.computerControlEnabled = true;
                this._computerControlEnabled = true;
            }

            // 同步 ConversationEngine
            if (this.components.conversationEngine && intent.level >= 2) {
                const tools = this.components.registry
                    ? this.components.registry.getCapabilities()
                    : [];
                this.components.conversationEngine.setComputerControlEnabled(true, tools);
            }

            const levelName = intent.level >= 3 ? '管理员' : intent.level >= 2 ? '控制' : '查询';
            const grantTypeLabel = intent.grantType === 'single' ? '（单次）' : intent.grantType === 'temporary' ? '（临时）' : '';

            return {
                notification: `\n\n✅ ${deviceType.toUpperCase()} ${levelName}权限已激活${grantTypeLabel}。`,
                justEnabled: true
            };
        }

        return { notification: '' };
    }

    _detectRemoteAccessIntent(message) {
        const startPatterns = [
            /我要出[门去外远]|要出[门去外远]了|我准备出[门去外远]|我出[门去外远]了/i,
            /我需要远程访问|开启远程|打开远程/i,
            /我要走了|我离开了|我在外面/i,
            /生成公网链接|生成远程链接|远程访问/i,
            /我[将要]?出[门去].*[不以]?在[家这]|出门了|不在家/i,
            /i('m| am) (going out|leaving|away|outside)/i,
            /enable remote|start tunnel|remote access/i,
        ];
        const stopPatterns = [
            /我回[来家了]|到家了|我到家|我回来了/i,
            /关闭远程|停止远程|断开隧道/i,
            /i('m| am) back|i returned|disable remote|stop tunnel/i,
        ];
        return {
            enable: startPatterns.some(p => p.test(message)),
            disable: stopPatterns.some(p => p.test(message))
        };
    }

    async enableRemoteAccess(port) {
        if (this._tunnelService.isActive) {
            return { success: true, url: this._tunnelService.url };
        }
        try {
            const result = await this._tunnelService.start(port || 3000);
            return { success: true, url: result.url };
        } catch (e) {
            console.error('[JingxuanAgent] Remote access failed:', e.message);
            return { success: false, error: e.message };
        }
    }

    disableRemoteAccess() {
        if (!this._tunnelService.isActive) return { success: true, alreadyDisabled: true };
        this._tunnelService.stop();
        return { success: true };
    }

    _detectDeviceSwitch(message) {
        const patterns = [
            { type: 'pc', pattern: /切换(到)?(PC|电脑|桌面|Windows)|使用(PC|电脑)模式/i },
            { type: 'automotive', pattern: /切换(到)?(汽车|车辆|车载|驾驶)|使用(汽车|车载)模式|连接车辆/i },
            { type: 'robot', pattern: /切换(到)?(机器人|机械臂)|使用机器人模式/i },
            { type: 'cnc', pattern: /切换(到)?(机床|CNC|数控)/i },
        ];

        for (const entry of patterns) {
            if (entry.pattern.test(message)) {
                return { detected: true, deviceType: entry.type };
            }
        }
        return { detected: false };
    }

    async _handleDeviceSwitch(intent) {
        const dm = this.components.deviceManager;
        if (!dm) return { notification: 'DeviceManager not available' };

        try {
            await dm.activateDevice(intent.deviceType);
            // 重置该设备的权限
            this._permissionSystem.grant(`${intent.deviceType}:info`, 1, 'permanent');
            const level = this._permissionSystem.getLevelName(intent.deviceType);

            return {
                notification: `✅ 已切换到 ${intent.deviceType.toUpperCase()} 设备。当前权限: ${level}。如需更多操作权限请授权。`
            };
        } catch (e) {
            return { notification: `❌ 切换失败: ${e.message}` };
        }
    }

    // 配置自服务

    _lazyConfigManager() {
        if (!this._configManager) this._configManager = new ConfigManager();
        return this._configManager;
    }

    _detectConfigIntent(message) {
        const { SCHEMA } = require('./services/ConfigSchema');
        if (this._pendingConfigChange) {
            if (/^(y(es)?|是[的]?|确认|好[的吧]?|对[的]?|嗯[呢]?|行[吧]?|可以|同意)$/i.test(message.trim())) {
                return { matched: true, action: 'confirm', pending: this._pendingConfigChange };
            }
            if (/^(n(o)?|不[用要不要]|算了|取消|不要)$/i.test(message.trim())) {
                return { matched: true, action: 'cancel' };
            }
        }
        if (this._pendingApiKeyProvider && /^[a-zA-Z0-9_\-]{8,}$/.test(message.trim())) {
            return {
                matched: true, action: 'setApiKeyValue',
                key: `${this._pendingApiKeyProvider}_API_KEY`,
                value: message.trim()
            };
        }
        for (const entry of SCHEMA) {
            if (!entry.patterns) continue;
            for (const pattern of entry.patterns) {
                const match = message.match(pattern);
                if (!match) continue;
                let value = null;
                if (entry.normalize) value = entry.normalize(match);
                if (entry.action === 'setApiKey' && value && value.provider) {
                    return { matched: true, action: 'setApiKey', provider: value.provider, key: `${value.provider}_API_KEY`, entry };
                }
                return { matched: true, action: entry.action, key: entry.key, value, entry };
            }
        }
        return { matched: false };
    }

    async _applyConfigChange(intent) {
        const cm = this._lazyConfigManager();
        switch (intent.action) {
            case 'show': return { notification: this._formatConfigStatus() };
            case 'set': {
                const validation = cm.validate(intent.key, intent.value);
                if (!validation.valid) return { notification: `❌ ${validation.error}` };
                await cm.set(intent.key, String(intent.value));
                return { notification: `✅ ${intent.key} 已更新为 ${intent.value}。${cm.requiresRestart(intent.key) ? '需要重启 JingxuanAgent 才能生效。' : '已即时生效。'}` };
            }
            case 'toggle': {
                const v = String(intent.value);
                await cm.set(intent.key, v);
                return { notification: `✅ 已${v === 'true' ? '开启' : '关闭'}。` };
            }
            case 'setApiKey': {
                this._pendingApiKeyProvider = intent.provider;
                return { notification: `请输入 ${intent.provider} 的 API 密钥：` };
            }
            case 'setApiKeyValue': {
                const provider = this._pendingApiKeyProvider;
                this._pendingApiKeyProvider = null;
                const validation = cm.validate(intent.key, intent.value);
                if (!validation.valid) return { notification: `❌ 密钥格式无效` };
                await cm.set(intent.key, intent.value);
                let hotSwapMsg = '';
                try {
                    const config = require('./JingxuanAgent_Config.js');
                    if (config.llm?.adapter?.toLowerCase() === provider.toLowerCase()) {
                        const swapped = await this._hotSwapLLM();
                        if (swapped) hotSwapMsg = ' 已即时生效。';
                    }
                } catch {}
                return { notification: `✅ ${provider} API 密钥已设置。${hotSwapMsg}` };
            }
            case 'confirm': {
                const change = intent.pending;
                if (change.action === 'setApiKey') {
                    this._pendingApiKeyProvider = change.provider;
                    return { notification: `请输入 ${change.provider} 的 API 密钥：` };
                }
                return await this._applyConfigChange(change);
            }
            case 'cancel': {
                this._pendingConfigChange = null;
                this._pendingApiKeyProvider = null;
                return { notification: '已取消配置变更。' };
            }
            case 'reset': {
                await cm.reset();
                return { notification: '✅ 配置已重置为默认值。请重启 JingxuanAgent 生效。' };
            }
            default: return { notification: '❌ 无法识别的配置操作。' };
        }
    }

    async _hotSwapLLM() {
        delete require.cache[require.resolve('./JingxuanAgent_Config.js')];
        const newAdapter = await this._initLLM();
        if (!newAdapter || !newAdapter.chat) return false;
        this.components.llmAdapter = newAdapter;
        if (this.components.conversationEngine) this.components.conversationEngine.llm = newAdapter;
        if (this.components.sopGenerator) this.components.sopGenerator.llmAdapter = newAdapter;
        if (this.components.optimizer) this.components.optimizer.llmAdapter = newAdapter;
        if (this.components.persona) this.components.persona.llmAdapter = newAdapter;
        if (this.components.orchestrator) this.components.orchestrator.llmAdapter = newAdapter;
        if (this.components.modelRouter && newAdapter) {
            this.components.modelRouter.registerModel('default', newAdapter, {
                priority: 5, costPer1K: 0.5, capabilities: ['chat', 'analysis']
            });
        }
        console.log('[JingxuanAgent] LLM adapter hot-swapped');
        return true;
    }

    _formatConfigStatus() {
        const cm = this._lazyConfigManager();
        const cfg = cm.getDisplayConfig();
        return [
            '📋 **当前配置**', '---',
            `🤖 **LLM适配器**: ${cfg.LLM_ADAPTER || 'deepseek'}`,
            `🔑 **DeepSeek**: ${cfg.DEEPSEEK_API_KEY ? '已设置 ✓' : '未设置'}`,
            `🔑 **GLM**: ${cfg.GLM_API_KEY ? '已设置 ✓' : '未设置'}`,
            `🔑 **MiniMax**: ${cfg.MINIMAX_API_KEY ? '已设置 ✓' : '未设置'}`,
            `🔑 **Qwen**: ${cfg.QWEN_API_KEY ? '已设置 ✓' : '未设置'}`,
            `🔀 **多模型调度**: ${cfg.MULTI_MODEL_ENABLED !== 'false' ? '已开启 ✓' : '已关闭'}`,
            `🌐 **Web服务端口**: ${cfg.PORT || 3000}`,
            `🔐 **认证Token**: ${cfg.HYPERAGENT_AUTH_TOKEN ? '已设置 ✓' : '未设置'}`,
            `🔧 **安全级别**: ${cfg.SAFETY_LEVEL || 'medium'}`,
            '',
            '💡 您可以直接对我说：',
            '  • "换用GLM模型" — 切换 LLM 适配器',
            '  • "设置DeepSeek密钥" — 设置 API 密钥',
            '  • "修改端口为8080" — 修改 Web 端口',
            '  • "开启多模型调度" — 切换功能开关',
            '  • "查看配置" — 显示当前配置',
        ].join('\n');
    }

    _initModelAdapter(modelCfg) {
        if (!modelCfg || !modelCfg.adapter) return null;
        const { adapter: adapterType, config } = modelCfg;
        switch (adapterType) {
            case 'glm':
                if (config?.apiKey) {
                    const GLMAdapter = require('./JingxuanAgent_Core/llm_adapter/GLMAdapter');
                    return new GLMAdapter(config);
                }
                break;
            case 'minimax':
                if (config?.apiKey) {
                    const MinimaxAdapter = require('./JingxuanAgent_Core/llm_adapter/MinimaxAdapter');
                    return new MinimaxAdapter(config);
                }
                break;
            case 'deepseek':
                if (config?.apiKey) {
                    if ((config.baseUrl || '').includes('/anthropic')) {
                        const AnthropicCompatAdapter = require('./JingxuanAgent_Core/llm_adapter/AnthropicCompatAdapter');
                        return new AnthropicCompatAdapter(config);
                    }
                    const DeepSeekAdapter = require('./JingxuanAgent_Core/llm_adapter/DeepSeekAdapter');
                    return new DeepSeekAdapter(config);
                }
                break;
            case 'qwen':
                if (config?.apiKey) {
                    const QwenAdapter = require('./JingxuanAgent_Core/llm_adapter/QwenAdapter');
                    return new QwenAdapter(config);
                }
                break;
        }
        return null;
    }

    async _initLLM() {
        let config = { adapter: 'mock' };
        try {
            const userConfig = require('./JingxuanAgent_Config.js');
            if (userConfig.llm) config = userConfig.llm;
        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }

        for (const [adapterName, check] of Object.entries({
            glm: (c) => c.glm?.apiKey ? { Adapter: require('./JingxuanAgent_Core/llm_adapter/GLMAdapter'), cfg: { apiKey: c.glm.apiKey, baseUrl: c.glm.baseUrl, model: c.glm.model, maxTokens: c.glm.maxTokens, temperature: c.glm.temperature } } : null,
            minimax: (c) => c.minimax?.apiKey ? { Adapter: require('./JingxuanAgent_Core/llm_adapter/MinimaxAdapter'), cfg: { apiKey: c.minimax.apiKey, baseUrl: c.minimax.baseUrl, model: c.minimax.model } } : null,
            deepseek: (c) => c.deepseek?.apiKey ? (c.deepseek.baseUrl||'').includes('/anthropic')
                ? { Adapter: require('./JingxuanAgent_Core/llm_adapter/AnthropicCompatAdapter'), cfg: { apiKey: c.deepseek.apiKey, baseUrl: c.deepseek.baseUrl, model: c.deepseek.model, maxTokens: c.deepseek.maxTokens, temperature: c.deepseek.temperature } }
                : { Adapter: require('./JingxuanAgent_Core/llm_adapter/DeepSeekAdapter'), cfg: { apiKey: c.deepseek.apiKey, baseUrl: c.deepseek.baseUrl, model: c.deepseek.model } } : null,
            qwen: (c) => c.qwen?.apiKey ? { Adapter: require('./JingxuanAgent_Core/llm_adapter/QwenAdapter'), cfg: { apiKey: c.qwen.apiKey, baseUrl: c.qwen.baseUrl, model: c.qwen.model } } : null,
        })) {
            if (config.adapter === adapterName) {
                try {
                    const result = check(config);
                    if (result) return new result.Adapter(result.cfg);
                } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
            }
        }

        if (config.adapter !== 'mock') {
            console.warn(`[JingxuanAgent] ${config.adapter} selected but ${config[config.adapter]?.apiKey ? 'failed to load' : 'no API key set'}`);
        }
        return {
            chat: async (messages) => '[Mock adapter] 请在配置中设置有效的 LLM API Key',
        };
    }

    // CC 模式：工具注册

    _registerCCTools() {
        const builtinTools = createBuiltinTools(fs, path, os, child_process);
        for (const tool of builtinTools) {
            this.toolRegistry.register(tool);
        }

        // Memory 查询工具
        this.toolRegistry.registerHandler('query_memory', async (params) => {
            if (!this.components.memoryPipeline) return 'Memory not available';
            const results = await this.components.memoryPipeline.search(params.query);
            return JSON.stringify(results || []);
        }, {
            description: '从长期记忆中搜索相关信息',
            category: 'memory',
            schema: Schema.object({
                query: Schema.string({ description: '搜索关键词', required: true }),
            }),
        });

        // 状态查询工具
        this.toolRegistry.registerHandler('get_status', async () => {
            const s = this.getStatus();
            return JSON.stringify({
                uptime: s.uptime,
                tools: this.toolRegistry.getEnabledTools().length,
                memory: !!this.components.memoryPipeline,
            });
        }, {
            description: '获取智能体当前状态信息',
            category: 'system',
            schema: Schema.object({}),
        });
    }

    // 主对话处理

    async chat(userMessage, options = {}) {
        if (!this.ready) throw new Error('JingxuanAgent not initialized');
        const startTime = Date.now();
        this.metrics.increment('chat.total');

        try { await this.rateLimiter.acquire(); } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }

        // Step 1: 检测设备切换
        const deviceSwitchIntent = this._detectDeviceSwitch(userMessage);
        if (deviceSwitchIntent.detected) {
            const result = await this._handleDeviceSwitch(deviceSwitchIntent);
            return {
                response: result.notification,
                thinking: '',
                analysis: { intent: 'config' },
                strategy: { type: 'directChat' },
                duration: Date.now() - startTime,
                local: true
            };
        }

        // Step 2: 检测授权意图
        let permissionNotification = '';
        let justGranted = false;
        const permIntent = this._detectPermissionGrant(userMessage);
        if (permIntent.detected) {
            const result = await this._handlePermissionAction(permIntent);
            permissionNotification = result.notification;
            justGranted = result.justEnabled || false;
        }

        // Step 3: 检测远程访问
        let remoteAccessNotification = null;
        const remoteIntent = this._detectRemoteAccessIntent(userMessage);
        if (remoteIntent.enable && !this._tunnelService.isActive) {
            const tunnelResult = await this.enableRemoteAccess();
            if (tunnelResult.success) {
                const token = process.env.HYPERAGENT_AUTH_TOKEN || '';
                let urlNote = `\n\n远程访问已开启！通过此链接访问我：\n${tunnelResult.url}`;
                if (token) urlNote += `\n🔑 令牌: ${token}`;
                urlNote += `\n\n用完告诉我"我回来了"关闭。`;
                remoteAccessNotification = urlNote;
            } else {
                remoteAccessNotification = `\n\n❌ 远程访问开启失败：${tunnelResult.error}。`;
            }
        } else if (remoteIntent.disable && this._tunnelService.isActive) {
            this.disableRemoteAccess();
            remoteAccessNotification = '\n\n🔌 远程访问已关闭。欢迎回来！';
        }

        // Step 4: 检测配置意图
        let configNotification = null;
        const configIntent = this._detectConfigIntent(userMessage);
        const isConfigAction = configIntent.matched && !justGranted;

        this.components.contextManager.addMessage('user', userMessage);
        if (this.components.episodicConsolidator) {
            this.components.episodicConsolidator.registerMessage('user', userMessage);
        }

        // Step 5: 核心对话处理（CC QueryEngine）
        let result;
        if (isConfigAction) {
            const cfgResult = await this._applyConfigChange(configIntent);
            configNotification = cfgResult.notification;
            if (configNotification) {
                result = {
                    response: configNotification,
                    thinking: '', analysis: { intent: 'config' },
                    strategy: { type: 'directChat' },
                    needsTools: false, toolPlan: null, local: true
                };
            }
        } else if (this.ccQueryEngine && userMessage.length > 0) {
            if (this.learning) {
                const ctx = this.learning.buildLearningContext();
                if (ctx) this.ccContextManager.setAppendSystemPrompt('\n' + ctx);
            }
            result = await this.ccQueryEngine.processMessage(userMessage, options);
            result = {
                response: result.response,
                thinking: this._formatCCTHinking(result),
                analysis: result.analysis || { intent: 'chat' },
                strategy: result.strategy || { type: 'directChat' },
                needsTools: (result.toolCallCount || 0) > 0,
                toolPlan: (result.toolCallCount || 0) > 0 ? { summary: userMessage.substring(0, 100) } : null,
                toolCallCount: result.toolCallCount || 0,
                duration: 0,
                local: true
            };
        } else {
            result = await this.components.conversationEngine.processMessage(userMessage, options);

            // Step 6: 回退工具执行（原版两步走）
            if (result && result.needsTools && result.toolPlan) {
                let toolResult;
                if (this.components.orchestrator.runTaskWithTools) {
                    toolResult = await Promise.race([
                        this.components.orchestrator.runTaskWithTools(
                            result.toolPlan.summary || userMessage,
                            { maxToolLoops: 20 }
                        ),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('工具执行超时 (300s)')), 300000)
                        )
                    ]);
                    result.response = toolResult || '';
                    const rawResult = result.response;
                    // 工具执行结果中有错误时，禁用 LLM 总结（防 LLM 掩盖错误）
                    const hasError = rawResult.includes('[失败]') || rawResult.includes('❌') || rawResult.includes('error');
                    if (!hasError && rawResult && rawResult.length > 10 && this.components.llmAdapter) {
                        try {
                            const summary = await this.components.llmAdapter.chat([
                                { role: 'system', content: '将工具执行结果用一句话总结给用户。只基于已有数据总结。如果结果是错误就报告错误。' },
                                { role: 'user', content: `工具执行结果:\n${rawResult.substring(0, 1500)}\n\n一句话回复:` }
                            ]);
                            if (summary && summary.length < 400 && !summary.includes('{"tool":')) {
                                result.response = summary.trim();
                            }
                        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
                    }
                } else {
                    toolResult = await this.components.orchestrator.runTask(
                        result.toolPlan.summary || userMessage, options
                    );
                    result.response = this._extractToolResponse(toolResult);
                }
                result.executedWithTools = true;
            }
        }

        // Step 7: 防幻觉校验 — 用户要求执行操作但 LLM 未调用任何工具
        const userRequestedAction = /(帮[我我把]|创建|删除|打开|关闭|运行|执行|启动|停止|复制|移动|修改|设置|安装|写[入文件]|保存|搜索|查询|截屏|截图|下载|上传|分析|统计|比较|修复|检查|测试)/.test(userMessage);
        if (userRequestedAction && result && !result.needsTools && (result.toolCallCount || 0) === 0) {
            if (!result.response.includes('[防幻觉拦截]') && !result.response.includes('[磁盘验证失败]')) {
                console.warn(`[AntiHallucination] Detected potential fake success. User asked for action, model used 0 tools.`);
                result.response = `[防幻觉拦截] 您要求执行操作，但系统未调用任何工具就生成了回复。这可能是假成功。请明确告诉我需要执行的具体操作，我会实际执行。`;
                result._antiHallucinationFlag = true;
            }
        }

        // Step 8: 追加通知
        if (justGranted && permissionNotification) {
            result.response = (result.response || '') + permissionNotification;
        }
        if (remoteAccessNotification) {
            result.response = (result.response || '') + remoteAccessNotification;
        }

        // Step 9: 更新工作记录
        try {
            if (this.components.workRecord) {
                this.components.workRecord.addSessionTurn(userMessage, result?.response || '');
                if (!isConfigAction && !deviceSwitchIntent.detected) {
                    this.components.workRecord.setGoal(userMessage.substring(0, 200));
                }
                if (result?.toolCallCount > 0 && result?.response) {
                    this.components.workRecord.addFinding(result.response.substring(0, 200));
                }
                await this.components.workRecord.save();
            }
        } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }

        this.components.contextManager.addMessage('assistant', result?.response || '');
        result.duration = Date.now() - startTime;

        if (this.learning && !isConfigAction && !deviceSwitchIntent.detected) {
            try {
                this.learning.extractKnowledge(userMessage, result.response, result.toolCalls || []);
                this.learning.updateUserPreferences(userMessage, result.response);
                if (result.toolCallCount > 0) {
                    result.toolCallCount;
                }
            } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
        }

        this.metrics.timing('chat.duration', result.duration);
        this.metrics.increment('chat.toolCalls', result.toolCallCount || 0);
        if (this.storage._ready && this._sessionId) {
            try {
                this.storage.addMessage(this._sessionId, 'user', userMessage);
                this.storage.addMessage(this._sessionId, 'assistant', result.response || '', {
                    tokens: result.toolCallCount || 0,
                });
                if (result.duration > 30000) this.storage.recordMetric('chat.slow', result.duration);
            } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
        }

        return result;
    }

    _formatCCTHinking(result) {
        const a = result.analysis || {}, s = result.strategy || {};
        return '```analysis\n意图: ' + (a.intent||'chat') + ' | 策略: ' + (s.type||'directChat') + ' | 工具: ' + (result.toolCallCount||0) + '次\n```';
    }

    _extractToolResponse(r) {
        if (typeof r !== 'string') return r || '';
        const m = r.match(/Step \d+ Result:\s*/);
        if (!m) return r;
        const json = r.substring(m.index + m[0].length).trim();
        try { const p = JSON.parse(json); return p.data?.message || p.data?.content || p.message || p.content || json; } catch (e) { return json; }
    }

    async runTask(goal, options = {}) {
        if (!this.ready) throw new Error('JingxuanAgent not initialized');
        if (!this.components.orchestrator) throw new Error('Orchestrator not initialized');
        const taskStartTime = Date.now();
        this.components.contextManager.addMessage('user', goal);
        if (this.components.metrics) {
            this.components.metrics.increment('tasks.total');
            this.components.metrics.increment('tasks.in_progress');
        }
        try {
            const result = await this.components.orchestrator.runTask(goal, options);
            if (this.components.metrics) {
                this.components.metrics.increment('tasks.success');
                this.components.metrics.recordLatency('task.duration', Date.now() - taskStartTime);
                this.components.metrics.increment('tasks.in_progress', -1);
            }
            this.components.contextManager.addMessage('assistant', typeof result === 'string' ? result : JSON.stringify(result));
            return result;
        } catch (error) {
            if (this.components.metrics) {
                this.components.metrics.increment('tasks.failed');
                this.components.metrics.increment('tasks.in_progress', -1);
            }
            throw error;
        }
    }

    async runTaskWithTools(goal, options = {}) {
        if (!this.ready) throw new Error('JingxuanAgent not initialized.');
        if (!this.components.orchestrator) throw new Error('Orchestrator not initialized.');
        this.components.contextManager.addMessage('user', goal);
        if (this.components.metrics) {
            this.components.metrics.increment('tasks.total');
            this.components.metrics.increment('tasks.tool_mode');
        }
        try {
            const result = await this.components.orchestrator.runTaskWithTools(goal, options);
            if (this.components.metrics) {
                this.components.metrics.increment('tasks.success');
                this.components.metrics.recordLatency('task.duration', Date.now() - taskStartTime);
            }
            this.components.contextManager.addMessage('assistant', typeof result === 'string' ? result : JSON.stringify(result));
            return result;
        } catch (error) {
            if (this.components.metrics) this.components.metrics.increment('tasks.failed');
            throw error;
        }
    }

    getStatus() {
        const dm = this.components.deviceManager;
        return {
            name: this.name,
            version: this.version,
            uptime: Date.now() - this.startTime,
            ready: this.ready,
            features: this._getEnabledFeatures(),
            health: this.health.getStatus(),
            storage: this.storage._ready ? this.storage.getStats().tables : null,
            security: this.security.getStats(),
            metrics: this.metrics.snapshot().counters,
            permission: this._permissionSystem.getStatus(),
            activeDevice: dm ? {
                type: dm._activeDeviceType,
                info: dm.getDevice()?.getDeviceInfo() || {},
                capabilities: dm.getDevice()?.getCapabilitySummary() || {}
            } : null,
            components: {
                stateManager: !!this.components.stateManager,
                memoryManager: !!this.components.memoryManager,
                contextManager: !!this.components.contextManager,
                registry: !!this.components.registry,
                orchestrator: !!this.components.orchestrator,
                executor: !!this.components.executor,
                deviceManager: !!this.components.deviceManager,
                sopGenerator: !!this.components.sopGenerator,
                modelRouter: !!this.components.modelRouter,
                fallbackChain: !!this.components.fallbackChain,
                episodicConsolidator: !!this.components.episodicConsolidator,
                reflectionEngine: !!this.components.orchestrator?.reflectionEngine,
                metaMonitor: !!this.components.orchestrator?.metaMonitor,
                continualLearner: !!this.components.continualLearner,
                localInference: !!this.components.localInference?.isReady(),
                cognitiveFramework: !!this.components.cognitiveFramework?.getStatus(),
                cognitiveOrchestrator: !!this.components.cognitiveOrchestrator?.getStatus(),
                memoryPipeline: !!this.components.memoryPipeline,
                metrics: !!this.components.metrics,
                logger: !!this.components.logger,
                workRecord: !!this.components.workRecord
            },
            plugins: this.components.registry?.plugins?.size || 0,
            deviceTypes: dm ? dm.listDeviceTypes() : []
        };
    }

    async queryMemory(query) {
        if (!this.ready) throw new Error('Not initialized');
        return this.components.memoryManager.retrieve(query);
    }

    async loadPlugin(pluginPath) {
        return this.components.registry.loadPlugin(pluginPath);
    }

    async runParallel(tasks) {
        const ParallelPipeline = require('./JingxuanAgent_Implementation/orchestrator/ParallelPipeline');
        const pipeline = new ParallelPipeline({ maxConcurrency: 5 });
        tasks.forEach((task, i) => {
            pipeline.register(`task_${i}`, () => this.runTask(task), []);
        });
        return await pipeline.run();
    }

    getStats() {
        const stats = this.getStatus();
        if (this.components.metrics) {
            const metrics = this.components.metrics.getAll();
            stats.metricsSummary = {
                tasksTotal: metrics.counters?.['tasks.total']?.total || 0,
                tasksSuccess: metrics.counters?.['tasks.success']?.total || 0,
                successRate: metrics.counters?.['tasks.total']?.total > 0
                    ? ((metrics.counters?.['tasks.success']?.total || 0) / metrics.counters['tasks.total'].total * 100).toFixed(1) + '%'
                    : 'N/A',
                avgLatency: metrics.histograms?.['task.duration']?.avg || 'N/A'
            };
        }
        if (this.components.continualLearner) {
            stats.continualLearning = {
                absorbed: this.components.continualLearner.stats.totalAbsorbed,
                analyzed: this.components.continualLearner.stats.totalAnalyzed,
                evolved: this.components.continualLearner.stats.totalEvolved,
                patternsFound: this.components.continualLearner.stats.patternsFound,
                insights: this.components.continualLearner.stats.insightsGenerated,
                stateChanges: this.components.continualLearner._stateChangeCount
            };
        }
        if (this.components.localInference) {
            stats.localInference = this.components.localInference.getStats();
        }
        if (this.components.memoryPipeline) {
            stats.memoryPipeline = this.components.memoryPipeline.getStats();
        }
        if (this.components.workRecord) {
            stats.workRecord = this.components.workRecord.getStats();
        }
        return stats;
    }
}

process.on('uncaughtException', (error) => {
    console.error('[JingxuanAgent] Uncaught exception:', error);
    if (process.env.NODE_ENV === 'production') process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[JingxuanAgent] Unhandled rejection:', reason);
});

process.on('SIGINT', async () => {
    console.log('\n[JingxuanAgent] 收到关闭信号，正在清理...');
    if (global.__hyperAgentInstance?.disableRemoteAccess) {
        global.__hyperAgentInstance.disableRemoteAccess();
    }
    if (global.__hyperAgentInstance?.components?.continualLearner?.stop) {
        global.__hyperAgentInstance.components.continualLearner.stop();
    }
    if (global.__hyperAgentInstance?.components?.workRecord) {
        try {
            await global.__hyperAgentInstance.components.workRecord.destroy();
            console.log('[JingxuanAgent] 工作记录已保存');
        } catch (e) {
            console.warn('[JingxuanAgent] 工作记录保存失败:', e.message);
        }
    }
    console.log('[JingxuanAgent] 清理完成，正在退出...');
    process.exit(0);
});

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'interactive';
    const agent = new JingxuanAgent();
    global.__hyperAgentInstance = agent;
    const initResult = await agent.init();

    if (!initResult.success) {
        console.error('[JingxuanAgent] Init failed:', initResult.error);
        process.exit(1);
    }

    if (mode === 'interactive') {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `🤖[${agent.toolRegistry.getEnabledTools().length}t] > `,
            historySize: 100,
        });

        // 自动补全
        const commandNames = ['.quit', '.exit', '.help', '.status', '.health', '.stats', '.plugins', '.tools', '.db', '.security', '.devices', '.learn', '.work', '.metrics'];
        rl.on('tab', (line) => {
            const hits = commandNames.filter(c => c.startsWith(line));
            if (hits.length === 1) { rl.line = hits[0]; rl.cursor = hits[0].length; return; }
            if (hits.length > 1) { console.log('\n' + hits.join('  ')); }
            rl.prompt();
        });

        const commands = {
            '.quit': () => process.exit(0),
            '.exit': () => process.exit(0),
            '.help': () => {
                console.log([
                    '命令:',
                    '  .quit / .exit    退出',
                    '  .status          系统状态',
                    '  .health          健康检查',
                    '  .stats           详细统计',
                    '  .plugins         插件列表',
                    '  .tools           已注册工具',
                    '  .db              SQLite 统计',
                    '  .security        安全审计',
                    '  .metrics         性能指标',
                    '  .devices         设备列表',
                    '  .learn           学习报告',
                    '  .work            工作记录',
                    '其他输入作为对话内容发送',
                ].join('\n'));
            },
            '.status': () => {
                const s = agent.getStatus();
                console.log(JSON.stringify({
                    version: s.version, uptime: s.uptime,
                    ready: s.ready, health: s.health?.status,
                    tools: s.features?.deviceTypes || agent.toolRegistry.getEnabledTools().length,
                    storage: s.storage,
                }, null, 2));
            },
            '.health': async () => {
                const h = await agent.health.runAll();
                for (const c of h.checks) {
                    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.error ? ': ' + c.error : ''}`);
                }
                console.log(`状态: ${h.status}`);
            },
            '.stats': () => console.log(JSON.stringify(agent.getStats(), null, 2)),
            '.plugins': () => {
                if (agent.pluginLoader) {
                    const s = agent.pluginLoader.getStats();
                    console.log(`加载: ${s.loaded}, 失败: ${s.failed}`);
                    if (s.failures.length > 0) console.log('  失败:', s.failures);
                } else { console.log('PluginLoader not initialized'); }
            },
            '.tools': () => {
                const tools = agent.toolRegistry.getEnabledTools();
                console.log(`已注册 ${tools.length} 个工具:`);
                for (const t of tools) console.log(`  ${t.name} — ${t.description.substring(0, 60)}`);
            },
            '.db': () => {
                if (agent.storage._ready) {
                    const s = agent.storage.getStats();
                    console.log(`数据库: ${s.path} (${(s.size/1024).toFixed(1)} KB)`);
                    console.log(`  会话: ${s.tables.sessions}, 消息: ${s.tables.messages}, 工具调用: ${s.tables.toolCalls}`);
                } else { console.log('Storage not ready'); }
            },
            '.security': () => {
                const s = agent.security.getStats();
                console.log(`安全事件: ${s.totalAuditEvents}, 拦截: ${s.blockedActions}`);
                const recent = agent.security.getAuditLog(5);
                for (const e of recent) console.log(`  [${e.action}] ${e.target.substring(0, 60)} — ${e.reason}`);
            },
            '.metrics': () => console.log(JSON.stringify(agent.metrics.snapshot(), null, 2)),
            '.devices': () => console.log(JSON.stringify(agent.components.deviceManager?.listDeviceTypes() || [], null, 2)),
            '.learn': async () => {
                if (agent.learning) {
                    const s = agent.learning.getStats();
                    console.log('自我进化统计:');
                    console.log(JSON.stringify(s, null, 2));
                    const prefs = agent.learning.getUserPreferences();
                    if (Object.keys(prefs).length > 0) console.log('\n用户偏好:', JSON.stringify(prefs, null, 2));
                    const tools = agent.learning.getToolRecommendations();
                    if (tools.length > 0) console.log('\n推荐工具:', JSON.stringify(tools.slice(0, 5), null, 2));
                } else if (agent.components.continualLearner) {
                    const report = await agent.components.continualLearner.getLearningReport();
                    console.log(JSON.stringify(report, null, 2));
                } else { console.log('Learning not initialized'); }
            },
            '.work': () => {
                if (agent.components.workRecord) {
                    const stats = agent.components.workRecord.getStats();
                    console.log(JSON.stringify(stats, null, 2));
                    const resume = agent.components.workRecord.getFormattedResume(true);
                    if (resume) console.log('\n' + resume);
                } else { console.log('WorkRecord not initialized'); }
            },
        };

        const cmdNames = Object.keys(commands);
        rl.input.on('keypress', (str, key) => {
            if (key && key.name === 'tab') {
                const partial = rl.line.trim();
                const matches = cmdNames.filter(c => c.startsWith(partial));
                if (matches.length === 1) { rl.line = matches[0] + ' '; rl.cursor = rl.line.length; }
            }
        });

        rl.on('line', async (input) => {
            const cmd = input.trim();
            if (!cmd) { rl.prompt(); return; }
            if (commands[cmd]) { await commands[cmd](); rl.prompt(); return; }
            try {
                const result = await agent.chat(cmd);
                if (result.thinking) console.log(result.thinking);
                console.log(`${result.response || result}`);
            } catch (e) { console.error('Error:', e.message); }
            rl.prompt();
        });
    } else if (mode === 'server') {
        const express = require('express');
        const app = express();
        app.use(express.json({ limit: '50mb' }));
        app.use(express.static(path.join(__dirname, 'web')));

        const AUTH_TOKEN = process.env.HYPERAGENT_AUTH_TOKEN || '';
        function authMiddleware(req, res, next) {
            if (!AUTH_TOKEN) return next(); // 未配置 token 不限制
            const auth = req.headers['authorization'];
            if (auth === `Bearer ${AUTH_TOKEN}`) return next();
            return res.status(401).json({ success: false, error: 'Unauthorized — 请提供有效的访问令牌' });
        }
        app.use('/api', authMiddleware);

        app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

        // 文件上传 API
        const UPLOAD_DIR = path.join(__dirname, 'uploads');
        if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        }

        app.post('/api/upload', async (req, res) => {
            try {
                const { fileName, data, type } = req.body;
                if (!fileName || !data) {
                    return res.status(400).json({ success: false, error: 'Missing fileName or data' });
                }
                const maxSize = 50 * 1024 * 1024;
                const buffer = Buffer.from(data, 'base64');
                if (buffer.length > maxSize) {
                    return res.status(413).json({ success: false, error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB` });
                }
                const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                const filePath = path.join(UPLOAD_DIR, safeName);
                fs.writeFileSync(filePath, buffer);
                let result = { type: type || 'document', filePath, fileName };
                try {
                    const DocumentParser = require('./JingxuanAgent_Implementation/atomic_executor/DocumentParser');
                    const parser = new DocumentParser({ maxFileSize: maxSize });
                    const parsed = await parser.parse(filePath);
                    result = { ...result, ...parsed };
                } catch (parseErr) {
                    result.content = `[已保存] ${fileName} (${(buffer.length / 1024).toFixed(0)}KB)`;
                    result.metadata = { fileName, fileSize: buffer.length, parseError: parseErr.message };
                }
                const summary = result.type === 'image'
                    ? `已加载图片: ${fileName}${result.metadata?.width ? ' (' + result.metadata.width + 'x' + result.metadata.height + ')' : ''}`
                    : `已解析文档: ${fileName} (${(result.content || '').length} 字符${result.metadata?.pages ? ', ' + result.metadata.pages + ' 页' : ''}${result.metadata?.sheets ? ', ' + result.metadata.sheets + ' 个工作表' : ''})`;
                res.json({
                    success: true, filePath: result.filePath, fileName: result.fileName,
                    type: result.type, summary,
                    metadata: result.metadata || {},
                    preview: result.type !== 'image' ? (result.content || '').substring(0, 500) : '',
                });
            } catch (e) {
                console.error('[API] Upload error:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/chat', async (req, res) => {
            const goal = req.body.goal || '';
            try {
                const chatResult = await agent.chat(goal);
                res.json({ success: true, result: chatResult.response || '', local: false });
            } catch (e) {
                console.error('[API] Chat error:', e.message);
                res.json({ success: false, error: '处理失败: ' + e.message });
            }
        });

        app.post('/api/chat/stream', async (req, res) => {
            if (!req.body.goal) { res.status(400).json({ error: 'Goal is required' }); return; }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
            });
            try {
                if (agent.components.conversationEngine) {
                    const result = await agent.chat(req.body.goal);
                    res.write(`data: ${JSON.stringify({ type: 'done', content: result.response })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'done', content: 'Agent not ready' })}\n\n`);
                }
            } catch (e) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
            } finally { res.end(); }
        });

        app.post('/api/chat/tools', async (req, res) => {
            try {
                const result = await agent.runTaskWithTools(req.body.goal);
                res.json({ success: true, mode: 'function_calling' });
            } catch (e) { res.json({ success: false, error: 'Internal error' }); }
        });

        app.get('/api/status', (req, res) => {
            const s = agent.getStatus();
            res.json({
                status: agent.health.getStatus().status || 'running',
                uptime: process.uptime(),
                tools: agent.toolRegistry.getEnabledTools().length,
                storage: agent.storage._ready ? agent.storage.getStats().tables : null,
                metrics: agent.metrics.snapshot().counters,
            });
        });

        app.get('/api/health', async (req, res) => {
            try { const h = await agent.health.runAll(); res.json(h); } catch (e) { res.json({ status: 'error', error: e.message }); }
        });

        app.get('/api/stats', (req, res) => {
            const data = {
                uptime: process.uptime(),
                cognitiveFramework: null,
                llmMode: 'mock(内置)'
            };
            try {
                if (agent.components?.cognitiveFramework) {
                    data.cognitiveFramework = agent.components.cognitiveFramework.getStatus();
                }
                if (agent.components?.llmAdapter) {
                    const adapter = agent.components.llmAdapter;
                    const isMock = !adapter.constructor || adapter.constructor === Object;
                    data.llmMode = isMock ? 'mock(内置)' : adapter.constructor.name.replace('Adapter', '');
                }
                const s = agent.getStats();
                if (s) Object.assign(data, s);
            } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
            res.json(data);
        });

        app.get('/api/metrics', (req, res) => {
            res.json(agent.metrics.snapshot());
        });

        app.get('/api/storage', (req, res) => {
            try { res.json(agent.storage._ready ? agent.storage.getStats() : { ready: false }); } catch (e) { res.json({ error: e.message }); }
        });

        app.get('/api/security/audit', (req, res) => {
            res.json({ events: agent.security.getAuditLog(50), stats: agent.security.getStats() });
        });

        // 工作记录 API
        app.get('/api/work-record', (req, res) => {
            try {
                if (agent.components?.workRecord) {
                    const stats = agent.components.workRecord.getStats();
                    const resume = agent.components.workRecord.getFormattedResume(true);
                    res.json({ success: true, stats, resume });
                } else {
                    res.json({ success: false, error: 'WorkRecord not initialized' });
                }
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        const deviceInfo = async () => {
            const r = agent.components.deviceManager?.getFullReport() || {};
            return { deviceType: r.info?.type || 'unknown', deviceName: r.info?.name || 'unknown' };
        };
        app.get('/api/device/info', async (req, res) => {
            try { res.json({ success: true, data: await deviceInfo() }); } catch (e) { res.json({ success: false, error: 'Internal error' }); }
        });
        app.post('/api/device/state', async (req, res) => {
            try { res.json({ success: true, data: await deviceInfo() }); } catch (e) { res.json({ success: false, error: 'Internal error' }); }
        });

        function startServer(port, maxAttempts = 10) {
            const tryPort = port;
            const server = app.listen(tryPort, () => {
                console.log(`✅ 服务器运行在 http://localhost:${tryPort}`);
                const devices = agent.components.deviceManager?.listDeviceTypes().map(d => d.type).join(', ') || 'none';
                console.log(`📦 设备: ${devices}`);
                console.log(`💡 打开浏览器访问 http://localhost:${tryPort} 开始对话`);
            });
            server.on('error', (e) => {
                if (e.code === 'EADDRINUSE' && maxAttempts > 0) {
                    console.warn(`⚠️  端口 ${tryPort} 被占用，尝试 ${tryPort + 1}...`);
                    server.close();
                    startServer(tryPort + 1, maxAttempts - 1);
                } else {
                    console.error(`❌ 无法启动服务器: ${e.message}`);
                }
            });
        }
        startServer(3000);
    }
}

module.exports = JingxuanAgent;
if (require.main === module) main();
