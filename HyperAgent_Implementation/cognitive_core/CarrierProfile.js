/**
 * CarrierProfile — persistent identity and behavioral profile for a carrier device, self-updating with experience.
 */

const fs = require('fs');
const path = require('path');

class CarrierProfile {
    constructor(options = {}) {
        this.storageDir = options.storageDir || path.join(process.cwd(), 'experience_store');
        this.experienceDB = options.experienceDB || null;

        // 画像数据
        this.profile = {
            // 基础身份
            identity: {
                carrierId: this._generateCarrierId(),
                carrierType: options.carrierType || 'pc',
                name: options.name || 'Unknown Carrier',
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                totalUptime: 0
            },

            // 硬件特征
            hardware: {
                cpu: {},
                memory: {},
                disk: [],
                network: {},
                os: {},
                gpu: null,
                unique: {}         // 独特硬件特征
            },

            // 行为特征
            behavior: {
                activeHours: [],            // 活跃时段分布 [0..23]
                commonTasks: [],            // 频繁执行的任务类型
                peakLoadTimes: [],          // 高负载时段
                idlePatterns: [],           // 空闲模式
                userInteractionRate: 0,     // 用户交互频率
                commandFrequency: {},       // 命令执行频率统计
                typicalSessionLength: 0     // 典型会话时长
            },

            // 状态画像
            stateProfile: {
                cpuTypical: { min: 0, max: 0, avg: 0 },
                memoryTypical: { min: 0, max: 0, avg: 0 },
                diskTypical: {},
                processTypical: { min: 0, max: 0, avg: 0 },
                anomalies: [],              // 异常模式记录
                stablePatterns: []           // 稳定模式
            },

            // 认知进化
            cognition: {
                version: '1.0.0',
                totalExperiences: 0,
                evolutionStage: 'embryo', // embryo → growing → maturing → mature
                evolutionHistory: [],
                knowledgeDomains: [],       // 积累的知识领域
                capabilities: [],           // 已发展的能力
                lastEvolution: null
            },

            // 专属指纹（唯一标识特征）
            fingerprint: {
                hardwareSignature: '',
                softwareSignature: '',
                behaviorSignature: '',
                compositeScore: 0
            }
        };

        // 状态采样缓冲区（用于计算趋势）
        this._stateBuffer = [];
        this._maxBufferSize = 1000;
        this._sessionStartTime = null;
        this._dailyStats = new Map();  // YYYY-MM-DD → stats

        // 确保目录存在
        this._ensureDirectories();

        // 从磁盘恢复
        this._load();
    }

    // Public API

    /**
     * 记录一次状态采样，更新画像
     */
    async updateState(stateSnapshot) {
        if (!stateSnapshot) return;

        // 更新最后活跃时间
        this.profile.identity.lastSeen = new Date().toISOString();

        // 添加状态到缓冲区
        this._stateBuffer.push({
            timestamp: Date.now(),
            ...stateSnapshot
        });
        if (this._stateBuffer.length > this._maxBufferSize) {
            this._stateBuffer = this._stateBuffer.slice(-this._maxBufferSize);
        }

        // 更新硬件信息（首次或变化时）
        this._updateHardware(stateSnapshot);

        // 更新状态画像（滑动窗口统计）
        this._updateStateProfile();

        // 更新活跃时段
        this._updateActiveHours();

        // 更新每日统计
        this._updateDailyStats(stateSnapshot);

        // 更新指纹
        this._updateFingerprint();

        // 自动保存（每50次采样）
        if (this._stateBuffer.length % 50 === 0) {
            await this.save();
        }
    }

    /**
     * 记录一次用户交互
     */
    async recordInteraction(interaction) {
        const type = interaction.type || 'unknown';
        this.profile.behavior.commandFrequency[type] =
            (this.profile.behavior.commandFrequency[type] || 0) + 1;

        // 更新常见任务
        this._updateCommonTasks(type);

        // 更新用户交互率
        this.profile.behavior.userInteractionRate =
            (this.profile.behavior.userInteractionRate * 0.95) + 0.05;

        await this.save();
    }

    /**
     * 记录一次工具执行
     */
    async recordToolExecution(toolName, result) {
        // 更新命令频率统计
        this.profile.behavior.commandFrequency[`tool:${toolName}`] =
            (this.profile.behavior.commandFrequency[`tool:${toolName}`] || 0) + 1;

        // 记录异常
        if (result && result.error) {
            this.profile.stateProfile.anomalies.push({
                time: new Date().toISOString(),
                type: 'tool_error',
                detail: `${toolName}: ${result.error}`,
                severity: 'warning'
            });
            // 限制异常记录数量
            if (this.profile.stateProfile.anomalies.length > 100) {
                this.profile.stateProfile.anomalies = this.profile.stateProfile.anomalies.slice(-100);
            }
        }
    }

