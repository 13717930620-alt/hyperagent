// DeviceStateCollector - device state collector

const os = require('os');
const { execSync } = require('child_process');

class DeviceStateCollector {
    constructor(interval = 30000) {
        this.interval = interval;
        this.history = [];
        this.maxHistory = 60;
        this.currentState = {};
        this._timer = null;
        this._snapshotId = 0;
    }

    start() {
        this.collect();
        this._timer = setInterval(() => this.collect(), this.interval);
        return this;
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        return this;
    }

    collect() {
        this._snapshotId++;
        const snapshot = {
            id: this._snapshotId,
            timestamp: Date.now(),
            iso: new Date().toISOString(),
            cpu: this._collectCpu(),
            memory: this._collectMemory(),
            disk: this._collectDisk(),
            processes: this._collectProcessCount(),
            network: this._collectNetwork()
        };
        this.currentState = snapshot;
        this.history.push(snapshot);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
        return snapshot;
    }

    _collectCpu() {
        return {
            count: os.cpus().length,
            model: os.cpus()[0]?.model || 'unknown',
            loadAvg: os.loadavg(),
        };
    }

    _collectMemory() {
        const total = os.totalmem();
        const free = os.freemem();
        return {
            totalBytes: total,
            freeBytes: free,
            usedBytes: total - free,
            usagePercent: ((1 - free / total) * 100).toFixed(1)
        };
    }

    _collectDisk() {
        try {
            const df = execSync('wmic logicaldisk get caption,size,freespace /format:csv', { encoding: 'utf8', timeout: 3000 });
            return df.trim().split('\n').slice(1).filter(l => l).map(line => {
                const parts = line.split(',');
                return parts[1] ? { drive: parts[1], freeBytes: parseInt(parts[2]) || 0, totalBytes: parseInt(parts[3]) || 0 } : null;
            }).filter(Boolean);
        } catch (e) {
            return [{ error: 'disk info unavailable' }];
        }
    }

    _collectProcessCount() {
        try {
            const output = execSync('tasklist /NH /FO CSV', { encoding: 'utf8', timeout: 5000 });
            return { count: output.trim().split('\n').filter(l => l).length };
        } catch (e) {
            return { count: 0 };
        }
    }

    _collectNetwork() {
        const interfaces = [];
        try {
            const nets = os.networkInterfaces();
            for (const [name, addrs] of Object.entries(nets)) {
                for (const addr of addrs || []) {
                    if (!addr.internal) {
                        interfaces.push({ name, address: addr.address, family: addr.family, mac: addr.mac });
                    }
                }
            }
        } catch (e) { console.warn(`[device_abstraction] Unhandled error: ${e.message}`); }
        return interfaces;
    }

    getState() {
        return this.currentState;
    }

    getHistory(count = 10) {
        return this.history.slice(-count);
    }

    // Detect anomalies based on simple rules
    detectAnomalies() {
        const anomalies = [];
        const state = this.currentState;
        if (!state || !state.memory) return anomalies;

        const memUsage = parseFloat(state.memory.usagePercent);
        if (memUsage > 95) {
            anomalies.push({ severity: 'warning', message: `内存使用率 ${memUsage}%` });
        }
        return anomalies;
    }

    getLatestSnapshot() {
        return this.currentState;
    }
}

module.exports = DeviceStateCollector;
