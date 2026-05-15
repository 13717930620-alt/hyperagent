/**
 * CodeTools — diff/apply, LSP integration, and AST operations for code engineering.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Diff / Apply tools

const DiffTools = {
    /**
     * 生成 unified diff 格式的补丁
     * @param {Object} params - { original: string, modified: string, context?: number, filePath?: string }
     * @returns {Object} { verified, data: { diff, stats } }
     */
    diff_generate: (params) => {
        const { original, modified, context = 3, filePath = 'file' } = params;
        if (typeof original !== 'string' || typeof modified !== 'string') {
            return { verified: false, error: 'original 和 modified 必须是字符串' };
        }

        const origLines = original.split('\n');
        const modLines = modified.split('\n');

        // 简单 LCS 差异算法
        const diff = _computeDiff(origLines, modLines);
        const hunks = _buildHunks(diff, context);

        if (hunks.length === 0) {
            return { verified: true, data: { diff: '', stats: { added: 0, removed: 0, changed: 0 }, unchanged: true } };
        }

        // 生成 unified diff 文本
        const diffLines = [];
        diffLines.push(`--- a/${filePath}`);
        diffLines.push(`+++ b/${filePath}`);

        let totalAdded = 0;
        let totalRemoved = 0;

        for (const hunk of hunks) {
            diffLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
            for (const line of hunk.lines) {
                diffLines.push(line.prefix + line.content);
                if (line.prefix === '+') totalAdded++;
                else if (line.prefix === '-') totalRemoved++;
            }
        }

        return {
            verified: true,
            data: {
                diff: diffLines.join('\n'),
                stats: {
                    added: totalAdded,
                    removed: totalRemoved,
                    changed: hunks.length,
                    hunks: hunks.length
                },
                format: 'unified'
            }
        };
    },

    /**
     * 应用 unified diff 补丁到文本
     * @param {Object} params - { content: string, diff: string }
     * @returns {Object} { verified, data: { result, applied, failed } }
     */
    diff_apply: (params) => {
        const { content, diff } = params;
        if (typeof content !== 'string' || typeof diff !== 'string') {
            return { verified: false, error: 'content 和 diff 必须是字符串' };
        }

        const lines = content.split('\n');
        const diffLines = diff.split('\n');

        // 解析 diff
        const hunks = _parseUnifiedDiff(diffLines);
        if (hunks.length === 0) {
            return { verified: false, error: '无法解析 diff 格式' };
        }

        // Apply in reverse (bottom-up to avoid offset issues)
        let result = [...lines];
        let applied = 0;
        let failed = 0;
        const errors = [];

        // 按 oldStart 降序排列
        hunks.sort((a, b) => b.oldStart - a.oldStart);

        for (const hunk of hunks) {
            // 提取旧文本块
            const oldLines = hunk.lines
                .filter(l => l.prefix === ' ' || l.prefix === '-')
                .map(l => l.content);

            const startIdx = hunk.oldStart - 1; // 0-indexed
            const actualLines = result.slice(startIdx, startIdx + oldLines.length);

            // 验证上下文匹配
            let match = true;
            for (let i = 0; i < oldLines.length; i++) {
                if (actualLines[i] !== oldLines[i]) {
                    // 尝试模糊匹配: 忽略首尾空格
                    if (actualLines[i]?.trim() !== oldLines[i]?.trim()) {
                        match = false;
                        break;
                    }
                }
            }

            if (!match) {
                failed++;
                errors.push(`Hunk at line ${hunk.oldStart} 不匹配`);
                continue;
            }

            // 替换为新的文本块
            const newLines = hunk.lines
                .filter(l => l.prefix === ' ' || l.prefix === '+')
                .map(l => l.content);

            result.splice(startIdx, oldLines.length, ...newLines);
            applied++;
        }

        return {
            verified: applied > 0,
            data: {
                result: result.join('\n'),
                stats: { applied, failed, total: hunks.length }
            },
            error: errors.length > 0 ? errors.join('; ') : null
        };
    },

    /**
     * 对比两个文件或字符串
     * @param {Object} params - { fileA?: string, fileB?: string, textA?: string, textB?: string }
     */
    diff_compare: async (params) => {
        const { fileA, fileB, textA, textB } = params;

        let contentA = textA;
        let contentB = textB;

        if (fileA) {
            try { contentA = await fs.promises.readFile(fileA, 'utf8'); }
            catch (e) { return { verified: false, error: `无法读取 ${fileA}: ${e.message}` }; }
        }
        if (fileB) {
            try { contentB = await fs.promises.readFile(fileB, 'utf8'); }
            catch (e) { return { verified: false, error: `无法读取 ${fileB}: ${e.message}` }; }
        }

        if (typeof contentA !== 'string' || typeof contentB !== 'string') {
            return { verified: false, error: '需要两个输入进行对比' };
        }

        const labelA = fileA || 'original';
        const labelB = fileB || 'modified';

        const result = DiffTools.diff_generate({
            original: contentA,
            modified: contentB,
            filePath: labelA,
            context: 3
        });

        if (result.verified && result.data.unchanged) {
            return { verified: true, data: { message: '两个文件完全相同' } };
        }

        return result;
    }
};

