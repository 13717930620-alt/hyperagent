/**
 * CarrierSelfDiscovery — scans hardware, software, services, network, and environment on startup.
 */

const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class CarrierSelfDiscovery {
    constructor(options = {}) {
        this.carrierType = options.carrierType || 'pc';
        this.debug = options.debug || false;

        // 扫描结果缓存
        this._inventory = null;
        this._lastScanTime = null;

        // 发现范围配置
        this.config = {
            scanHardware: options.scanHardware !== false,
            scanSystem: options.scanSystem !== false,
            scanSoftware: options.scanSoftware !== false,
            scanEnvironment: options.scanEnvironment !== false,
            scanNetwork: options.scanNetwork !== false,
            scanCapabilities: options.scanCapabilities !== false,
            deepScan: options.deepScan || false,   // 深度扫描（更耗时）
            timeout: options.timeout || 15000
        };

        this.stats = {
            totalDiscoveries: 0,
            lastDiscoveryTime: null,
            discoveryCount: 0
        };
    }

    // Public API

    /**
     * 执行全面发现扫描
     * @param {object} [options] - 覆盖默认配置
     * @returns {object} 完整的承载体清单
     */
    async discoverAll(options = {}) {
        const config = { ...this.config, ...options };

        this.stats.discoveryCount++;
        this.stats.lastDiscoveryTime = new Date().toISOString();

        const inventory = {
            carrierType: this.carrierType,
            scanTime: new Date().toISOString(),
            scanVersion: '1.0',
            hardware: config.scanHardware ? await this.discoverHardware() : {},
            system: config.scanSystem ? await this.discoverSystem() : {},
            software: config.scanSoftware ? await this.discoverSoftware() : {},
            environment: config.scanEnvironment ? await this.discoverEnvironment() : {},
            network: config.scanNetwork ? await this.discoverNetwork() : {},
            capabilities: config.scanCapabilities ? await this.discoverCapabilities() : {},
            summary: {}
        };

        // 统计摘要
        inventory.summary = this._generateSummary(inventory);

        this._inventory = inventory;
        this.stats.totalDiscoveries = this._countItems(inventory);

        this._log(`自发现完成: ${inventory.summary.totalItems}项 (${inventory.summary.categories.join(', ')})`);

        return inventory;
    }

    /**
     * 发现硬件信息
     */
    async discoverHardware() {
        const info = {
            cpu: this._discoverCPU(),
            memory: this._discoverMemory(),
            disks: this._discoverDisks(),
            gpu: this._discoverGPU(),
            usb: [],
            peripherals: []
        };

        // 深度扫描获取更多硬件细节
        if (this.config.deepScan) {
            try {
                info.usb = this._execWMIC('Win32_USBControllerDevice') || [];
                info.peripherals = this._execWMIC('Win32_PnPEntity') || [];
            } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        }

        return info;
    }

    /**
     * 发现系统信息
     */
    async discoverSystem() {
        const info = {
            platform: os.platform(),
            hostname: os.hostname(),
            release: os.release(),
            arch: os.arch(),
            uptime: os.uptime(),
            version: '',
            manufacturer: '',
            model: '',
            bios: ''
        };

        try {
            const osInfo = this._execWMIC('Win32_ComputerSystem');
            if (osInfo && osInfo.length > 0) {
                info.manufacturer = osInfo[0].Manufacturer || '';
                info.model = osInfo[0].Model || '';
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        try {
            const biosInfo = this._execWMIC('Win32_BIOS');
            if (biosInfo && biosInfo.length > 0) {
                info.bios = biosInfo[0].SMBIOSBIOSVersion || '';
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // OS 版本详情
        try {
            const osDetail = this._execWMIC('Win32_OperatingSystem');
            if (osDetail && osDetail.length > 0) {
                info.version = osDetail[0].Version || '';
                if (osDetail[0].Caption) {
                    info.caption = osDetail[0].Caption;
                }
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // 系统服务（只数数量）
        try {
            const services = this._execWMIC('Win32_Service where "state=\'Running\'"');
            info.runningServices = services ? services.length : 0;
            info.services = (services || []).slice(0, 30).map(s => ({
                name: s.Name || s.name || 'unknown',
                displayName: s.DisplayName || s.displayName || '',
                status: s.State || s.state || 'running'
            }));
        } catch (e) {
            info.runningServices = 0;
            info.services = [];
        }

        // 进程统计
        info.totalProcesses = this._countProcesses();

        // 启动项
        info.startupPrograms = this._discoverStartupPrograms();

        return info;
    }

    /**
     * 发现已安装软件
     */
    async discoverSoftware() {
        const software = {
            installed: [],
            runtimes: [],
            drivers: [],
            devTools: [],
            securityTools: [],
            browserExtensions: []
        };

        // 从注册表和 WMI 获取已安装软件
        try {
            const installed = this._execWMIC('Win32_Product') ||
                this._getInstalledSoftwareFromRegistry();
            software.installed = (installed || []).slice(0, 200).map(s => ({
                name: s.Name || s.name || s.DisplayName || s.displayName || 'unknown',
                version: s.Version || s.version || '',
                vendor: s.Vendor || s.vendor || '',
                installDate: s.InstallDate || s.installDate || ''
            }));
        } catch (e) {
            software.installed = [];
        }

        // 运行时环境检测
        software.runtimes = this._detectRuntimes();

        // 分类软件
        for (const app of software.installed) {
            const name = (app.name || '').toLowerCase();
            if (this._isDevTool(name)) software.devTools.push(app.name);
            if (this._isSecurityTool(name)) software.securityTools.push(app.name);
        }

        return software;
    }

    /**
     * 发现环境信息
     */
    async discoverEnvironment() {
        const info = {
            envVars: {},
            userAccounts: [],
            drives: [],
            homeDir: os.homedir(),
            tmpDir: os.tmpdir(),
            hostname: os.hostname()
        };

        // 环境变量（CPU/内存/路径等关键变量）
        const keyVars = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
            'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'TEMP', 'TMP',
            'NODE_PATH', 'PYTHONPATH', 'JAVA_HOME', 'ANDROID_HOME'];
        for (const key of keyVars) {
            info.envVars[key] = process.env[key] || '';
        }

        // 驱动器
        try {
            const drives = this._execWMIC('Win32_LogicalDisk');
            info.drives = (drives || []).map(d => ({
                drive: d.DeviceID || d.deviceID || d.Caption || d.caption || '',
                type: d.DriveType || d.driveType || '',
                filesystem: d.FileSystem || d.fileSystem || '',
                size: d.Size || d.size || '0',
                free: d.FreeSpace || d.freeSpace || '0'
            }));
        } catch (e) {
            // fallback: list drive letters
            info.drives = ['A', 'B', 'C', 'D', 'E', 'F']
                .filter(l => fs.existsSync(l + ':\\'))
                .map(l => ({ drive: l + ':' }));
        }

        // 用户账户
        try {
            const users = this._execWMIC('Win32_UserAccount');
            info.userAccounts = (users || []).slice(0, 20).map(u => ({
                name: u.Name || u.name || '',
                domain: u.Domain || u.domain || '',
                status: u.Status || u.status || '',
                sid: u.SID || u.sid || ''
            }));
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        return info;
    }

    /**
     * 发现网络信息
     */
    async discoverNetwork() {
        const info = {
            interfaces: [],
            connections: [],
            dns: [],
            gateway: ''
        };

        // 网络接口
        const nets = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(nets)) {
            if (!addrs) continue;
            for (const addr of addrs) {
                info.interfaces.push({
                    name,
                    family: addr.family,
                    address: addr.address,
                    netmask: addr.netmask,
                    mac: addr.mac,
                    internal: addr.internal
                });
            }
        }

        // DNS
        try {
            const dnsData = fs.readFileSync('/etc/resolv.conf', 'utf8');
            info.dns = dnsData.split('\n')
                .filter(l => l.startsWith('nameserver'))
                .map(l => l.split(' ')[1])
                .filter(Boolean);
        } catch (e) {
            // Windows DNS via WMI
            try {
                const nicConfig = this._execWMIC('Win32_NetworkAdapterConfiguration where "IPEnabled=true"');
                if (nicConfig && nicConfig.length > 0) {
                    info.dns = nicConfig[0].DNSServerSearchOrder || [];
                    info.gateway = (nicConfig[0].DefaultIPGateway || [])[0] || '';
                }
            } catch (e2) {}
        }

        return info;
    }

    /**
     * 发现承载体能力
     */
    async discoverCapabilities() {
        const capabilities = {
            interfaces: [],        // 对外接口（API、协议等）
            tools: [],             // 可用工具
            sensors: [],           // 传感器
            actuators: [],         // 执行器
            limits: {}             // 安全限制
        };

        // 基本能力
        capabilities.interfaces.push('file_system', 'process_management', 'system_info');

        // 网络能力
        try {
            const netInterfaces = os.networkInterfaces();
            if (Object.keys(netInterfaces).length > 0) {
                capabilities.interfaces.push('network');
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // 文件系统能力
        capabilities.sensors.push('cpu_usage', 'memory_usage', 'disk_usage', 'process_count');

        // 执行器
        capabilities.actuators.push('command_execution', 'file_operations');

        // 安全限制
        capabilities.limits = {
            maxCpuUsage: 100,
            maxMemoryUsage: os.totalmem(),
            maxConcurrentProcesses: 500,
            allowedOperations: ['read', 'write', 'execute', 'query']
        };

        return capabilities;
    }

    /**
     * 获取上次扫描结果
     */
    getInventory() {
        return this._inventory;
    }

    /**
     * 获取扫描摘要
     */
    getSummary() {
        if (!this._inventory) return { scanned: false };
        return {
            ...this._inventory.summary,
            scanTime: this.stats.lastDiscoveryTime,
            scanCount: this.stats.discoveryCount
        };
    }

    getStats() {
        return this.stats;
    }

    // Hardware discovery

    _discoverCPU() {
        const cpus = os.cpus();
        return {
            model: cpus.length > 0 ? cpus[0].model : 'unknown',
            cores: cpus.length,
            architecture: os.arch(),
            speed: cpus.length > 0 ? cpus[0].speed : 0,
            loadAvg: os.loadavg()
        };
    }

    _discoverMemory() {
        return {
            total: os.totalmem(),
            free: os.freemem(),
            totalGB: (os.totalmem() / 1073741824).toFixed(1),
            freeGB: (os.freemem() / 1073741824).toFixed(1)
        };
    }

    _discoverDisks() {
        const disks = [];
        try {
            // 尝试 WMI
            const logicalDisks = this._execWMIC('Win32_LogicalDisk');
            if (logicalDisks && logicalDisks.length > 0) {
                for (const d of logicalDisks) {
                    disks.push({
                        drive: d.DeviceID || d.Caption || d.name || '',
                        type: d.DriveType || '',
                        filesystem: d.FileSystem || '',
                        total: parseInt(d.Size) || 0,
                        free: parseInt(d.FreeSpace) || 0,
                        label: d.VolumeName || d.volumeName || ''
                    });
                }
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // fallback: 检查常见盘符
        if (disks.length === 0) {
            for (const letter of 'CDEFGHIJK') {
                const p = letter + ':\\';
                try {
                    const stat = fs.statSync(p);
                    disks.push({ drive: p, total: 0, free: 0 });
                } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
            }
        }

        return disks;
    }

    _discoverGPU() {
        try {
            const video = this._execWMIC('Win32_VideoController');
            if (video && video.length > 0) {
                return video.map(v => ({
                    name: v.Name || v.name || 'unknown',
                    ram: v.AdapterRAM || v.adapterRAM || 0,
                    driver: v.DriverVersion || v.driverVersion || '',
                    resolution: `${v.CurrentHorizontalResolution || 0}x${v.CurrentVerticalResolution || 0}`
                }));
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        return [];
    }

    // Software discovery

    _getInstalledSoftwareFromRegistry() {
        const list = [];
        const paths = [
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];

        for (const regPath of paths) {
            try {
                const result = execSync(
                    `reg query "HKLM\\${regPath}" /s /v DisplayName 2>nul`,
                    { encoding: 'utf8', timeout: 5000 }
                );
                const lines = result.split('\n');
                let currentKey = '';
                for (const line of lines) {
                    const keyMatch = line.match(/^HKEY_/);
                    if (keyMatch) {
                        currentKey = line.trim();
                        continue;
                    }
                    if (line.includes('DisplayName')) {
                        const parts = line.split('REG_SZ');
                        if (parts.length > 1) {
                            const name = parts[1].trim();
                            if (name && name.length < 100) {
                                list.push({ Name: name, Version: '', Vendor: '' });
                            }
                        }
                    }
                }
            } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        }

        return list;
    }

    _detectRuntimes() {
        const runtimes = [];

        // Node.js
        try { runtimes.push({ name: 'Node.js', version: process.version }); } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // Python
        try {
            const pyVer = execSync('python --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'Python', version: pyVer });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // Git
        try {
            const gitVer = execSync('git --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'Git', version: gitVer });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // Docker
        try {
            const dockerVer = execSync('docker --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'Docker', version: dockerVer });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // npm
        try {
            const npmVer = execSync('npm --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'npm', version: npmVer });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // Java
        try {
            const javaVer = execSync('java -version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'Java', version: javaVer.split('\n')[0] });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // Go
        try {
            const goVer = execSync('go version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'Go', version: goVer });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        // 包管理器
        try {
            const pipVer = execSync('pip --version 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
            runtimes.push({ name: 'pip', version: pipVer.split(' ')[1] || '' });
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }

        return runtimes;
    }

    _discoverStartupPrograms() {
        const programs = [];
        try {
            const result = execSync(
                'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" 2>nul',
                { encoding: 'utf8', timeout: 3000 }
            );
            const lines = result.split('\n');
            for (const line of lines) {
                if (line.includes('REG_SZ') || line.includes('REG_EXPAND_SZ')) {
                    const parts = line.split('REG_SZ');
                    const key = line.split('REG_SZ')[0].trim();
                    const val = parts.length > 1 ? parts[1].trim() : '';
                    if (key) programs.push({ name: key.replace(/^.*\\/, ''), path: val });
                }
            }
        } catch (e) { console.warn(`[cognitive_core] Unhandled error: ${e.message}`); }
        return programs;
    }

    // Helpers

    _execWMIC(query) {
        try {
            const result = execSync(
                `wmic ${query} get /format:csv 2>nul`,
                { encoding: 'utf8', timeout: this.config.timeout }
            );
            return this._parseWMICOutput(result);
        } catch (e) {
            return null;
        }
    }

    _parseWMICOutput(csvText) {
        const lines = csvText.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split(',').map(h => h.trim());
        const result = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            if (values.length === headers.length && values.some(v => v)) {
                const obj = {};
                for (let j = 1; j < headers.length; j++) {
                    if (j < values.length) {
                        obj[headers[j]] = values[j];
                    }
                }
                result.push(obj);
            }
        }

        return result;
    }

    _countProcesses() {
        try {
            const result = execSync('tasklist /NH 2>&1', { encoding: 'utf8', timeout: 3000 });
            return result.split('\n').length - 3; // 减去标题和空行
        } catch (e) {
            return 0;
        }
    }

    _isDevTool(name) {
        const devKeywords = ['sdk', 'studio', 'visual studio', 'code', 'compiler', 'debug',
            'git', 'node.js', 'python', 'docker', 'kubernetes', 'terminal',
            'ssh', 'postman', 'jmeter', 'vscode', 'idea', 'webstorm', 'eclipse'];
        return devKeywords.some(k => name.includes(k));
    }

    _isSecurityTool(name) {
        const secKeywords = ['antivirus', 'firewall', 'defender', 'security', 'protection',
            'virus', 'malware', 'encrypt', 'vpn', 'bitdefender', 'norton', 'kaspersky'];
        return secKeywords.some(k => name.includes(k));
    }

    _generateSummary(inventory) {
        const categories = [];
        let totalItems = 0;

        if (inventory.hardware && inventory.hardware.cpu) {
            categories.push('硬件');
            totalItems += 5 + (inventory.hardware.disks || []).length;
        }
        if (inventory.system) {
            categories.push('系统');
            totalItems += 10;
            totalItems += (inventory.system.services || []).length;
            totalItems += (inventory.system.startupPrograms || []).length;
        }
        if (inventory.software && inventory.software.installed) {
            categories.push('软件');
            totalItems += inventory.software.installed.length;
            totalItems += inventory.software.runtimes.length;
        }
        if (inventory.environment) {
            categories.push('环境');
            totalItems += Object.keys(inventory.envVars || {}).length;
            totalItems += (inventory.drives || []).length;
        }
        if (inventory.network && inventory.network.interfaces) {
            categories.push('网络');
            totalItems += inventory.network.interfaces.length;
        }
        if (inventory.capabilities) {
            categories.push('能力');
            totalItems += inventory.capabilities.interfaces.length;
        }

        return {
            totalItems,
            categories,
            cpuModel: inventory.hardware?.cpu?.model || '',
            memoryGB: inventory.hardware?.memory?.totalGB || '',
            osPlatform: inventory.system?.platform || '',
            hostname: inventory.system?.hostname || '',
            softwareCount: inventory.software?.installed?.length || 0,
            runtimeCount: inventory.software?.runtimes?.length || 0
        };
    }

    _countItems(obj, depth = 0) {
        if (depth > 3) return 0;
        let count = 0;
        for (const value of Object.values(obj)) {
            if (Array.isArray(value)) {
                count += value.length;
            } else if (typeof value === 'object' && value !== null) {
                count += this._countItems(value, depth + 1);
            } else if (value !== null && value !== undefined && value !== '') {
                count++;
            }
        }
        return count;
    }

    _log(msg) {
        console.log(`[CarrierDiscovery] ${msg}`);
    }
}

module.exports = CarrierSelfDiscovery;
