const { exec, execSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const browserManager = require('./BrowserManager');
const GuiOperator = require('./GuiOperator');

class ToolExecutor {
    /** Computer control permission flag — when true, all tools are allowed */
    static computerControlEnabled = true;

    /** 安全工具白名单（仅用于日志标记，不再作为权限门控） */
    static SAFE_TOOLS = new Set([
        'echo', 'chat', 'calc_basic', 'sys_time', 'sys_info',
        'http_get', 'http_post', 'weather'
    ]);

    constructor() {
        this.toolRegistry = this._buildRegistry();
        this._loadExtendedTools();

        // UI-TARS GUI 操作器（延迟初始化）
        this._guiOperator = null;
        this._guiOperatorReady = false;
    }

    /**
     * 获取 GUI 操作器（懒初始化）
     */
    async getGuiOperator() {
        if (this._guiOperatorReady) return this._guiOperator;
        if (!this._guiOperator) {
            this._guiOperator = new GuiOperator({});
        }
        try {
            this._guiOperatorReady = await this._guiOperator.init();
        } catch (e) {
            console.warn('[ToolExecutor] GUI Operator init failed:', e.message);
        }
        return this._guiOperatorReady ? this._guiOperator : null;
    }

    async execute(action) {
        // User issued a command directly — proceed. SafetyEngine still blocks dangerous operations.
        const handler = this.toolRegistry[action.tool];
        if (!handler) throw new Error(`Unknown tool: ${action.tool}`);
        return await handler(action.params);
    }

    /**
     * 注册外部工具处理器（供 MCP 桥接等插件使用）
     */
    registerHandler(toolName, handler) {
        this.toolRegistry[toolName] = handler;
    }

    /** Register ScreenAgent for GUI automation */
    setScreenAgent(screenAgent) {
        this._screenAgent = screenAgent;
        // 注册 GUI 工具
        if (screenAgent) {
            this.registerHandler('screen_run_task', async (params) => {
                const result = await screenAgent.runTask(params.instruction, {
                    maxIterations: params.maxSteps || 10
                });
                return { verified: result.success, data: result };
            });
        }
    }

    /** Register CodeActMode for code execution */
    registerCodeActMode(codeAct) {
        if (codeAct) {
            this.registerHandler('code_execute', CodeActMode.wrapAsTool(codeAct));
            this.registerHandler('code_plan', async (params) => ({
                verified: true,
                data: { plan: `CodeAct planning for: ${params.goal || params.task}` }
            }));
        }
    }

    listTools() {
        return Object.keys(this.toolRegistry).map(name => ({
            name,
            handler: this.toolRegistry[name]
        }));
    }

    /**
     * 获取 LLM 函数调用格式的工具定义列表
     * 用于 runTaskWithTools 的 tools 参数
     */
    getToolDefinitions() {
        const schemaMap = {
            // === 文件操作 ===
            file_read: { description: '读取本地文件内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件完整路径' } }, required: ['path'] } },
            file_write: { description: '写入内容到本地文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string' } }, required: ['path', 'content'] } },
            file_delete: { description: '删除本地文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
            file_copy: { description: '复制文件', parameters: { type: 'object', properties: { src: { type: 'string' }, dest: { type: 'string' } }, required: ['src', 'dest'] } },
            file_move: { description: '移动或重命名文件', parameters: { type: 'object', properties: { src: { type: 'string' }, dest: { type: 'string' } }, required: ['src', 'dest'] } },
            dir_create: { description: '创建目录', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
            dir_list: { description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] } },
            text_search: { description: '在文件中搜索文本', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['path', 'pattern'] } },
            text_replace: { description: '在文件中替换文本', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, replacement: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'pattern', 'replacement'] } },

            // === 命令执行 ===
            exec_cmd: { description: '执行 cmd 命令', parameters: { type: 'object', properties: { cmd: { type: 'string', description: '要执行的命令' }, cwd: { type: 'string', description: '工作目录' }, timeout: { type: 'number' } }, required: ['cmd'] } },
            exec_powershell: { description: '执行 PowerShell 脚本', parameters: { type: 'object', properties: { script: { type: 'string' }, timeout: { type: 'number' } }, required: ['script'] } },

            // === 进程管理 ===
            process_list: { description: '查看运行中的进程', parameters: { type: 'object', properties: { filter: { type: 'string', description: '进程名过滤' } } } },
            process_kill: { description: '终止指定进程', parameters: { type: 'object', properties: { pid: { type: 'string', description: '进程 PID' } }, required: ['pid'] } },
            service_list: { description: '列出 Windows 服务', parameters: { type: 'object', properties: { filter: { type: 'string' } } } },
            service_control: { description: '启动/停止/重启 Windows 服务', parameters: { type: 'object', properties: { name: { type: 'string', description: '服务名' }, action: { type: 'string', enum: ['start', 'stop', 'restart', 'pause', 'continue'] } }, required: ['name', 'action'] } },

            // === 系统信息 ===
            sys_info: { description: '获取系统信息（主机名/CPU/内存/磁盘/网络）', parameters: { type: 'object', properties: {} } },
            sys_time: { description: '获取当前系统时间', parameters: { type: 'object', properties: {} } },
            network_info: { description: '获取网络配置信息（IP地址/接口/DNS）', parameters: { type: 'object', properties: {} } },

            // === 系统操控 ===
            system_power: { description: '电源管理：关机/重启/睡眠/锁定/注销', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['shutdown', 'restart', 'sleep', 'lock', 'logout', 'hibernate'] } }, required: ['action'] } },
            system_clipboard_get: { description: '获取剪贴板文本内容', parameters: { type: 'object', properties: {} } },
            system_clipboard_set: { description: '设置剪贴板文本', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            system_notification: { description: '发送 Windows Toast 通知', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title', 'message'] } },
            system_open_file: { description: '用默认程序打开文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
            system_open_url: { description: '用默认浏览器打开 URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
            desktop_screenshot: { description: '截取桌面屏幕截图', parameters: { type: 'object', properties: { path: { type: 'string', description: '保存路径（可选）' } } } },

            // === 注册表（高风险） ===
            registry_read: { description: '读取注册表项', parameters: { type: 'object', properties: { path: { type: 'string', description: '注册表路径' } }, required: ['path'] } },
            registry_write: { description: '写入注册表项', parameters: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, type: { type: 'string' } }, required: ['path', 'name', 'value'] } },

            // === 网络请求 ===
            http_get: { description: '发送 HTTP GET 请求', parameters: { type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object' }, timeout: { type: 'number' } }, required: ['url'] } },
            http_post: { description: '发送 HTTP POST 请求', parameters: { type: 'object', properties: { url: { type: 'string' }, body: { type: 'object' }, headers: { type: 'object' }, timeout: { type: 'number' } }, required: ['url'] } },

            // === 浏览器自动化 ===
            browser_open: { description: '打开浏览器并访问 URL', parameters: { type: 'object', properties: { url: { type: 'string' }, pageId: { type: 'string' }, headless: { type: 'boolean' } }, required: ['url'] } },
            browser_click: { description: '点击页面元素', parameters: { type: 'object', properties: { selector: { type: 'string' }, pageId: { type: 'string' }, timeout: { type: 'number' } }, required: ['selector'] } },
            browser_type: { description: '在页面输入框中输入文本', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, pageId: { type: 'string' }, timeout: { type: 'number' } }, required: ['selector', 'text'] } },
            browser_screenshot: { description: '截取浏览器页面截图', parameters: { type: 'object', properties: { path: { type: 'string' }, pageId: { type: 'string' }, fullPage: { type: 'boolean' } } } },
            browser_get_html: { description: '获取页面 HTML 源码', parameters: { type: 'object', properties: { pageId: { type: 'string' } } } },
            browser_close: { description: '关闭浏览器页面', parameters: { type: 'object', properties: { pageId: { type: 'string' } } } },

            // === UI-TARS GUI 自动化（通过视觉控制桌面） ===
            gui_screenshot: { description: '截取当前屏幕截图，用于了解屏幕状态', parameters: { type: 'object', properties: { instruction: { type: 'string' } } } },
            gui_click: { description: '在屏幕坐标(x,y)处点击鼠标左键', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
            gui_double_click: { description: '在屏幕坐标处双击鼠标左键', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
            gui_right_click: { description: '在屏幕坐标处点击鼠标右键', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
            gui_type_text: { description: '在当前焦点处输入文本', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            gui_scroll: { description: '滚动屏幕', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } },
            gui_move_mouse: { description: '移动鼠标到坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
            gui_get_cursor: { description: '获取当前鼠标位置', parameters: { type: 'object', properties: {} } },
            gui_analyze_screen: { description: '截屏并分析屏幕内容', parameters: { type: 'object', properties: { instruction: { type: 'string', description: '分析指令' } }, required: ['instruction'] } },
            gui_run_task: { description: '执行完整 GUI 操作任务（自动截图→操作→验证）', parameters: { type: 'object', properties: { instruction: { type: 'string' }, maxSteps: { type: 'number' } }, required: ['instruction'] } },

            // === 自我诊断与修复工具 ===
            self_diagnose: { description: '扫描源代码文件查找常见问题（假成功消息、空catch块、静默吞没错误等）', parameters: { type: 'object', properties: { file: { type: 'string', description: '要扫描的文件路径（可选，不指定则扫描整个项目）' }, deep: { type: 'boolean', description: '是否深度扫描整个项目' }, project: { type: 'string', description: '项目根目录（可选）' } } } },
            self_apply_fix: { description: '对指定文件自动应用修复（修复假成功catch块、空catch等）', parameters: { type: 'object', properties: { file: { type: 'string', description: '要修复的文件路径' }, issueLine: { type: 'number', description: '问题所在行号（可选）' }, fixType: { type: 'string', enum: ['catch_false_success', 'silent_catch', 'auto'], description: '修复类型' } }, required: ['file'] } },
            self_verify: { description: '验证修复是否成功：检查文件存在、JS语法、备份文件、修改内容', parameters: { type: 'object', properties: { file: { type: 'string' }, backupFile: { type: 'string' } }, required: ['file'] } },
        };

        const tools = [];
        for (const [name, info] of Object.entries(schemaMap)) {
            if (this.toolRegistry[name]) {
                tools.push({
                    type: 'function',
                    function: {
                        name,
                        description: info.description,
                        parameters: info.parameters
                    }
                });
            }
        }

        // Code tool definitions (Diff / LSP / AST)
        const codeSchemaMap = {
            // === Diff/Apply 工具 ===
            diff_generate: { description: '生成 unified diff 格式补丁 (对比两段文本差异)', parameters: { type: 'object', properties: { original: { type: 'string', description: '原始文本' }, modified: { type: 'string', description: '修改后文本' }, context: { type: 'number', description: '上下文行数 (默认3)' }, filePath: { type: 'string', description: '文件名 (用于diff头部)' } }, required: ['original', 'modified'] } },
            diff_apply: { description: '应用 unified diff 补丁到文本内容', parameters: { type: 'object', properties: { content: { type: 'string', description: '原文内容' }, diff: { type: 'string', description: 'unified diff 补丁文本' } }, required: ['content', 'diff'] } },
            diff_compare: { description: '对比两个文件或文本的差异', parameters: { type: 'object', properties: { fileA: { type: 'string' }, fileB: { type: 'string' }, textA: { type: 'string' }, textB: { type: 'string' } } } },

            // === LSP 工具 ===
            lsp_start: { description: '启动 LSP 语言服务器 (提供代码智能)', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'json', 'html', 'css'] }, rootPath: { type: 'string', description: '项目根目录' } }, required: ['language'] } },
            lsp_diagnostics: { description: '获取代码诊断信息 (错误/警告)', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
            lsp_complete: { description: '获取代码补全建议', parameters: { type: 'object', properties: { filePath: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['filePath', 'line', 'character'] } },
            lsp_hover: { description: '获取鼠标悬停时的类型/文档信息', parameters: { type: 'object', properties: { filePath: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['filePath', 'line', 'character'] } },
            lsp_definition: { description: '跳转到符号定义位置', parameters: { type: 'object', properties: { filePath: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['filePath', 'line', 'character'] } },

            // === AST 工具 ===
            ast_parse: { description: '解析代码 AST 结构概览', parameters: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string' } }, required: ['code'] } },
            ast_functions: { description: '提取代码中的函数/类/变量定义', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
            ast_complexity: { description: '分析代码圈复杂度', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
        };

        for (const [name, info] of Object.entries(codeSchemaMap)) {
            if (this.toolRegistry[name]) {
                tools.push({
                    type: 'function',
                    function: { name, description: info.description, parameters: info.parameters }
                });
            }
        }

        return tools;
    }

    _loadExtendedTools() {
        try {
            const ExtendedTools = require('./ExtendedTools');
            Object.assign(this.toolRegistry, ExtendedTools);
        } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }
    }

    _buildRegistry() {
        const self = this; // For GUI handlers that need access to getGuiOperator()
        return {
            file_read: async (params) => {
                const content = fs.readFileSync(params.path, 'utf8');
                return { verified: true, data: { content, size: content.length } };
            },
            file_write: async (params) => {
                const dir = path.dirname(params.path);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(params.path, params.content, params.encoding || 'utf8');
                return { verified: true, data: { path: params.path, bytesWritten: params.content.length } };
            },
            file_exists: async (params) => {
                return { verified: true, data: { exists: fs.existsSync(params.path) } };
            },
            file_delete: async (params) => {
                if (!fs.existsSync(params.path)) throw new Error(`File not found: ${params.path}`);
                fs.unlinkSync(params.path);
                return { verified: true, data: { deleted: true, path: params.path } };
            },
            file_copy: async (params) => {
                const destDir = path.dirname(params.dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                fs.copyFileSync(params.src, params.dest);
                return { verified: true, data: { src: params.src, dest: params.dest } };
            },
            file_move: async (params) => {
                const destDir = path.dirname(params.dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                fs.renameSync(params.src, params.dest);
                return { verified: true, data: { src: params.src, dest: params.dest } };
            },
            dir_create: async (params) => {
                if (!fs.existsSync(params.path)) fs.mkdirSync(params.path, { recursive: true });
                return { verified: true, data: { path: params.path, created: true } };
            },
            dir_list: async (params) => {
                if (!fs.existsSync(params.path)) throw new Error(`Directory not found: ${params.path}`);
                const entries = fs.readdirSync(params.path, { withFileTypes: true });
                const result = entries.map(e => ({ name: e.name, isDir: e.isDirectory() }));
                if (params.recursive) {
                    const all = [];
                    const walk = (dir) => {
                        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                            all.push({ name: e.name, isDir: e.isDirectory(), path: path.join(dir, e.name) });
                            if (e.isDirectory()) walk(path.join(dir, e.name));
                        }
                    };
                    walk(params.path);
                    return { verified: true, data: { entries: all } };
                }
                return { verified: true, data: { entries: result } };
            },
            exec_cmd: async (params) => {
                const cmd = params.cmd;
                const cwd = params.cwd || os.homedir();
                const timeout = params.timeout || 60000;
                // Write as .cmd file then execute via cmd.exe to avoid WSL/bash syntax differences
                const tmpFile = path.join(os.tmpdir(), `hyperagent_cmd_${Date.now()}.cmd`);
                fs.writeFileSync(tmpFile, cmd, 'utf8');
                try {
                    return await new Promise((resolve) => {
                        exec(`"${tmpFile}"`, { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 },
                            (error, stdout, stderr) => {
                                const stdOut = (stdout || '').trim();
                                const stdErr = (stderr || '').trim();
                                if (error) {
                                    const errMsg = stdErr || error.message;
                                    resolve({ verified: false, error: errMsg.substring(0, 500), stderr: stdErr, stdout: stdOut });
                                } else {
                                    resolve({ verified: true, data: { stdout: stdOut, stderr: stdErr } });
                                }
                            });
                    });
                } finally {
                    try { fs.unlinkSync(tmpFile); } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }
                }
            },
            exec_powershell: async (params) => {
                const tmpFile = path.join(os.tmpdir(), `hyperagent_ps_${Date.now()}.ps1`);
                fs.writeFileSync(tmpFile, params.script, 'utf8');
                return new Promise((resolve) => {
                    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
                        { encoding: 'utf8', timeout: params.timeout || 60000 },
                        (error, stdout) => {
                            try { fs.unlinkSync(tmpFile); } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }
                            if (error) resolve({ verified: false, error: error.message });
                            else resolve({ verified: true, data: { output: stdout.trim() } });
                        });
                });
            },
            http_get: async (params) => {
                return new Promise((resolve) => {
                    const parsed = new url.URL(params.url);
                    const client = parsed.protocol === 'https:' ? https : http;
                    const req = client.request({
                        hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname + parsed.search, method: 'GET',
                        headers: params.headers || {}, timeout: params.timeout || 10000
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve({ verified: true, data: { status: res.statusCode, body: data.substring(0, 50000) } }));
                    });
                    req.on('error', e => resolve({ verified: false, error: e.message }));
                    req.on('timeout', () => { req.destroy(); resolve({ verified: false, error: 'Request timeout' }); });
                    req.end();
                });
            },
            http_post: async (params) => {
                return new Promise((resolve) => {
                    const parsed = new url.URL(params.url);
                    const client = parsed.protocol === 'https:' ? https : http;
                    const postData = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
                    const req = client.request({
                        hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname + parsed.search, method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...params.headers }, timeout: params.timeout || 10000
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve({ verified: true, data: { status: res.statusCode, body: data.substring(0, 50000) } }));
                    });
                    req.on('error', e => resolve({ verified: false, error: e.message }));
                    req.on('timeout', () => { req.destroy(); resolve({ verified: false, error: 'Request timeout' }); });
                    req.write(postData);
                    req.end();
                });
            },
            process_list: async (params) => {
                const output = execSync(`tasklist /FI "IMAGENAME eq ${params.filter || '*'}" /FO CSV /NH`, { encoding: 'utf8' });
                const processes = output.trim().split('\n').map(l => {
                    const parts = l.replace(/"/g, '').split(',');
                    return { name: parts[0], pid: parts[1], mem: parts[4] };
                }).filter(p => p.name);
                return { verified: true, data: { processes } };
            },
            process_kill: async (params) => {
                execSync(`taskkill /F /PID ${params.pid}`, { encoding: 'utf8' });
                return { verified: true, data: { killed: true, pid: params.pid } };
            },
            sys_time: async () => {
                return { verified: true, data: { iso: new Date().toISOString(), local: new Date().toLocaleString(), unix: Date.now() } };
            },
            sys_info: async () => {
                return { verified: true, data: {
                    hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
                    cpuCount: os.cpus().length,
                    totalMem: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                    freeMem: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                    uptime: (os.uptime() / 86400).toFixed(1) + ' days'
                }};
            },
            text_search: async (params) => {
                if (!fs.existsSync(params.path)) throw new Error(`File not found: ${params.path}`);
                const content = fs.readFileSync(params.path, 'utf8');
                const regex = new RegExp(params.pattern, params.caseSensitive ? 'g' : 'gi');
                const matches = content.match(regex) || [];
                return { verified: true, data: { matches: matches.slice(0, 100), count: matches.length } };
            },
            text_replace: async (params) => {
                if (!fs.existsSync(params.path)) throw new Error(`File not found: ${params.path}`);
                let content = fs.readFileSync(params.path, 'utf8');
                const regex = new RegExp(params.pattern, params.replaceAll !== false ? 'g' : '');
                const count = (content.match(regex) || []).length;
                content = content.replace(regex, params.replacement);
                fs.writeFileSync(params.path, content, 'utf8');
                return { verified: true, data: { replaced: count, path: params.path } };
            },
            eval_js: async (params) => {
                try {
                    const SafeSandbox = require('./SafeSandbox');
                    const sandbox = new SafeSandbox();
                    const result = sandbox.execute(params.code, params.context || {});
                    return { verified: result.success, data: result, error: result.error };
                } catch (e) { return { verified: false, error: e.message }; }
            },

            // UI-TARS GUI automation tools (lazy init)
            gui_screenshot: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available (UI-TARS SDK required)' };
                const result = await gui.executeAction('screenshot', { returnBase64: true });
                return { verified: result.success, data: { screenshot: result.base64 ? result.base64.substring(0, 100) + '...(base64)' : null, path: result.path } };
            },
            gui_click: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('click', { x: params.x, y: params.y });
                return { verified: result.success, data: result };
            },
            gui_double_click: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('doubleClick', { x: params.x, y: params.y });
                return { verified: result.success, data: result };
            },
            gui_right_click: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('rightClick', { x: params.x, y: params.y });
                return { verified: result.success, data: result };
            },
            gui_type_text: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('type', { text: params.text });
                return { verified: result.success, data: result };
            },
            gui_scroll: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('scroll', { x: params.x || 0, y: params.y || 0 });
                return { verified: result.success, data: result };
            },
            gui_move_mouse: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('moveMouse', { x: params.x, y: params.y });
                return { verified: result.success, data: result };
            },
            gui_get_cursor: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.executeAction('getCursorPosition', {});
                return { verified: result.success, data: result };
            },
            gui_analyze_screen: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available' };
                const result = await gui.analyzeScreen(params.instruction || '描述当前屏幕内容');
                return { verified: result.success, data: result };
            },
            gui_run_task: async (params) => {
                const gui = await self.getGuiOperator();
                if (!gui) return { verified: false, error: 'GUI Operator not available (UI-TARS SDK required)' };
                const result = await gui.runTask(params.instruction, { maxLoopCount: params.maxSteps || 30 });
                return { verified: result.success, data: result };
            },
            echo: async (params) => ({ verified: true, data: { message: params.message || params.text || 'Hello' } }),
            chat: async (params) => ({ verified: true, data: { reply: params.message || 'Hello!' } }),

            // Code tools (Diff / LSP / AST)
            diff_generate: async (params) => {
                try { return require('./CodeTools').DiffTools.diff_generate(params); }
                catch (e) { return { verified: false, error: `diff_generate 失败: ${e.message}` }; }
            },
            diff_apply: async (params) => {
                try { return require('./CodeTools').DiffTools.diff_apply(params); }
                catch (e) { return { verified: false, error: `diff_apply 失败: ${e.message}` }; }
            },
            diff_compare: async (params) => {
                try { return await require('./CodeTools').DiffTools.diff_compare(params); }
                catch (e) { return { verified: false, error: `diff_compare 失败: ${e.message}` }; }
            },
            lsp_start: async (params) => {
                try { return await require('./CodeTools').LSPTools.lsp_start(params); }
                catch (e) { return { verified: false, error: `lsp_start 失败: ${e.message}` }; }
            },
            lsp_diagnostics: async (params) => {
                try { return await require('./CodeTools').LSPTools.lsp_diagnostics(params); }
                catch (e) { return { verified: false, error: `lsp_diagnostics 失败: ${e.message}` }; }
            },
            lsp_complete: async (params) => {
                try { return await require('./CodeTools').LSPTools.lsp_complete(params); }
                catch (e) { return { verified: false, error: `lsp_complete 失败: ${e.message}` }; }
            },
            lsp_hover: async (params) => {
                try { return await require('./CodeTools').LSPTools.lsp_hover(params); }
                catch (e) { return { verified: false, error: `lsp_hover 失败: ${e.message}` }; }
            },
            lsp_definition: async (params) => {
                try { return await require('./CodeTools').LSPTools.lsp_definition(params); }
                catch (e) { return { verified: false, error: `lsp_definition 失败: ${e.message}` }; }
            },
            ast_parse: async (params) => {
                try { return require('./CodeTools').ASTTools.ast_parse(params); }
                catch (e) { return { verified: false, error: `ast_parse 失败: ${e.message}` }; }
            },
            ast_functions: async (params) => {
                try { return require('./CodeTools').ASTTools.ast_functions(params); }
                catch (e) { return { verified: false, error: `ast_functions 失败: ${e.message}` }; }
            },
            ast_complexity: async (params) => {
                try { return require('./CodeTools').ASTTools.ast_complexity(params); }
                catch (e) { return { verified: false, error: `ast_complexity 失败: ${e.message}` }; }
            },
            calc_basic: async (params) => {
                try {
                    const SafeSandbox = require('./SafeSandbox');
                    const sandbox = new SafeSandbox();
                    const result = sandbox.evalMath(params.expr);
                    return { verified: result.success, data: { result: result.result }, error: result.error };
                } catch (e) { return { verified: false, error: e.message }; }
            },
            // Self-diagnosis — scan source for common issues
            self_diagnose: async (params) => {
                const targetFile = params.file || params.path || '';
                const issues = [];
                const scoredFiles = [];

                // Single file scan
                if (targetFile) {
                    if (!fs.existsSync(targetFile)) return { verified: false, error: `File not found: ${targetFile}` };
                    const code = fs.readFileSync(targetFile, 'utf8');
                    const lines = code.split('\n');
                    const filename = path.basename(targetFile);

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        // Catch blocks with fake success
                        if (line.includes('catch') && i + 1 < lines.length) {
                            const catchBlock = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
                            if ((catchBlock.includes('执行完成') || catchBlock.includes('已执行') || catchBlock.includes('success')) &&
                                !catchBlock.includes('error') && !catchBlock.includes('Error') && !catchBlock.includes('失败') && !catchBlock.includes('错误')) {
                                issues.push({ file: targetFile, line: i + 1, severity: 'high', type: 'false_success_in_catch', description: 'Catch 块中可能压制了错误，返回假成功消息' });
                            }
                        }
                        // Unverified tool_result handling
                        if (line.includes('tool_result') && line.includes('content') && !line.includes('is_error') && !line.includes('error')) {
                            issues.push({ file: targetFile, line: i + 1, severity: 'medium', type: 'missing_error_check', description: '处理 tool_result 时未检查 is_error 标志' });
                        }
                        // Empty catch blocks
                        const emptyCatchMatch = line.match(/catch\s*\([^)]*\)\s*\{\s*\}/);
                        if (emptyCatchMatch) {
                            issues.push({ file: targetFile, line: i + 1, severity: 'medium', type: 'empty_catch', description: '空的 catch 块，错误被静默吞没' });
                        }
                        // Silent .catch() with no-op
                        if (line.includes('.catch(()') || line.includes(".catch(() ") || line.includes(".catch(()=>") || line.includes(".catch(() =>")) {
                            issues.push({ file: targetFile, line: i + 1, severity: 'medium', type: 'silent_catch', description: '.catch(()) 静默吞没错误，应至少打印错误' });
                        }
                    }
                }

                // Project-wide scan of JS files
                const projectDir = params.project || path.join(__dirname, '..', '..');
                if (!targetFile || params.deep) {
                    const scanPatterns = [
                        { pattern: /catch\s*\([^)]*\)\s*\{[^}]*执行完成[^}]*\}/g, severity: 'high', type: 'false_success', msg: 'Catch 块返回假成功消息' },
                        { pattern: /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, severity: 'medium', type: 'silent_catch', msg: '.catch 静默吞没错误' },
                        { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g, severity: 'medium', type: 'empty_catch', msg: '空 catch 块' },
                    ];

                    const jsFiles = [];
                    const walkDir = (dir) => {
                        try {
                            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                                const full = path.join(dir, e.name);
                                if (e.isDirectory() && !e.name.startsWith('.') && !e.name.includes('node_modules') && !e.name.includes('checkpoints') && !e.name.includes('archives')) {
                                    walkDir(full);
                                } else if (e.isFile() && e.name.endsWith('.js') && !full.includes('node_modules')) {
                                    jsFiles.push(full);
                                }
                            }
                        } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }
                    };
                    walkDir(projectDir);

                    for (const file of jsFiles.slice(0, 30)) { // 最多扫描30个文件
                        const code = fs.readFileSync(file, 'utf8');
                        const lines = code.split('\n');
                        let fileScore = 0;
                        let fileIssues = 0;

                        for (let i = 0; i < lines.length; i++) {
                            // 检查假成功模式
                            if (lines[i].includes('catch') && i + 1 < lines.length) {
                                const block = lines.slice(i, Math.min(i + 6, lines.length)).join('\n');
                                if ((block.includes('执行完成') || block.includes('已执行')) &&
                                    !block.includes('error') && !block.includes('Error') && !block.includes('失败')) {
                                    issues.push({ file, line: i + 1, severity: 'high', type: 'false_success', description: 'Catch 块可能返回假成功' });
                                    fileScore += 10; fileIssues++;
                                }
                            }
                            if (lines[i].includes('.catch(()') || lines[i].includes('.catch(() =>')) {
                                issues.push({ file, line: i + 1, severity: 'medium', type: 'silent_catch', description: '.catch 静默吞没错误' });
                                fileScore += 5; fileIssues++;
                            }
                            if (lines[i].match(/catch\s*\([^)]*\)\s*\{\s*\}/)) {
                                issues.push({ file, line: i + 1, severity: 'medium', type: 'empty_catch', description: '空 catch 块' });
                                fileScore += 5; fileIssues++;
                            }
                        }
                        if (fileIssues > 0) {
                            scoredFiles.push({ file, issues: fileIssues, score: fileScore, importance: fileScore > 10 ? 'high' : 'medium' });
                        }
                    }
                }

                // Sort: high severity first
                const severityOrder = { high: 0, medium: 1, low: 2 };
                issues.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

                return {
                    verified: true,
                    data: {
                        scanned: targetFile || (params.deep ? 'project' : 'target'),
                        totalIssues: issues.length,
                        highSeverity: issues.filter(i => i.severity === 'high').length,
                        mediumSeverity: issues.filter(i => i.severity === 'medium').length,
                        issues: issues.slice(0, 50),
                        topFiles: scoredFiles.sort((a, b) => b.score - a.score).slice(0, 10),
                        summary: issues.length > 0
                            ? `发现 ${issues.length} 个问题（高危 ${issues.filter(i => i.severity === 'high').length} 个，中危 ${issues.filter(i => i.severity === 'medium').length} 个）`
                            : '未发现已知问题模式'
                    }
                };
            },
            // Self-fix — apply fixes to specified file
            self_apply_fix: async (params) => {
                const { file, issueLine, fixType } = params;
                if (!file || !fs.existsSync(file)) return { verified: false, error: `File not found: ${file}` };

                const code = fs.readFileSync(file, 'utf8');
                const lines = code.split('\n');
                let modified = false;

                if (fixType === 'catch_false_success' || fixType === 'auto') {
                    // Fix fake success in catch blocks: add warn + return real error
                    for (let i = 0; i < lines.length; i++) {
                        if (issueLine && Math.abs(i + 1 - issueLine) > 3) continue;
                        if (issueLine && i + 1 !== issueLine && i + 1 !== issueLine + 1) continue;

                        const trimmed = lines[i].trim();
                        if (trimmed.startsWith('catch') && trimmed.includes('{')) {
                            const indent = lines[i].match(/^\s*/)[0];
                            let j = i + 1;
                            while (j < lines.length && !lines[j].includes('}')) j++;
                            if (j > i + 1) {
                                const blockContent = lines.slice(i + 1, j).join('\n');
                                // Only fix if block contains fake-success keywords
                                if (blockContent.includes('执行完成') || blockContent.includes('已执行') || blockContent.includes('success')) {
                                    const errVar = trimmed.match(/catch\s*\((\w+)\)/);
                                    const errName = errVar ? errVar[1] : 'e';
                                    // Prepend console.warn at block start
                                    lines[i + 1] = `${indent}  console.warn('[自修复] 操作失败:', ${errName}.message);`;
                                    // Replace fake-success with error reporting
                                    for (let k = i + 1; k < j; k++) {
                                        if (lines[k].includes('执行完成') || lines[k].includes('已执行')) {
                                            lines[k] = lines[k].replace(
                                                /`[^`]*(?:执行完成|已执行)[^`]*`|'[^']*(?:执行完成|已执行)[^']*'|"[^"]*(?:执行完成|已执行)[^"]*"/g,
                                                '`操作失败: ${' + errName + '.message}`'
                                            );
                                        }
                                    }
                                    modified = true;
                                }
                            }
                        }
                    }
                }

                if (fixType === 'silent_catch' || fixType === 'auto') {
                    for (let i = 0; i < lines.length; i++) {
                        if (issueLine && i + 1 !== issueLine) continue;
                        const match = lines[i].match(/^(\s*)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
                        if (match) {
                            lines[i] = `${match[1]}.catch((err) => console.warn('[自修复] 操作失败:', err.message))`;
                            modified = true;
                        }
                    }
                }

                if (!modified) return { verified: true, data: { applied: false, reason: '未找到需修复的代码模式' } };

                const newCode = lines.join('\n');
                fs.writeFileSync(file, newCode, 'utf8');
                const backupFile = file + '.bak';
                fs.writeFileSync(backupFile, code, 'utf8');
                return {
                    verified: true,
                    data: {
                        applied: true,
                        file,
                        backupFile,
                        fixType: fixType || 'auto',
                        summary: `已修复 ${file}，备份在 ${backupFile}`
                    }
                };
            },
            // Self-verify — validate that fixes resolved known issues
            self_verify: async (params) => {
                const { file, backupFile } = params;
                const verifications = [];

                // 1. 验证修复文件是否存在
                if (file) {
                    if (!fs.existsSync(file)) {
                        verifications.push({ check: 'file_exists', passed: false, detail: `修复文件不存在: ${file}` });
                    } else {
                        const stat = fs.statSync(file);
                        verifications.push({ check: 'file_exists', passed: true, detail: `文件存在 (${stat.size} 字节)` });

                        // 2. 语法检查: 尝试用 Node.js 检查 JS 语法
                        if (file.endsWith('.js')) {
                            try {
                                const code = fs.readFileSync(file, 'utf8');
                                // 尝试解析 JS 语法 (粗略检查)
                                new Function(code);
                                verifications.push({ check: 'js_syntax', passed: true, detail: 'JavaScript 语法通过' });
                            } catch (e) {
                                verifications.push({ check: 'js_syntax', passed: false, detail: `语法错误: ${e.message}` });
                            }
                        }
                    }
                }

                // 2. 验证备份文件
                if (backupFile) {
                    if (fs.existsSync(backupFile)) {
                        verifications.push({ check: 'backup_exists', passed: true, detail: `备份文件存在: ${backupFile}` });
                    } else {
                        verifications.push({ check: 'backup_exists', passed: false, detail: '备份文件不存在' });
                    }
                }

                // 3. If backup exists, check what changed
                if (file && backupFile && fs.existsSync(file) && fs.existsSync(backupFile)) {
                    const newCode = fs.readFileSync(file, 'utf8');
                    const oldCode = fs.readFileSync(backupFile, 'utf8');
                    if (newCode !== oldCode) {
                        const newLines = newCode.split('\n');
                        const oldLines = oldCode.split('\n');
                        let changed = 0, added = 0, removed = 0;
                        for (let i = 0; i < Math.max(newLines.length, oldLines.length); i++) {
                            if (i >= oldLines.length) added++;
                            else if (i >= newLines.length) removed++;
                            else if (newLines[i] !== oldLines[i]) changed++;
                        }
                        verifications.push({
                            check: 'diff',
                            passed: true,
                            detail: `文件已修改: 变更 ${changed} 行, 新增 ${added} 行, 删除 ${removed} 行`
                        });
                    } else {
                        verifications.push({ check: 'diff', passed: true, detail: '文件未发生变化' });
                    }
                }

                const allPassed = verifications.every(v => v.passed);
                return {
                    verified: true,
                    data: {
                        allPassed,
                        verifications,
                        summary: allPassed ? '所有验证通过' : `${verifications.filter(v => !v.passed).length} 项验证未通过`
                    }
                };
            }
        };
    }
}

module.exports = ToolExecutor;
