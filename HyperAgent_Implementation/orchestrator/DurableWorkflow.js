// DurableWorkflow - persistent workflow engine with event sourcing

const fs = require('fs');
const path = require('path');

class DurableWorkflow {
    constructor(options = {}) {
        this.workflowId = options.workflowId || `wf_${Date.now()}`;
        this.storageDir = options.storageDir || path.join(process.cwd(), 'workflows');

        this._events = [];
        this._state = {
            status: 'CREATED',           // CREATED | RUNNING | PAUSED | COMPLETED | FAILED
            startedAt: null,
            completedAt: null,
            currentActivity: null,
            completedActivities: [],
            result: null,
            error: null
        };

        this._maxRetries = options.maxRetries || 3;
        this._initialized = false;
    }

    /**
     * Initialize: recover incomplete workflow or create new event log
     */
    async init() {
        if (this._initialized) return;
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // 尝试恢复
        const recovered = await this._loadEvents();
        if (recovered && this._events.length > 0) {
            this._replay();
            console.log(`[DurableWorkflow] Recovered workflow ${this.workflowId} (${this._state.status}, ${this._events.length} events)`);
        }

        this._initialized = true;
        return this._state;
    }

    /**
     * Start the workflow
     */
    async start(workflowFn, args = {}) {
        await this.init();

        this._appendEvent('WORKFLOW_STARTED', { workflowFn: workflowFn.name || 'anonymous', args });
        this._state.status = 'RUNNING';
        this._state.startedAt = new Date().toISOString();

        try {
            // 执行工作流函数（它内部调用 executeActivity）
            const result = await workflowFn(this, args);
            this._state.result = result;
            this._state.status = 'COMPLETED';
            this._state.completedAt = new Date().toISOString();
            this._appendEvent('WORKFLOW_COMPLETED', { result });
            await this._persist();
            return { success: true, result };
        } catch (e) {
            this._state.status = 'FAILED';
            this._state.error = e.message;
            this._state.completedAt = new Date().toISOString();
            this._appendEvent('WORKFLOW_FAILED', { error: e.message });
            await this._persist();
            return { success: false, error: e.message };
        }
    }

    /**
     * Execute an activity (side-effect operation)
     */
    async executeActivity(activityFn, params, options = {}) {
        const activityName = activityFn.name || 'anonymous_activity';
        const maxRetries = options.retries || this._maxRetries;

        this._state.currentActivity = activityName;
        this._appendEvent('ACTIVITY_STARTED', { activity: activityName, params });

        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await activityFn(params);
                this._state.completedActivities.push({
                    activity: activityName,
                    params,
                    result,
                    attempt,
                    timestamp: new Date().toISOString()
                });
                this._state.currentActivity = null;
                this._appendEvent('ACTIVITY_COMPLETED', {
                    activity: activityName, result, attempt
                });
                await this._persist();
                return result;
            } catch (e) {
                lastError = e;
                console.warn(`[DurableWorkflow] Activity ${activityName} attempt ${attempt}/${maxRetries} failed: ${e.message}`);

                if (attempt < maxRetries) {
                    this._appendEvent('ACTIVITY_RETRY', {
                        activity: activityName, attempt, error: e.message
                    });
                    // 指数退避
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                }
            }
        }

        this._appendEvent('ACTIVITY_FAILED', {
            activity: activityName, error: lastError.message, attempts: maxRetries
        });
        await this._persist();
        throw lastError;
    }

    /**
     * Pause the workflow
     */
    async pause() {
        if (this._state.status !== 'RUNNING') return false;
        this._state.status = 'PAUSED';
        this._appendEvent('WORKFLOW_PAUSED', {});
        await this._persist();
        return true;
    }

    /**
     * Resume the workflow
     */
    async resume() {
        if (this._state.status !== 'PAUSED') return false;
        this._state.status = 'RUNNING';
        this._appendEvent('WORKFLOW_RESUMED', {});
        await this._persist();
        return true;
    }

    /**
     * Get workflow status
     */
    getStatus() {
        return {
            workflowId: this.workflowId,
            ...this._state,
            eventCount: this._events.length,
            storageDir: this.storageDir
        };
    }

    /**
     * 事件溯源：重放事件以恢复状态
     */
    _replay() {
        // 从事件日志重建状态
        this._state = {
            status: 'CREATED',
            startedAt: null,
            completedAt: null,
            currentActivity: null,
            completedActivities: [],
            result: null,
            error: null
        };

        for (const event of this._events) {
            switch (event.type) {
                case 'WORKFLOW_STARTED':
                    this._state.status = 'RUNNING';
                    this._state.startedAt = event.timestamp;
                    break;
                case 'ACTIVITY_STARTED':
                    this._state.currentActivity = event.data?.activity || 'unknown';
                    break;
                case 'ACTIVITY_COMPLETED':
                    this._state.completedActivities.push(event.data);
                    this._state.currentActivity = null;
                    break;
                case 'ACTIVITY_FAILED':
                    this._state.currentActivity = null;
                    this._state.error = event.data?.error;
                    break;
                case 'WORKFLOW_PAUSED':
                    this._state.status = 'PAUSED';
                    break;
                case 'WORKFLOW_RESUMED':
                    this._state.status = 'RUNNING';
                    break;
                case 'WORKFLOW_COMPLETED':
                    this._state.status = 'COMPLETED';
                    this._state.result = event.data?.result;
                    this._state.completedAt = event.timestamp;
                    break;
                case 'WORKFLOW_FAILED':
                    this._state.status = 'FAILED';
                    this._state.error = event.data?.error;
                    this._state.completedAt = event.timestamp;
                    break;
            }
        }
    }

    _appendEvent(type, data = {}) {
        this._events.push({
            id: `evt_${Date.now()}_${this._events.length}`,
            type,
            data,
            timestamp: new Date().toISOString(),
            workflowId: this.workflowId
        });
    }

    async _persist() {
        const filePath = path.join(this.storageDir, `${this.workflowId}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify({
            workflowId: this.workflowId,
            events: this._events,
            state: this._state
        }, null, 2));
    }

    async _loadEvents() {
        const filePath = path.join(this.storageDir, `${this.workflowId}.json`);
        try {
            const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
            this._events = data.events || [];
            this._state = data.state || this._state;
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 恢复所有未完成的工作流
     */
    static async recover(storageDir) {
        const dir = storageDir || path.join(process.cwd(), 'workflows');
        const incomplete = [];

        try {
            const files = await fs.promises.readdir(dir);
            for (const file of files.filter(f => f.endsWith('.json'))) {
                try {
                    const data = JSON.parse(await fs.promises.readFile(path.join(dir, file), 'utf8'));
                    if (data.state && data.state.status === 'RUNNING') {
                        incomplete.push({
                            workflowId: data.workflowId,
                            eventCount: (data.events || []).length,
                            startedAt: data.state.startedAt
                        });
                    }
                } catch (e) { console.warn(`[orchestrator] Unhandled error: ${e.message}`); }
            }
        } catch (e) {
            // Directory may not exist
        }

        return incomplete;
    }

    getStats() {
        return {
            workflowId: this.workflowId,
            status: this._state.status,
            events: this._events.length,
            completedActivities: this._state.completedActivities.length,
            startedAt: this._state.startedAt
        };
    }
}

module.exports = DurableWorkflow;