// LSP integration (Language Server Protocol)

class LSPClient {
    constructor() {
        this._servers = new Map(); // language -> { process, capabilities, requestId }
        this._requestId = 1;

        // 已知的 LSP 服务器命令
        this._serverCommands = {
            'javascript': { command: 'node', args: [require.resolve('typescript-language-server/lib/lsp-server.js')], argsAlt: ['typescript-language-server', '--stdio'] },
            'typescript': { command: 'node', args: [require.resolve('typescript-language-server/lib/lsp-server.js')], argsAlt: ['typescript-language-server', '--stdio'] },
            'python': { command: 'pyright-langserver', args: ['--stdio'], argsAlt: ['pylsp'] },
            'go': { command: 'gopls', args: [] },
            'rust': { command: 'rust-analyzer', args: [] },
            'java': { command: 'jdtls', args: [] },
            'json': { command: 'vscode-json-languageserver', args: ['--stdio'] },
            'html': { command: 'vscode-html-languageserver', args: ['--stdio'] },
            'css': { command: 'vscode-css-languageserver', args: ['--stdio'] },
        };
    }

    _detectLanguage(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const map = {
            '.js': 'javascript', '.jsx': 'javascript',
            '.ts': 'typescript', '.tsx': 'typescript',
            '.py': 'python',
            '.go': 'go',
            '.rs': 'rust',
            '.java': 'java',
            '.json': 'json',
            '.html': 'html', '.htm': 'html',
            '.css': 'css', '.scss': 'css',
        };
        return map[ext] || 'unknown';
    }

    /**
     * 启动 LSP 服务器
     */
    async startServer(language, rootPath = process.cwd()) {
        if (this._servers.has(language)) return true;

        const config = this._serverCommands[language];
        if (!config) {
            throw new Error(`不支持的 LSP 语言: ${language}`);
        }

        // 尝试不同的启动命令
        let proc = null;
        const attempts = [
            { command: config.command, args: config.args },
            ...(config.argsAlt ? [{ command: config.argsAlt[0], args: config.argsAlt.slice(1) }] : [])
        ];

        for (const attempt of attempts) {
            try {
                proc = spawn(attempt.command, attempt.args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: rootPath
                });
                proc.on('error', () => { proc = null; });
                if (proc.pid) break;
            } catch (e) {
                proc = null;
            }
        }

        if (!proc) {
            throw new Error(`无法启动 LSP 服务器: ${language} (请安装 ${config.command})`);
        }