    /**
     * 记录会话开始
     */
    startSession() {
        this._sessionStartTime = Date.now();
    }

    /**
     * 记录会话结束，更新典型会话时长
     */
    endSession() {
        if (this._sessionStartTime) {
            const sessionLength = (Date.now() - this._sessionStartTime) / 60000; // 分钟
            const current = this.profile.behavior.typicalSessionLength;
            this.profile.behavior.typicalSessionLength = current
                ? (current * 0.7 + sessionLength * 0.3)
                : sessionLength;
            this._sessionStartTime = null;
        }
    }

    /**
     * 记录进化事件
     */
    recordEvolution(event) {
        this.profile.cognition.evolutionHistory.push({
            time: new Date().toISOString(),
            ...event
        });
        this.profile.cognition.lastEvolution = new Date().toISOString();

        // 更新进化阶段
        this._updateEvolutionStage();
    }

    /**
     * 更新经验计数
     */
    updateExperienceCount(count) {
        this.profile.cognition.totalExperiences = count;
        this._updateEvolutionStage();
    }

    /**
     * 获取完整的承载体画像
     */
    getProfile() {
        return {
            ...this.profile,
            _computed: {
                confidence: this._calculateConfidence(),
                dataQuality: this._assessDataQuality(),
                recommendation: this._generateRecommendation()
            }
        };
    }

    /**
     * 获取画像摘要（简短版）
     */
    getSummary() {
        const p = this.profile;
        return {
            identity: `${p.identity.carrierType}:${p.identity.name}`,
            stage: p.cognition.evolutionStage,
            experience: p.cognition.totalExperiences,
            uptime: this._formatUptime(p.identity.totalUptime),
            cpuAvg: `${p.stateProfile.cpuTypical.avg}%`,
            memAvg: `${p.stateProfile.memoryTypical.avg}%`,
            topTasks: p.behavior.commonTasks.slice(0, 5),
            anomalies: p.stateProfile.anomalies.length,
            fingerprint: p.fingerprint.compositeScore.toFixed(2)
        };
    }

    /**
     * 获取与另一个画像的相似度（用于多设备对比）
     */
    compareTo(otherProfile) {
        // 简单的指纹比较
        const a = this.profile.fingerprint;
        const b = otherProfile.fingerprint;
        if (!a || !b) return 0;

        let score = 0;
        // 硬件签名相似度
        if (a.hardwareSignature === b.hardwareSignature) score += 0.4;
        // 行为签名相似度（使用简单字符串比较作为近似）
        if (a.behaviorSignature === b.behaviorSignature) score += 0.3;
        // 软件签名相似度
        if (a.softwareSignature === b.softwareSignature) score += 0.3;

        return score;
    }

    /**
     * 持久化到磁盘
     */
    async save() {
        try {
            const profilePath = path.join(this.storageDir, 'carrier_profile.json');
            fs.writeFileSync(profilePath, JSON.stringify(this.profile, null, 2), 'utf8');

            const statsPath = path.join(this.storageDir, 'daily_stats.json');
            const dailyStatsObj = Object.fromEntries(this._dailyStats);
            fs.writeFileSync(statsPath, JSON.stringify(dailyStatsObj, null, 2), 'utf8');

            return true;
        } catch (e) {
            console.error('[CarrierProfile] Save error:', e.message);
            return false;
        }
    }

    /**
     * 重置画像（慎用）
     */
    async reset() {
        // 保留身份ID但重置所有学习数据
        const oldId = this.profile.identity.carrierId;
        this.profile.identity.carrierId = oldId;
        this.profile.identity.firstSeen = new Date().toISOString();
        this.profile.behavior = {
            activeHours: [],
            commonTasks: [],
            peakLoadTimes: [],
            idlePatterns: [],
            userInteractionRate: 0,
            commandFrequency: {},
            typicalSessionLength: 0
        };
        this.profile.stateProfile = {
            cpuTypical: { min: 0, max: 0, avg: 0 },
            memoryTypical: { min: 0, max: 0, avg: 0 },
            diskTypical: {},
            processTypical: { min: 0, max: 0, avg: 0 },
            anomalies: [],
            stablePatterns: []
        };
        this.profile.cognition = {
            version: '1.0.0',
            totalExperiences: 0,
            evolutionStage: 'embryo',
            evolutionHistory: [],
            knowledgeDomains: [],
            capabilities: [],
            lastEvolution: null
        };
        this._stateBuffer = [];
        await this.save();
    }

