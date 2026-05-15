/**
 * AnthropicCompatAdapter.js - Anthropic Messages API 兼容适配器
 */

const axios = require('axios');
const BaseLLM = require('./BaseLLM');

class AnthropicCompatAdapter extends BaseLLM {
    constructor(config) {
        super(config);
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '');
        this.model = config.model || 'deepseek-v4-flash';
        this.maxTokens = config.maxTokens || 8192;
        this.temperature = config.temperature || 0.7;
        this.reasoningEffort = config.reasoningEffort || 'high';
    }

    async chat(messages, options = {}) {
        const anthropicMessages = this._convertToAnthropicMessages(messages);
        const systemMsg = this._extractSystemMessage(messages);

        const body = {
            model: this.model,
            max_tokens: options.maxTokens || this.maxTokens,
            temperature: options.temperature ?? this.temperature,
            messages: anthropicMessages,
            stream: false,
        };
        if (systemMsg) body.system = systemMsg;

        try {
            const response = await axios.post(`${this.baseUrl}/messages`, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                timeout: 120000,
            });

            const contentBlocks = response.data.content || [];
            const textBlock = contentBlocks.find(b => b.type === 'text');
            return textBlock?.text || '';
        } catch (error) {
            if (error.response) {
                throw new Error(`API error ${error.response.status}: ${error.response.data?.error?.message || JSON.stringify(error.response.data).substring(0, 200)}`);
            }
            throw new Error(`Request failed: ${error.message}`);
        }
    }

    async streamChat(messages, onChunk, options = {}) {
        const anthropicMessages = this._convertToAnthropicMessages(messages);
        const systemMsg = this._extractSystemMessage(messages);

        const body = {
            model: this.model,
            max_tokens: options.maxTokens || this.maxTokens,
            temperature: options.temperature ?? this.temperature,
            messages: anthropicMessages,
            stream: true,
        };
        if (systemMsg) body.system = systemMsg;

        try {
            const response = await axios.post(`${this.baseUrl}/messages`, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                responseType: 'stream',
                timeout: 120000,
            });

            let buffer = '';
            let fullContent = '';
            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') return;
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.delta?.text || parsed.type === 'content_block_delta' ? parsed.delta?.text : '';
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                            fullContent += parsed.delta.text;
                            if (onChunk) onChunk(parsed.delta.text);
                        }
                    } catch (e) { console.warn(`[llm_adapter] Unhandled error: ${e.message}`); }
                }
            });
            return new Promise((resolve) => {
                response.data.on('end', () => resolve(fullContent));
                response.data.on('error', () => resolve(fullContent));
            });
        } catch (error) {
            // Fallback to non-streaming
            const result = await this.chat(messages, options);
            if (onChunk) onChunk(result);
            return result;
        }
    }

    /**
     * 原生工具调用（Anthropic tool_use 格式）
     * 支持 DeepSeek 的 Anthropic 兼容端点的 tool_use/tool_result
     */
    async chatWithTools(messages, tools = [], options = {}) {
        const anthropicMessages = this._convertToAnthropicMessages(messages);
        const systemMsg = this._extractSystemMessage(messages);

        const body = {
            model: this.model,
            max_tokens: options.maxTokens || this.maxTokens,
            temperature: options.temperature ?? this.temperature,
            messages: anthropicMessages,
            stream: false,
        };
        if (systemMsg) body.system = systemMsg;

        if (tools && tools.length > 0) {
            body.tools = tools.map(t => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.input_schema || { type: 'object', properties: {} },
            }));
        }

        try {
            const response = await axios.post(`${this.baseUrl}/messages`, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                timeout: 120000,
            });

            const contentBlocks = response.data.content || [];
            const textContent = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
            const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');

            if (response.data.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
                return { content: textContent, toolCalls: [] };
            }

            if (response.data.stop_reason === 'tool_use' || toolUseBlocks.length > 0) {
                const toolCalls = toolUseBlocks.map(block => ({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input),
                    },
                }));

                return {
                    content: textContent,
                    toolCalls,
                    finishReason: 'tool_use',
                };
            }

            return { content: textContent, toolCalls: [] };
        } catch (error) {
            if (error.response) {
                throw new Error(`API error ${error.response.status}: ${error.response.data?.error?.message || JSON.stringify(error.response.data).substring(0, 200)}`);
            }
            throw new Error(`Request failed: ${error.message}`);
        }
    }

    // Anthropic <-> 通用格式转换

    _convertToAnthropicMessages(messages) {
        const result = [];
        let currentRole = null;
        let currentContent = [];

        for (const msg of messages) {
            if (msg.role === 'system') continue;

            const anthropicRole = msg.role === 'assistant' ? 'assistant' : 'user';

            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const hasToolResult = msg.content.some(c => c.type === 'tool_result');
                if (hasToolResult) {
                    for (const block of msg.content) {
                        if (block.type === 'tool_result') {
                            result.push({
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: block.tool_use_id,
                                    content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                                }],
                            });
                        }
                    }
                    continue;
                }
                // 处理图片内容块（image_url → Anthropic image 格式）
                const hasImage = msg.content.some(c => c.type === 'image_url' || c.type === 'image');
                if (hasImage) {
                    const anthropicContent = [];
                    for (const block of msg.content) {
                        if (block.type === 'image_url') {
                            // 从 data:image/png;base64,abc123 格式中提取
                            const url = block.image_url?.url || '';
                            const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
                            if (match) {
                                anthropicContent.push({
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: match[1],
                                        data: match[2],
                                    },
                                });
                            }
                        } else if (block.type === 'image') {
                            anthropicContent.push(block);
                        } else if (block.type === 'text' || typeof block === 'string') {
                            anthropicContent.push({ type: 'text', text: typeof block === 'string' ? block : block.text });
                        }
                    }
                    if (anthropicContent.length > 0) {
                        result.push({ role: 'user', content: anthropicContent });
                        continue;
                    }
                }
            }

            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const anthropicContent = msg.content.map(block => {
                    if (block.type === 'tool_use' || block.name) {
                        return {
                            type: 'tool_use',
                            id: block.id || `toolu_${Date.now()}`,
                            name: block.name || 'unknown',
                            input: block.input || {},
                        };
                    }
                    if (block.type === 'text' || typeof block === 'string') {
                        return { type: 'text', text: typeof block === 'string' ? block : block.text };
                    }
                    return block;
                });
                result.push({ role: 'assistant', content: anthropicContent });
                continue;
            }

            const text = typeof msg.content === 'string' ? msg.content : '';

            if (anthropicRole === currentRole) {
                if (currentContent.length > 0 && typeof currentContent[0] === 'string') {
                    currentContent = [currentContent[0] + '\n\n' + text];
                } else {
                    currentContent.push({ type: 'text', text });
                }
            } else {
                if (currentContent.length > 0) {
                    result.push({
                        role: currentRole,
                        content: currentContent.length === 1 && typeof currentContent[0] === 'string'
                            ? currentContent[0]
                            : currentContent,
                    });
                }
                currentRole = anthropicRole;
                currentContent = [text];
            }
        }

        if (currentContent.length > 0) {
            result.push({
                role: currentRole,
                content: currentContent.length === 1 && typeof currentContent[0] === 'string'
                    ? currentContent[0]
                    : currentContent,
            });
        }

        return result;
    }

    _extractSystemMessage(messages) {
        const systemMsgs = messages.filter(m => m.role === 'system');
        return systemMsgs.map(m => m.content).join('\n\n') || null;
    }
}

module.exports = AnthropicCompatAdapter;