        let buffer = '';
        const server = {
            process: proc,
            capabilities: {},
            pending: new Map(),
            initialized: false,
            rootPath
        };

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            this._processMessages(server, buffer, (msg) => {
                buffer = buffer.substring(buffer.indexOf(JSON.stringify(msg)) + JSON.stringify(msg).length);
            });
        });

        // 发送 initialize 请求
        await this._sendRequest(server, 'initialize', {
            processId: process.pid,
            rootUri: `file://${rootPath.replace(/\\/g, '/')}`,
            capabilities: {
                textDocument: {
                    synchronization: { didSave: true },
                    completion: { completionItem: { snippetSupport: true } },
                    hover: true,
                    definition: true,
                    references: true,
                    diagnostic: true
                }
            }
        });

        // 发送 initialized 通知
        this._sendNotification(server, 'initialized', {});
        server.initialized = true;

        this._servers.set(language, server);
        console.log(`[LSP] ${language} 服务器已启动 (pid=${proc.pid})`);
        return true;
    }

    /**
     * 打开文档
     */
    async openDocument(filePath) {
        const language = this._detectLanguage(filePath);
        const server = this._servers.get(language);
        if (!server) throw new Error(`LSP 服务器未启动: ${language}`);

        const content = await fs.promises.readFile(filePath, 'utf8');
        const uri = `file://${filePath.replace(/\\/g, '/')}`;

        this._sendNotification(server, 'textDocument/didOpen', {
            textDocument: { uri, languageId: language, version: 1, text: content }
        });

        return { uri, language, version: 1 };
    }

    /**
     * 获取诊断信息 (错误/警告)
     */
    async getDiagnostics(filePath) {
        const language = this._detectLanguage(filePath);
        const server = this._servers.get(language);
        if (!server) throw new Error(`LSP 服务器未启动: ${language}`);

        const uri = `file://${filePath.replace(/\\/g, '/')}`;

        // 发送 documentDiagnostics 请求 (部分 LSP 服务器支持)
        try {
            const result = await this._sendRequest(server, 'textDocument/diagnostic', {
                textDocument: { uri }
            });
            return result;
        } catch (e) {
            // Pull diagnostics not supported, return empty
            return { diagnostics: [] };
        }
    }

    /**
     * 获取代码补全
     */
    async getCompletions(filePath, line, column) {
        const language = this._detectLanguage(filePath);
        const server = this._servers.get(language);
        if (!server) throw new Error(`LSP 服务器未启动: ${language}`);

        const uri = `file://${filePath.replace(/\\/g, '/')}`;

        return await this._sendRequest(server, 'textDocument/completion', {
            textDocument: { uri },
            position: { line, character: column }
        });
    }

    /**
     * 获取悬停信息
     */
    async getHover(filePath, line, column) {
        const language = this._detectLanguage(filePath);
        const server = this._servers.get(language);
        if (!server) throw new Error(`LSP 服务器未启动: ${language}`);

        const uri = `file://${filePath.replace(/\\/g, '/')}`;

        return await this._sendRequest(server, 'textDocument/hover', {
            textDocument: { uri },
            position: { line, character: column }
        });
    }

    /**
     * 跳转到定义
     */
    async goToDefinition(filePath, line, column) {
        const language = this._detectLanguage(filePath);
        const server = this._servers.get(language);
        if (!server) throw new Error(`LSP 服务器未启动: ${language}`);

        const uri = `file://${filePath.replace(/\\/g, '/')}`;

        return await this._sendRequest(server, 'textDocument/definition', {
            textDocument: { uri },
            position: { line, character: column }
        });
    }

    /**
     * 关闭 LSP 服务器
     */
    async stopServer(language) {
        const server = this._servers.get(language);
        if (!server) return;

        try {
            this._sendNotification(server, 'exit', {});
            server.process.kill();
        } catch (e) { console.warn(`[atomic_executor] Unhandled error: ${e.message}`); }

        this._servers.delete(language);
        console.log(`[LSP] ${language} 服务器已关闭`);
    }

    stopAll() {
        for (const [lang] of this._servers) {
            this.stopServer(lang).catch(e => console.warn(`[atomic_executor] Caught: ${e.message}`));
        }
    }

    // ===== LSP 协议通信 =====

    _sendRequest(server, method, params) {
        return new Promise((resolve, reject) => {
            const id = this._requestId++;
            const msg = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            const timeout = setTimeout(() => {
                server.pending.delete(id);
                reject(new Error(`LSP request timeout: ${method}`));
            }, 15000);

            server.pending.set(id, { resolve, reject, timeout });
            this._writeMessage(server.process.stdin, msg);
        });
    }

    _sendNotification(server, method, params) {
        const msg = { jsonrpc: '2.0', method, params };
        this._writeMessage(server.process.stdin, msg);
    }

    _writeMessage(stdin, msg) {
        const body = JSON.stringify(msg);
        const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
        stdin.write(header + body);
    }

    _processMessages(server, data) {
        const lines = data.split('\r\n');
        let contentLength = 0;
        let inHeaders = true;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (inHeaders) {
                if (line === '') {
                    inHeaders = false;
                    continue;
                }
                const match = line.match(/Content-Length:\s*(\d+)/i);
                if (match) contentLength = parseInt(match[1]);
                continue;
            }

            if (contentLength > 0) {
                // 读取完整消息体
                const remaining = lines.slice(i).join('\r\n');
                if (remaining.length < contentLength) break;

                const body = remaining.substring(0, contentLength);
                try {
                    const msg = JSON.parse(body);
                    this._handleMessage(server, msg);
                } catch (e) {
                    // JSON 解析错误
                }

                // 跳过已消费的内容
                contentLength = 0;
                inHeaders = true;
                break;
            }
        }
    }

    _handleMessage(server, msg) {
        // 响应
        if (msg.id !== undefined && msg.id !== null) {
            const pending = server.pending.get(msg.id);
            if (pending) {
                clearTimeout(pending.timeout);
                server.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error.message));
                } else {
                    pending.resolve(msg.result);
                }
            }
        }
    }

    getStats() {
        const stats = {};
        for (const [lang, server] of this._servers) {
            stats[lang] = {
                running: !!server.process?.pid,
                initialized: server.initialized,
                pendingRequests: server.pending.size,
                rootPath: server.rootPath
            };
        }
        return stats;
    }
}

