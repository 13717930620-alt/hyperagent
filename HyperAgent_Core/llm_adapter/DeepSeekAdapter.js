const axios = require('axios');
const EventEmitter = require('events');
const BaseLLM = require('./BaseLLM');

class DeepSeekAdapter extends BaseLLM {
    constructor(config) {
        super(config);
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl || 'https://api.deepseek.com/chat/completions';
        this.model = config.model || 'deepseek-v4-pro';
        this.temperature = config.temperature || 0.7;
        this.maxTokens = config.maxTokens || 8192;
        this.reasoningEffort = config.reasoningEffort || 'high';
    }

    async chat(messages, options = {}) {
        try {
            const body = {
                model: this.model, messages,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                stream: false
            };
            const response = await axios.post(this.baseUrl, body, {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.data.choices[0].message.content;
        } catch (error) {
            const errData = error.response?.data;
            const errMsg = typeof errData === 'object' ? JSON.stringify(errData) : (errData || error.message);
            throw new Error(`DeepSeek API call failed: ${errMsg}`);
        }
    }

    async streamChat(messages, onChunk, options = {}) {
        try {
            const response = await axios.post(this.baseUrl, {
                model: this.model, messages,
                temperature: this.temperature, max_tokens: this.maxTokens,
                stream: true,
                thinking: { type: options.thinking || 'enabled' },
                reasoning_effort: options.reasoningEffort || this.reasoningEffort
            }, {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'text/event-stream' },
                responseType: 'stream',
                timeout: 120000
            });

            let buffer = '';
            return new Promise((resolve, reject) => {
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
                            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                            if (delta) { fullContent += delta; if (onChunk) onChunk(delta); }
                        } catch (e) { console.warn(`[llm_adapter] Unhandled error: ${e.message}`); }
                    }
                });
                response.data.on('end', () => resolve(fullContent));
                response.data.on('error', (err) => reject(new Error(`Stream error: ${err.message}`)));
            });
        } catch (error) {
            throw new Error(`Stream request failed: ${error.message}`);
        }
    }

    async chatWithTools(messages, tools = [], options = {}) {
        const openaiMessages = this._toOpenAIFormat(messages);

        const body = {
            model: this.model, messages: openaiMessages,
            temperature: this.temperature, max_tokens: this.maxTokens,
            stream: false,
            // DeepSeek v4-flash 遇到 tool_calls 会自动进思考模式，强行关掉避免 reasoning_content 透传地狱
            reasoning_effort: null,
        };
        if (tools.length > 0) {
            body.tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || '',
                    parameters: t.input_schema || { type: 'object', properties: {} },
                },
            }));
            body.tool_choice = 'auto';
        }

        try {
            const response = await axios.post(this.baseUrl, body, {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` }
            });
            const message = response.data.choices[0].message;
            return {
                content: message.content || '',
                toolCalls: message.tool_calls ? message.tool_calls.map(tc => ({
                    id: tc.id, type: tc.type || 'function',
                    function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) }
                })) : [],
                finishReason: response.data.choices[0].finish_reason,
                // DeepSeek 思维链需要透传给下一轮
                reasoningContent: message.reasoning_content || null,
            };
        } catch (error) {
            const errData = error.response?.data;
            const errMsg = typeof errData === 'object' ? JSON.stringify(errData) : (errData || error.message);
            throw new Error(`DeepSeek tool call failed: ${errMsg}`);
        }
    }

    /**
     * 将内部消息格式（Anthropic 风格）转换为 OpenAI 格式
     *
     * 内部格式（来自 QueryEngine）：
     *   assistant: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
     *   tool_result: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
     *
     * OpenAI 格式：
     *   assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }
     *   tool_result: { role: 'tool', content: 'result', tool_call_id: 'id' }
     */
    _toOpenAIFormat(messages) {
        const result = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                result.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
                continue;
            }

            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const toolResultBlock = msg.content.find(c => c.type === 'tool_result');
                if (toolResultBlock) {
                    result.push({
                        role: 'tool',
                        tool_call_id: toolResultBlock.tool_use_id,
                        content: typeof toolResultBlock.content === 'string' ? toolResultBlock.content : JSON.stringify(toolResultBlock.content),
                    });
                    continue;
                }
                // 检查是否包含图片内容块
                const hasImage = msg.content.some(c => c.type === 'image_url' || (c.type === 'image'));
                if (hasImage) {
                    // OpenAI 格式：将 Anthropic 的 image 转为 image_url
                    const openaiContent = msg.content.map(c => {
                        if (c.type === 'image_url') return c;
                        if (c.type === 'image') {
                            return {
                                type: 'image_url',
                                image_url: { url: `data:${c.source?.media_type || 'image/png'};base64,${c.source?.data || ''}` },
                            };
                        }
                        if (c.type === 'text' || typeof c === 'string') {
                            return { type: 'text', text: typeof c === 'string' ? c : c.text };
                        }
                        return c;
                    });
                    result.push({ role: 'user', content: openaiContent });
                    continue;
                }
                const text = msg.content.map(c => typeof c === 'string' ? c : c.text || '').filter(Boolean).join('\n');
                result.push({ role: 'user', content: text || JSON.stringify(msg.content) });
                continue;
            }

            if (msg.role === 'assistant') {
                const assistantMsg = { role: 'assistant' };
                if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                    assistantMsg.content = msg.content || null;
                    assistantMsg.tool_calls = msg.tool_calls;
                } else if (Array.isArray(msg.content)) {
                    const textParts = [];
                    const toolCalls = [];
                    for (const block of msg.content) {
                        if (block.type === 'tool_use') {
                            toolCalls.push({
                                id: block.id,
                                type: 'function',
                                function: {
                                    name: block.name,
                                    arguments: JSON.stringify(block.input || {}),
                                },
                            });
                        } else if (block.type === 'text') {
                            textParts.push(block.text);
                        } else if (typeof block === 'string') {
                            textParts.push(block);
                        }
                    }
                    if (toolCalls.length > 0) {
                        assistantMsg.content = textParts.join('\n') || null;
                        assistantMsg.tool_calls = toolCalls;
                    } else {
                        assistantMsg.content = textParts.join('\n') || '';
                    }
                } else {
                    assistantMsg.content = msg.content || '';
                }
                // DeepSeek 要求 reasoning_content 必须透传
                if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
                result.push(assistantMsg);
                continue;
            }

            // 普通消息 / tool 消息
            const entry = {
                role: msg.role,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            };
            // OpenAI 格式的 tool 消息需要保留 tool_call_id
            if (msg.role === 'tool' && msg.tool_call_id) {
                entry.tool_call_id = msg.tool_call_id;
            }
            result.push(entry);
        }
        return result;
    }
}

module.exports = DeepSeekAdapter;
