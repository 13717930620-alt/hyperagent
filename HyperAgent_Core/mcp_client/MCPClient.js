/**
 * MCPClient - Model Context Protocol 客户端
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');

class MCPClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.name = options.name || 'JingxuanAgent-MCP';
        this.version = options.version || '2.1.0';
        this.clients = new Map();   // serverName -> { process, transport, capabilities }
        this.toolRegistry = new Map(); // toolName -> { serverName, tool }
        this.requestId = 0;
    }

    /**
     * 通过 stdio 连接 MCP 服务器进程
     * @param {string} serverName - 服务器唯一标识
     * @param {string} command - 启动命令
     * @param {string[]} args - 命令参数
     * @param {Object} env - 环境变量
     */
    async connectStdio(serverName, command, args = [], env = {}) {
        if (this.clients.has(serverName)) {
            throw new Error(`MCP server "${serverName}" already connected`);
        }

        console.log(`[MCP] Connecting to ${serverName} via stdio: ${command} ${args.join(' ')}`);

        const child = spawn(command, args, {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let buffer = '';
        const transport = {
            process: child,
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr
        };

        child.stdout.on('data', (data) => {
            buffer += data.toString();
            this._processMessages(serverName, buffer, (msg) => {
                buffer = msg.remainder;
            });
        });

        child.stderr.on('data', (data) => {
            this.emit('stderr', { server: serverName, message: data.toString() });
        });

        child.on('exit', (code, signal) => {
            console.log(`[MCP] ${serverName} exited with code ${code}, signal ${signal}`);
            this.clients.delete(serverName);
            this._unregisterTools(serverName);
            this.emit('disconnected', { server: serverName, code, signal });
        });

        child.on('error', (err) => {
            console.error(`[MCP] ${serverName} error:`, err.message);
            this.emit('error', { server: serverName, error: err.message });
        });

        const clientInfo = { transport, capabilities: {}, connected: false };
        this.clients.set(serverName, clientInfo);

        try {
            await this._initialize(serverName);
            await this._discoverTools(serverName);
            console.log(`[MCP] ${serverName}: initialized and connected ✅`);
        } catch (e) {
            this.clients.delete(serverName);
            child.kill();
            throw e;
        }

        return { serverName, tools: this._getServerTools(serverName) };
    }

    /**
     * 执行 MCP 初始化握手
     */
    async _initialize(serverName) {
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`Server ${serverName} not found`);

        const result = await this._sendRequest(serverName, 'initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {
                tools: {},
                resources: {}
            },
            clientInfo: {
                name: this.name,
                version: this.version
            }
        });

        client.capabilities = result.capabilities || {};
        client.connected = true;

        // 发送 initialized 通知
        await this._sendNotification(serverName, 'notifications/initialized');

        return result;
    }

    async _discoverTools(serverName) {
        const result = await this._sendRequest(serverName, 'tools/list', {});

        if (result && result.tools) {
            for (const tool of result.tools) {
                const toolKey = `${serverName}:${tool.name}`;
                this.toolRegistry.set(toolKey, {
                    serverName,
                    tool,
                    registered: true
                });
            }
            console.log(`[MCP] ${serverName}: registered ${result.tools.length} tools`);
        }

        return result;
    }

    async callTool(serverName, toolName, args = {}) {
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`MCP server "${serverName}" not connected`);

        return await this._sendRequest(serverName, 'tools/call', {
            name: toolName,
            arguments: args
        });
    }

    /**
     * 自动查找工具所在服务器并调用
     * @param {string} toolName - 工具名称（支持 "server:tool" 格式）
     * @param {Object} args - 工具参数
     */
    async callToolByName(toolName, args = {}) {
        if (toolName.includes(':')) {
            const [serverName, name] = toolName.split(':');
            return await this.callTool(serverName, name, args);
        }

        for (const [key, entry] of this.toolRegistry) {
            if (entry.tool.name === toolName) {
                return await this.callTool(entry.serverName, toolName, args);
            }
        }

        throw new Error(`Tool "${toolName}" not found in any connected MCP server`);
    }

    listTools() {
        const tools = [];
        for (const [key, entry] of this.toolRegistry) {
            tools.push({
                fullName: key,
                serverName: entry.serverName,
                ...entry.tool
            });
        }
        return tools;
    }

    _getServerTools(serverName) {
        const tools = [];
        for (const [key, entry] of this.toolRegistry) {
            if (entry.serverName === serverName) {
                tools.push(entry.tool);
            }
        }
        return tools;
    }

    _unregisterTools(serverName) {
        for (const [key, entry] of this.toolRegistry) {
            if (entry.serverName === serverName) {
                this.toolRegistry.delete(key);
            }
        }
    }

    /**
     * 断开指定 MCP 服务器连接
     */
    async disconnect(serverName) {
        const client = this.clients.get(serverName);
        if (!client) return;

        try {
            await this._sendRequest(serverName, 'shutdown', {});
        } catch (e) { console.warn(`[mcp_client] Unhandled error: ${e.message}`); }

        client.transport.process.kill();
        this.clients.delete(serverName);
        this._unregisterTools(serverName);
        console.log(`[MCP] ${serverName}: disconnected`);
    }

    /**
     * 断开所有 MCP 服务器连接
     */
    async disconnectAll() {
        const names = Array.from(this.clients.keys());
        for (const name of names) {
            await this.disconnect(name);
        }
    }

    /**
     * 获取当前连接状态
     */
    getStatus() {
        const status = {};
        for (const [name, client] of this.clients) {
            status[name] = {
                connected: client.connected,
                capabilities: client.capabilities,
                toolCount: this._getServerTools(name).length,
                pid: client.transport.process.pid
            };
        }
        return {
            servers: status,
            totalTools: this.toolRegistry.size,
            totalServers: this.clients.size
        };
    }

    // JSON-RPC 协议实现

    _sendRequest(serverName, method, params) {
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`Server ${serverName} not found`);

        const id = ++this.requestId;
        const request = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params
        }) + '\n';

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`MCP request "${method}" to ${serverName} timed out`));
            }, 30000);

            const handler = (response) => {
                if (response.id === id) {
                    clearTimeout(timeout);
                    if (response.error) {
                        reject(new Error(`MCP error: ${response.error.message || JSON.stringify(response.error)}`));
                    } else {
                        resolve(response.result);
                    }
                }
            };

            this.once(`response:${serverName}:${id}`, handler);
            this.once(`error:${serverName}:${id}`, (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            try {
                client.transport.stdin.write(request);
            } catch (e) {
                clearTimeout(timeout);
                reject(new Error(`Failed to write to MCP server ${serverName}: ${e.message}`));
            }
        });
    }

    _sendNotification(serverName, method, params = {}) {
        const client = this.clients.get(serverName);
        if (!client) return;

        const notification = JSON.stringify({
            jsonrpc: '2.0',
            method,
            params
        }) + '\n';

        try {
            client.transport.stdin.write(notification);
        } catch (e) { console.warn(`[mcp_client] Unhandled error: ${e.message}`); }
    }

    _processMessages(serverName, buffer, onMessage) {
        const lines = buffer.split('\n');
        // 最后一行可能不完整，保留到下次处理
        const completeLines = lines.slice(0, -1);
        const remainder = lines[lines.length - 1];

        for (const line of completeLines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                this._handleMessage(serverName, msg);
            } catch (e) {
                // 忽略非 JSON 输出（如 stderr 重定向到 stdout 的情况）
            }
        }

        onMessage({ remainder });
    }

    _handleMessage(serverName, msg) {
        if (msg.id) {
            this.emit(`response:${serverName}:${msg.id}`, msg);
        } else if (msg.method) {
            this.emit(`notification:${serverName}:${msg.method}`, msg.params);
        }
    }

    /**
     * 自动重连断开的服务器
     */
    enableReconnect(options = {}) {
        const interval = options.interval || 10000;
        this._reconnectTimer = setInterval(() => {
            for (const [name, client] of this.clients) {
                if (!client.transport.process.killed) continue;
                // 重连逻辑需要在子类或外部实现
                this.emit('reconnect:needed', { server: name });
            }
        }, interval);
    }

    disableReconnect() {
        if (this._reconnectTimer) {
            clearInterval(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
}

module.exports = MCPClient;