// 全局 LSP 客户端实例 (延迟初始化)
let _lspClient = null;
function getLSPClient() {
    if (!_lspClient) _lspClient = new LSPClient();
    return _lspClient;
}

// LSP 工具接口
const LSPTools = {
    /**
     * 启动 LSP 服务器
     */
    lsp_start: async (params) => {
        const { language, rootPath } = params;
        try {
            const client = getLSPClient();
            await client.startServer(language, rootPath || process.cwd());
            return { verified: true, data: { message: `${language} LSP 服务器已启动`, language } };
        } catch (e) {
            return { verified: false, error: `启动 LSP 失败: ${e.message}` };
        }
    },

    /**
     * 获取代码诊断
     */
    lsp_diagnostics: async (params) => {
        const { filePath } = params;
        try {
            const language = path.extname(filePath).slice(1);
            const client = getLSPClient();
            if (!client._servers.has(language)) {
                await client.startServer(language, path.dirname(filePath));
            }
            // 先打开文档
            await client.openDocument(filePath);
            const result = await client.getDiagnostics(filePath);
            return { verified: true, data: { diagnostics: result.diagnostics || [], filePath } };
        } catch (e) {
            return { verified: false, error: `获取诊断失败: ${e.message}` };
        }
    },

    /**
     * 获取代码补全
     */
    lsp_complete: async (params) => {
        const { filePath, line, character } = params;
        try {
            const language = path.extname(filePath).slice(1);
            const client = getLSPClient();
            if (!client._servers.has(language)) {
                await client.startServer(language, path.dirname(filePath));
            }
            await client.openDocument(filePath);
            const result = await client.getCompletions(filePath, line, character);
            return { verified: true, data: { completions: result?.items || result || [], filePath, line, character } };
        } catch (e) {
            return { verified: false, error: `获取补全失败: ${e.message}` };
        }
    },

    /**
     * 悬停信息
     */
    lsp_hover: async (params) => {
        const { filePath, line, character } = params;
        try {
            const language = path.extname(filePath).slice(1);
            const client = getLSPClient();
            if (!client._servers.has(language)) {
                await client.startServer(language, path.dirname(filePath));
            }
            await client.openDocument(filePath);
            const result = await client.getHover(filePath, line, character);
            return { verified: true, data: { hover: result, filePath, line, character } };
        } catch (e) {
            return { verified: false, error: `获取悬停信息失败: ${e.message}` };
        }
    },

    /**
     * 跳转到定义
     */
    lsp_definition: async (params) => {
        const { filePath, line, character } = params;
        try {
            const language = path.extname(filePath).slice(1);
            const client = getLSPClient();
            if (!client._servers.has(language)) {
                await client.startServer(language, path.dirname(filePath));
            }
            await client.openDocument(filePath);
            const result = await client.goToDefinition(filePath, line, character);
            return { verified: true, data: { definitions: result, filePath, line, character } };
        } catch (e) {
            return { verified: false, error: `跳转定义失败: ${e.message}` };
        }
    }
};

// AST operations