    // Internal

    _generateCarrierId() {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).substring(2, 10);
        const hostname = require('os').hostname().substring(0, 4).toLowerCase();
        return `HC-${hostname}-${ts}-${rand}`;
    }

    _updateHardware(snapshot) {
        const hw = this.profile.hardware;

        if (snapshot.cpu) {
            if (!hw.cpu.model) hw.cpu.model = snapshot.cpu.model;
            if (!hw.cpu.count) hw.cpu.count = snapshot.cpu.count;
        }

        if (snapshot.memory) {
            if (!hw.memory.total) {
                hw.memory.total = snapshot.memory.totalBytes || snapshot.memory.total;
            }
        }

        if (snapshot.disk && Array.isArray(snapshot.disk)) {
            if (hw.disk.length === 0) {
                hw.disk = snapshot.disk.map(d => ({
                    drive: d.drive || d.mount,
                    total: d.totalBytes || d.total || 0
                }));
            }
        }

        if (snapshot.os) {
            hw.os = { ...hw.os, ...snapshot.os };
        } else {
            // 首次尝试获取OS信息
            if (!hw.os.platform) {
                try {
                    const os = require('os');
                    hw.os = {
                        platform: os.platform(),
                        hostname: os.hostname(),
                        release: os.release(),
                        arch: os.arch(),
                        uptime: os.uptime()
                    };
                } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
            }
        }

        // 更新总运行时间
        this.profile.identity.totalUptime += (snapshot.interval || 30); // 假设30秒间隔
    }

    _updateStateProfile() {
        const buffer = this._stateBuffer;
        if (buffer.length < 2) return;

        const sp = this.profile.stateProfile;

        // CPU 统计
        const cpuValues = buffer
            .map(s => s.cpu?.loadAvg ? s.cpu.loadAvg[0] * 100 / (s.cpu.count || 1) : null)
            .filter(v => v !== null);

        if (cpuValues.length > 0) {
            sp.cpuTypical = {
                min: Math.round(Math.min(...cpuValues) * 10) / 10,
                max: Math.round(Math.max(...cpuValues) * 10) / 10,
                avg: Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length * 10) / 10
            };
        }

        // 内存统计
        const memValues = buffer
            .map(s => s.memory?.usagePercent ? parseFloat(s.memory.usagePercent) : null)
            .filter(v => v !== null);

        if (memValues.length > 0) {
            sp.memoryTypical = {
                min: Math.round(Math.min(...memValues) * 10) / 10,
                max: Math.round(Math.max(...memValues) * 10) / 10,
                avg: Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length * 10) / 10
            };
        }

        // 进程数统计
        const procValues = buffer
            .map(s => s.processes?.count || s.processes)
            .filter(v => v !== null && v !== undefined);

        if (procValues.length > 0) {
            sp.processTypical = {
                min: Math.min(...procValues),
                max: Math.max(...procValues),
                avg: Math.round(procValues.reduce((a, b) => a + b, 0) / procValues.length)
            };
        }

        // 检测稳定模式
        this._detectStablePatterns();
    }

    _detectStablePatterns() {
        const buffer = this._stateBuffer;
        if (buffer.length < 50) return;

        const sp = this.profile.stateProfile;

        // 检测 CPU 稳定区间（长时间在某个范围内）
        const recent = buffer.slice(-50);
        const cpuAvg = recent.reduce((sum, s) => {
            const load = s.cpu?.loadAvg ? s.cpu.loadAvg[0] * 100 / (s.cpu.count || 1) : 0;
            return sum + load;
        }, 0) / 50;

        if (cpuAvg < 20) {
            this._addStablePattern('cpu_idle', `CPU长期低负载(${cpuAvg.toFixed(1)}%)`);
        } else if (cpuAvg > 80) {
            this._addStablePattern('cpu_busy', `CPU持续高负载(${cpuAvg.toFixed(1)}%)`);
        }

        // 检测内存稳定模式
        const memAvg = recent.reduce((sum, s) => {
            return sum + (parseFloat(s.memory?.usagePercent) || 0);
        }, 0) / 50;

        if (memAvg > 80) {
            this._addStablePattern('memory_pressure', `内存持续高压(${memAvg.toFixed(1)}%)`);
        }
    }

    _addStablePattern(type, description) {
        const sp = this.profile.stateProfile;
        const existing = sp.stablePatterns.findIndex(p => p.type === type);

        if (existing >= 0) {
            sp.stablePatterns[existing].description = description;
            sp.stablePatterns[existing].lastSeen = new Date().toISOString();
            sp.stablePatterns[existing].count++;
        } else {
            sp.stablePatterns.push({
                type,
                description,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                count: 1
            });
        }

        // 限制数量
        if (sp.stablePatterns.length > 20) {
            sp.stablePatterns = sp.stablePatterns.slice(-20);
        }
    }

    _updateActiveHours() {
        const hour = new Date().getHours();
        const hours = this.profile.behavior.activeHours;

        if (!hours[hour]) {
            hours[hour] = 0;
        }
        hours[hour]++;

        // 更新高峰时段
        const total = hours.reduce((a, b) => a + b, 0);
        if (total > 10) {
            const peakThreshold = Math.max(...hours) * 0.7;
            this.profile.behavior.peakLoadTimes = hours
                .map((count, hour) => ({ hour, count, ratio: count / total }))
                .filter(h => h.count >= peakThreshold)
                .map(h => h.hour);
        }
    }

    _updateCommonTasks(type) {
        const tasks = this.profile.behavior.commonTasks;
        const existing = tasks.find(t => t.type === type);

        if (existing) {
            existing.count++;
            existing.lastSeen = new Date().toISOString();
        } else {
            tasks.push({
                type,
                count: 1,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            });
        }

        // 按频率排序并限制数量
        tasks.sort((a, b) => b.count - a.count);
        if (tasks.length > 20) {
            this.profile.behavior.commonTasks = tasks.slice(0, 20);
        }
    }

    _updateDailyStats(snapshot) {
        const today = new Date().toISOString().substring(0, 10);
        if (!this._dailyStats.has(today)) {
            this._dailyStats.set(today, {
                date: today,
                samples: 0,
                cpuAvg: 0,
                memAvg: 0,
                errors: 0,
                interactions: 0
            });
        }

        const stats = this._dailyStats.get(today);
        stats.samples++;

        const cpuLoad = snapshot.cpu?.loadAvg ? snapshot.cpu.loadAvg[0] * 100 / (snapshot.cpu.count || 1) : 0;
        stats.cpuAvg = (stats.cpuAvg * (stats.samples - 1) + cpuLoad) / stats.samples;

        const memUsage = parseFloat(snapshot.memory?.usagePercent) || 0;
        stats.memAvg = (stats.memAvg * (stats.samples - 1) + memUsage) / stats.samples;

        // 限制保存的天数
        if (this._dailyStats.size > 365) {
            const oldest = Array.from(this._dailyStats.keys()).sort()[0];
            this._dailyStats.delete(oldest);
        }
    }

    _updateFingerprint() {
        const fp = this.profile.fingerprint;
        const hw = this.profile.hardware;
        const bh = this.profile.behavior;

        // 硬件签名
        const hwComponents = [
            hw.cpu.model || '',
            hw.cpu.count || '',
            hw.memory.total || '',
            (hw.disk || []).map(d => d.drive + d.total).join(''),
            hw.os.platform || '',
            hw.os.hostname || ''
        ];
        fp.hardwareSignature = this._hash(hwComponents.join('|'));

        // 行为签名
        const topTasks = bh.commonTasks.slice(0, 5).map(t => t.type).join(',');
        const peakHours = (bh.peakLoadTimes || []).join(',');
        fp.behaviorSignature = this._hash(`${topTasks}|${peakHours}|${bh.userInteractionRate.toFixed(2)}`);

        // 软件签名
        const swComponents = [
            hw.os.platform || '',
            hw.os.release || '',
            Object.keys(bh.commandFrequency).slice(0, 10).join(',')
        ];
        fp.softwareSignature = this._hash(swComponents.join('|'));

        // Composite score 0-1 (higher = more distinctive/mature profile)
        const hasHardware = fp.hardwareSignature && fp.hardwareSignature.length > 4;
        const hasBehavior = bh.commonTasks.length > 2 && this._stateBuffer.length > 100;
        const hasSoftware = Object.keys(bh.commandFrequency).length > 3;

        let score = 0;
        if (hasHardware) score += 0.25;
        if (hasBehavior) score += 0.4;
        if (hasSoftware) score += 0.2;
        if (this.profile.cognition.totalExperiences > 100) score += 0.15;

        fp.compositeScore = Math.min(1.0, score);
    }

    _updateEvolutionStage() {
        const total = this.profile.cognition.totalExperiences;
        const historyLen = this.profile.cognition.evolutionHistory.length;

        if (total < 10) {
            this.profile.cognition.evolutionStage = 'embryo';
        } else if (total < 100) {
            this.profile.cognition.evolutionStage = 'growing';
        } else if (total < 1000) {
            this.profile.cognition.evolutionStage = 'maturing';
        } else {
            this.profile.cognition.evolutionStage = 'mature';
        }

        // 进化阶段影响能力列表
        const stage = this.profile.cognition.evolutionStage;
        const baseCapabilities = ['state_awareness', 'experience_recording'];
        const growingCapabilities = [...baseCapabilities, 'pattern_detection', 'trend_analysis'];
        const maturingCapabilities = [...growingCapabilities, 'knowledge_building', 'decision_support'];
        const matureCapabilities = [...maturingCapabilities, 'self_evolution', 'predictive_analysis'];

        const capabilityMap = {
            'embryo': baseCapabilities,
            'growing': growingCapabilities,
            'maturing': maturingCapabilities,
            'mature': matureCapabilities
        };

        this.profile.cognition.capabilities = capabilityMap[stage] || baseCapabilities;
    }

    _calculateConfidence() {
        // 画像可信度——基于数据量和稳定性
        const bufferSize = this._stateBuffer.length;
        const taskCount = this.profile.behavior.commonTasks.length;
        const evolutionCount = this.profile.cognition.evolutionHistory.length;

        let confidence = 0;
        if (bufferSize > 10) confidence += 0.2;
        if (bufferSize > 100) confidence += 0.2;
        if (bufferSize > 500) confidence += 0.15;
        if (taskCount > 3) confidence += 0.15;
        if (evolutionCount > 0) confidence += 0.15;
        if (this.profile.fingerprint.compositeScore > 0.5) confidence += 0.15;

        return Math.min(1.0, confidence);
    }

    _assessDataQuality() {
        // 数据质量评估
        const hw = this.profile.hardware;
        const sp = this.profile.stateProfile;
        let quality = 0;

        if (hw.cpu.model) quality += 0.15;
        if (hw.memory.total) quality += 0.15;
        if (hw.disk.length > 0) quality += 0.1;
        if (hw.os.platform) quality += 0.1;
        if (sp.cpuTypical.avg > 0) quality += 0.15;
        if (sp.memoryTypical.avg > 0) quality += 0.15;
        if (this._stateBuffer.length > 50) quality += 0.2;

        return Math.min(1.0, quality);
    }

    _generateRecommendation() {
        // 根据画像状态生成建议
        const confidence = this._calculateConfidence();
        const recs = [];

        if (confidence < 0.3) {
            recs.push('继续采集数据，需要更多样本来建立可靠画像');
        }
        if (this._stateBuffer.length < 100) {
            recs.push('承载体状态采样不足，建议延长运行时间');
        }
        if (this.profile.behavior.commonTasks.length < 3) {
            recs.push('用户交互较少，画像缺乏行为特征维度');
        }
        if (this.profile.cognition.evolutionHistory.length === 0) {
            recs.push('认知进化尚未启动，需要积累更多经验触发进化');
        }
        if (this.profile.stateProfile.anomalies.length > 10) {
            recs.push('检测到多次异常，建议检查承载体运行状态');
        }

        return recs.length > 0 ? recs : ['画像已成熟，进入稳定运行阶段'];
    }

    _formatUptime(minutes) {
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}天${hours % 24}小时`;
        if (hours > 0) return `${hours}小时${Math.floor(minutes % 60)}分`;
        return `${Math.floor(minutes)}分`;
    }

    _hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    _ensureDirectories() {
        try {
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
            }
        } catch (e) {
            console.error('[CarrierProfile] Directory error:', e.message);
        }
    }

    _load() {
        try {
            const profilePath = path.join(this.storageDir, 'carrier_profile.json');
            if (fs.existsSync(profilePath)) {
                const data = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
                this.profile = { ...this.profile, ...data };
                console.log(`[CarrierProfile] Loaded profile for ${this.profile.identity.carrierId}`);
            }

            const statsPath = path.join(this.storageDir, 'daily_stats.json');
            if (fs.existsSync(statsPath)) {
                const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
                for (const [date, data] of Object.entries(stats)) {
                    this._dailyStats.set(date, data);
                }
            }
        } catch (e) {
            console.warn('[CarrierProfile] Load error (benign):', e.message);
        }
    }
}

module.exports = CarrierProfile;
