// PersonaInjection - persona injection engine
class PersonaInjection {
    constructor(options = {}) {
        this.llmAdapter = options.llmAdapter || null;

        // 预定义角色目录
        this.personas = {
            expert: {
                name: '领域专家',
                traits: '专业、精确、严谨',
                style: '用专业术语精确描述，确保每一步有理论支撑'
            },
            assistant: {
                name: '智能助手',
                traits: '友好、耐心、全面',
                style: '用平实的语言清晰解释，确保用户理解'
            },
            critic: {
                name: '批判性审查员',
                traits: '严谨、挑剔、追求完美',
                style: '指出问题、矛盾和改进点，严格评估'
            },
            researcher: {
                name: '研究员',
                traits: '好奇、系统、数据驱动',
                style: '先收集信息再做结论，引用来源'
            },
            coder: {
                name: '程序员',
                traits: '精确、高效、工程化',
                style: '先设计再编码，关注可维护性和性能'
            },
            teacher: {
                name: '教师',
                traits: '耐心、循序渐进、善于举例',
                style: '用类比和例子解释复杂概念'
            }
        };

        this.stats = {
            totalInjections: 0,
            rolePairsCreated: 0
        };
    }

    /**
     * Generate a persona prompt
     */
    generatePersonaPrompt(role, task, traits = {}) {
        const persona = this.personas[role] || this.personas.assistant;
        const expertise = traits.expertise || '';
        const tone = traits.tone || '专业';
        const constraints = traits.constraints || [];

        const parts = [
            `# 角色：${persona.name}`,
            '',
            `## 人格特质`,
            `${persona.traits}`,
            '',
            `## 沟通风格`,
            `${persona.style}`,
            '',
            `## 专业背景`,
            expertise ? `擅长领域：${expertise}` : '通用智能体',
            '',
            `## 当前任务`,
            task,
            '',
        ];

        if (constraints.length > 0) {
            parts.push(`## 约束条件`);
            for (const c of constraints) {
                parts.push(`- ${c}`);
            }
            parts.push('');
        }

        parts.push(`## 行为准则`,
            `1. 保持 ${tone} 的语气`,
            `2. 每次回复都有明确的行动或结论`,
            `3. 遇到不确定的信息，主动说明`,
            `4. 多步任务时定期汇报进度`);

        return parts.join('\n');
    }

    /**
     * Generate a role pair (CAMEL inception prompting)
     */
    async rolePair(assistantRole, userRole, task) {
        this.stats.rolePairsCreated++;

        const assistantPersona = this.personas[assistantRole] || this.personas.assistant;
        const userPersona = this.personas[userRole] || this.personas.expert;

        const assistant = this.generatePersonaPrompt(assistantRole, task, {
            constraints: [
                '作为 AI 助手，你的职责是协助完成任务',
                '每次回复前先确认理解用户需求',
                `扮演好 ${assistantPersona.name} 的角色`
            ]
        });

        const user = this.generatePersonaPrompt(userRole, task, {
            constraints: [
                '作为 AI 用户，你的职责是指出需求和反馈',
                '当 AI 助手偏离方向时及时纠正',
                `扮演好 ${userPersona.name} 的角色`
            ]
        });

        return {
            assistant: `你是一个扮演 ${assistantPersona.name} 的 AI 助手。\n\n${assistant}`,
            user: `你是一个扮演 ${userPersona.name} 的 AI 用户。\n\n${user}`
        };
    }

    /**
     * Apply persona to an existing system prompt
     */
    applyPersonaToSystemPrompt(basePrompt, persona) {
        if (!basePrompt) return persona;
        return `${basePrompt}\n\n${persona}`;
    }

    /**
     * Infer user persona from conversation history
     */
    async inferPersonaFromHistory(history) {
        if (!this.llmAdapter || !history || history.length < 3) {
            return { communicationStyle: 'general', expertise: 'general' };
        }

        const historySample = history.slice(-10).map(m =>
            `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, 200) : ''}`
        ).join('\n');

        const prompt = `基于以下对话历史，推断用户的特点。

${historySample}

返回 JSON：
{
  "communicationStyle": "concise" | "detailed" | "technical",
  "expertise": "用户可能擅长的领域",
  "preferences": ["偏好1", "偏好2"],
  "personaType": "expert" | "beginner" | "manager" | "creative"
}`;

        const response = await this.llmAdapter.chat([
            { role: 'system', content: '你是一个用户画像分析师。输出 JSON。' },
            { role: 'user', content: prompt }
        ]);

        const text = typeof response === 'string' ? response :
                     (response.content || response.message?.content || '');

        try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) { console.warn(`[conversation] Unhandled error: ${e.message}`); }

        return { communicationStyle: 'general', expertise: 'general' };
    }

    /**
     * 列出所有预定义角色
     */
    listPersonas() {
        return Object.entries(this.personas).map(([key, val]) => ({
            id: key,
            name: val.name,
            traits: val.traits,
            style: val.style
        }));
    }

    getStats() {
        return { ...this.stats };
    }
}

module.exports = PersonaInjection;