const ASTTools = {
    /**
     * 解析 JavaScript/TypeScript 代码并返回 AST 结构概览
     * 使用 Node.js 内置的 `vm` 模块 + 简单解析器
     */
    ast_parse: (params) => {
        const { code, language = 'javascript' } = params;
        if (typeof code !== 'string') {
            return { verified: false, error: 'code 必须是字符串' };
        }

        try {
            const ast = _parseCodeStructure(code);
            return {
                verified: true,
                data: {
                    ast: ast,
                    summary: _summarizeAST(ast),
                    language
                }
            };
        } catch (e) {
            return { verified: false, error: `AST 解析失败: ${e.message}` };
        }
    },

    /**
     * 从代码中提取函数/类/接口定义
     */
    ast_functions: (params) => {
        const { code } = params;
        if (typeof code !== 'string') return { verified: false, error: 'code 必须是字符串' };

        try {
            const ast = _parseCodeStructure(code);
            const functions = _extractNodes(ast, ['function', 'arrow_function', 'method']);
            const classes = _extractNodes(ast, ['class']);
            const variables = _extractNodes(ast, ['variable']);

            return {
                verified: true,
                data: {
                    functions: functions.map(f => ({
                        name: f.name,
                        params: f.params || [],
                        startLine: f.loc?.start?.line || f.startLine,
                        endLine: f.loc?.end?.line || f.endLine
                    })),
                    classes: classes.map(c => ({
                        name: c.name,
                        methods: (c.children || []).filter(ch => ch.type === 'method').map(m => m.name),
                        startLine: c.loc?.start?.line || c.startLine
                    })),
                    variables: variables.map(v => ({
                        name: v.name,
                        kind: v.kind || 'const',
                        startLine: v.loc?.start?.line || v.startLine
                    })),
                    total: { functions: functions.length, classes: classes.length, variables: variables.length }
                }
            };
        } catch (e) {
            return { verified: false, error: `函数提取失败: ${e.message}` };
        }
    },

    /**
     * 代码复杂度分析
     */
    ast_complexity: (params) => {
        const { code } = params;
        if (typeof code !== 'string') return { verified: false, error: 'code 必须是字符串' };

        const lines = code.split('\n');
        const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;

        // 圈复杂度估算 (基于控制流关键字)
        const controlFlow = [
            'if ', 'else ', 'switch ', 'case ',
            'for ', 'while ', 'do ', 'catch ',
            '&&', '||', '? ',
            '?.', '??'
        ];
        let complexity = 1; // 基础复杂度
        for (const keyword of controlFlow) {
            const regex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            const matches = code.match(regex);
            if (matches) complexity += matches.length;
        }

        // 嵌套深度估算
        let maxDepth = 0;
        let currentDepth = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.endsWith('{') || trimmed.endsWith('(')) {
                currentDepth++;
                maxDepth = Math.max(maxDepth, currentDepth);
            }
            const closeCount = (trimmed.match(/}/g) || []).length;
            const openCount = (trimmed.match(/{/g) || []).length;
            currentDepth += openCount - closeCount;
            if (currentDepth < 0) currentDepth = 0;
        }

        return {
            verified: true,
            data: {
                lines: lines.length,
                nonEmptyLines,
                cyclomaticComplexity: complexity,
                maxNestingDepth: maxDepth,
                estimatedMaintainability: complexity > 20 ? '低' : (complexity > 10 ? '中' : '高'),
                summary: `${lines.length} 行, 复杂度 ${complexity}, 最大嵌套 ${maxDepth} 层`
            }
        };
    }
};

// Diff algorithm implementation

/**
 * 基于 LCS 的行级差异计算
 */
function _computeDiff(origLines, modLines) {
    const origLen = origLines.length;
    const modLen = modLines.length;

    // 构建 LCS 表
    const dp = Array.from({ length: origLen + 1 }, () => new Int32Array(modLen + 1));

    for (let i = 1; i <= origLen; i++) {
        for (let j = 1; j <= modLen; j++) {
            if (origLines[i - 1] === modLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // 回溯获取差异
    const diff = [];
    let i = origLen, j = modLen;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
            diff.unshift({ type: 'equal', content: origLines[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift({ type: 'insert', content: modLines[j - 1] });
            j--;
        } else {
            diff.unshift({ type: 'delete', content: origLines[i - 1] });
            i--;
        }
    }

    return diff;
}

/**
 * 将差异块组装为 hunks (unified diff 格式)
 */
function _buildHunks(diff, contextLines = 3) {
    const hunks = [];
    let i = 0;

    while (i < diff.length) {
        // 跳过相同区域
        while (i < diff.length && diff[i].type === 'equal') i++;
        if (i >= diff.length) break;

        // 标记变化块开始
        const hunkStart = Math.max(0, i - contextLines);
        const hunkLines = [];
        let oldPos = hunkStart;
        let newPos = hunkStart;
        let inChange = false;

        for (let pos = hunkStart; pos < Math.min(diff.length, i + contextLines + _countChangeLength(diff, i)); pos++) {
            const entry = diff[pos];
            if (pos < i - contextLines && !inChange) {
                // 前置上下文不足时延展
                if (diff.slice(pos, i).some(d => d.type !== 'equal')) continue;
            }

            if (pos >= i && pos < i + _countChangeLength(diff, i) + contextLines) {
                inChange = true;
            }

            if (pos >= i + _countChangeLength(diff, i) + contextLines) break;

            const prefix = entry.type === 'equal' ? ' ' : (entry.type === 'insert' ? '+' : '-');
            hunkLines.push({ prefix, content: entry.content, type: entry.type });

            if (entry.type !== 'delete') newPos++;
            if (entry.type !== 'insert') oldPos++;
        }

        if (hunkLines.some(l => l.prefix !== ' ')) {
            const oldStart = hunkStart + 1;
            const newStart = hunkStart + 1;
            const oldLines = hunkLines.filter(l => l.prefix !== '+').length;
            const newLines = hunkLines.filter(l => l.prefix !== '-').length;

            hunks.push({
                oldStart,
                newStart,
                oldLines: oldLines || 1,
                newLines: newLines || 1,
                lines: hunkLines
            });
        }

        i += _countChangeLength(diff, i);
    }

    return hunks;
}

function _countChangeLength(diff, start) {
    let count = 0;
    for (let i = start; i < diff.length; i++) {
        if (diff[i].type === 'equal') break;
        count++;
    }
    return count;
}

/**
 * 解析 unified diff 文本
 */
function _parseUnifiedDiff(diffLines) {
    const hunks = [];
    let currentHunk = null;

    for (const line of diffLines) {
        const hunkHeader = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
        if (hunkHeader) {
            if (currentHunk) hunks.push(currentHunk);
            currentHunk = {
                oldStart: parseInt(hunkHeader[1]),
                oldLines: parseInt(hunkHeader[2]),
                newStart: parseInt(hunkHeader[3]),
                newLines: parseInt(hunkHeader[4]),
                lines: []
            };
            continue;
        }

        if (currentHunk) {
            const prefix = line[0];
            if (prefix === ' ' || prefix === '+' || prefix === '-') {
                currentHunk.lines.push({
                    prefix,
                    content: line.substring(1)
                });
            }
        }
    }

    if (currentHunk) hunks.push(currentHunk);
    return hunks;
}

// Simple regex-based AST parser (JS/TS)

/**
 * 基于正则的简易代码结构解析器
 * (无需外部 parser 依赖, 覆盖常用场景)
 */
function _parseCodeStructure(code) {
    const lines = code.split('\n');
    const root = { type: 'program', children: [], startLine: 1, endLine: lines.length };
    const stack = [root];
    let currentIndent = 0;

    // 函数声明: function name(params) { 或 name = (params) => { 或 name(params) {
    const funcPattern = /(?:async\s+)?(?:function\s+)?(\w+)\s*(?:=\s*)?(?:\(([^)]*)\))?\s*(?::\s*\w+)?\s*(?:=>\s*)?{/;
    // 简化的箭头函数: (params) => ...
    const arrowFuncPattern = /(?:(\w+)\s*=\s*)?\(([^)]*)\)\s*=>/;
    // 类声明: class Name { 或 class Name extends Base {
    const classPattern = /class\s+(\w+)/;
    // 变量声明: const/let/var name = ...
    const varPattern = /(?:const|let|var)\s+(\w+)\s*=/;
    // 方法: methodName(params) { 或 async methodName(params) {
    const methodPattern = /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/;

    let inComment = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();

        // 跳过注释
        if (trimmed.startsWith('//')) continue;
        if (trimmed.startsWith('/*')) { inComment = true; continue; }
        if (inComment) { if (trimmed.includes('*/')) inComment = false; continue; }
        if (!trimmed || trimmed.startsWith('*')) continue;

        // 检测类声明
        const classMatch = trimmed.match(classPattern);
        if (classMatch) {
            const node = {
                type: 'class',
                name: classMatch[1],
                children: [],
                startLine: lineNum,
                endLine: lineNum
            };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
            continue;
        }

        // 检测方法 (在类内部)
        if (stack.length > 1 && stack[stack.length - 1].type === 'class') {
            const methodMatch = trimmed.match(methodPattern);
            if (methodMatch && !funcPattern.test(trimmed.replace(methodPattern, ''))) {
                const node = {
                    type: 'method',
                    name: methodMatch[1],
                    params: methodMatch[2].split(',').map(p => p.trim()).filter(Boolean),
                    children: [],
                    startLine: lineNum,
                    endLine: lineNum
                };
                stack[stack.length - 1].children.push(node);
                stack.push(node);
                continue;
            }
        }

        // 检测函数声明
        const funcMatch = trimmed.match(funcPattern);
        if (funcMatch && !stack.some(s => s.type === 'class')) {
            const node = {
                type: 'function',
                name: funcMatch[1] || 'anonymous',
                params: (funcMatch[2] || '').split(',').map(p => p.trim()).filter(Boolean),
                children: [],
                startLine: lineNum,
                endLine: lineNum
            };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
            continue;
        }

        // 检测箭头函数
        const arrowMatch = trimmed.match(arrowFuncPattern);
        if (arrowMatch && trimmed.includes('=>') && !funcMatch) {
            const node = {
                type: 'arrow_function',
                name: arrowMatch[1] || 'anonymous',
                params: (arrowMatch[2] || '').split(',').map(p => p.trim()).filter(Boolean),
                children: [],
                startLine: lineNum,
                endLine: lineNum
            };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
            continue;
        }

        // 检测变量声明
        const varMatch = trimmed.match(varPattern);
        if (varMatch && !trimmed.includes('function') && !trimmed.includes('class')) {
            const node = {
                type: 'variable',
                name: varMatch[1],
                kind: trimmed.startsWith('const') ? 'const' : (trimmed.startsWith('let') ? 'let' : 'var'),
                startLine: lineNum,
                endLine: lineNum
            };
            stack[stack.length - 1].children.push(node);
            // 变量声明不增加栈深度
            continue;
        }

        // 花括号平衡 (关闭作用域)
        const openBraces = (trimmed.match(/{/g) || []).length;
        const closeBraces = (trimmed.match(/}/g) || []).length;

        if (closeBraces > 0 && stack.length > 1) {
            for (let b = 0; b < closeBraces && stack.length > 1; b++) {
                const closed = stack.pop();
                closed.endLine = lineNum;
            }
            // 补充开放的括号
            for (let b = 0; b < openBraces; b++) {
                if (trimmed.includes('{') && !trimmed.includes('}')) {
                    // 新块
                }
            }
        }
    }

    // 关闭所有打开的作用域
    while (stack.length > 1) {
        const node = stack.pop();
        node.endLine = lines.length;
    }

    return root;
}

/**
 * 从 AST 中提取指定类型的节点
 */
function _extractNodes(node, types, depth = 0) {
    if (depth > 50) return [];
    let results = [];
    if (types.includes(node.type)) {
        results.push(node);
    }
    if (node.children) {
        for (const child of node.children) {
            results = results.concat(_extractNodes(child, types, depth + 1));
        }
    }
    return results;
}

/**
 * 生成 AST 摘要
 */
function _summarizeAST(ast) {
    const functions = _extractNodes(ast, ['function', 'arrow_function']);
    const classes = _extractNodes(ast, ['class']);
    const methods = _extractNodes(ast, ['method']);
    const variables = _extractNodes(ast, ['variable']);

    return {
        functions: functions.length,
        classes: classes.length,
        methods: methods.length,
        variables: variables.length,
        details: {
            functionNames: functions.map(f => f.name).filter(Boolean),
            className: classes.map(c => c.name).filter(Boolean),
            methodNames: methods.map(m => m.name).filter(Boolean)
        }
    };
}

// Exports

module.exports = {
    DiffTools,
    LSPTools,
    LSPClient,
    ASTTools
};
