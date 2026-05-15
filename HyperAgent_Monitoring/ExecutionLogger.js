/**
 * ExecutionLogger — structured execution log system with trace IDs, log levels, and persistence.
 */
const fs = require('fs');
const path = require('path');

const LogLevel = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5
};

class LogEntry {
    constructor(level, message, context = {}) {
        this.id = `log_${Date.now()}_${Math.random().toString(36).substring(2, 2+6)}`;
        this.traceId = context.traceId || null;
        this.spanId = context.spanId || null;
        this.level = level;
        this.message = message;
        this.context = context;
        this.timestamp = new Date().toISOString();
        this.duration = context.duration || null;
    }

    toJSON() {
        return {
            id: this.id,
            traceId: this.traceId,
            spanId: this.spanId,
            level: Object.keys(LogLevel)[this.level],
            message: this.message,
            context: this.context,
            timestamp: this.timestamp,
            duration: this.duration
        };
    }
}

class ExecutionLogger {
    constructor(options = {}) {
        this.level = options.level || LogLevel.INFO;
        this.outputDir = options.outputDir || './logs';
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
        this.maxFiles = options.maxFiles || 5;
        
        this.currentFile = null;
        this.currentFileSize = 0;
        this.traceIndex = 0;
        this.spanIndex = 0;
        
        this._ensureOutputDir();
    }

    /**
     * [创建Trace] 创建新的追踪链
     */
    createTrace(operationName) {
        const traceId = `trace_${Date.now()}_${++this.traceIndex}`;
        return {
            traceId,
            rootSpanId: this._createSpan(traceId, null, operationName)
        };
    }

    /**
     * [创建Span] 创建追踪跨度
     */
    createSpan(traceId, parentSpanId, operationName) {
        const spanId = this._createSpan(traceId, parentSpanId, operationName);
        return {
            spanId,
            traceId
        };
    }

    /**
     * [记录] 记录日志
     */
    log(level, message, context = {}) {
        if (level < this.level) return;

        const entry = new LogEntry(level, message, context);
        const line = JSON.stringify(entry.toJSON()) + '\n';
        
        this._write(line);
        this._console(level, entry);
        
        return entry.id;
    }

    /**
     * [追踪] 创建追踪Span并记录
     */
    trace(operationName, fn, context = {}) {
        const traceId = context.traceId || this._generateTraceId();
        const spanId = this._createSpan(traceId, context.parentSpanId, operationName);
        
        const spanContext = { traceId, spanId, ...context };
        const startTime = Date.now();
        
        this.log(LogLevel.DEBUG, `Start: ${operationName}`, spanContext);
        
        try {
            const result = fn(spanContext);
            
            const duration = Date.now() - startTime;
            this.log(LogLevel.DEBUG, `End: ${operationName}`, { 
                ...spanContext, 
                duration,
                success: true 
            });
            
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this.log(LogLevel.ERROR, `Error: ${operationName}`, { 
                ...spanContext, 
                duration,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * [便捷方法]
     */
    trace(msg, ctx) { return this.log(LogLevel.TRACE, msg, ctx); }
    debug(msg, ctx) { return this.log(LogLevel.DEBUG, msg, ctx); }
    info(msg, ctx) { return this.log(LogLevel.INFO, msg, ctx); }
    warn(msg, ctx) { return this.log(LogLevel.WARN, msg, ctx); }
    error(msg, ctx) { return this.log(LogLevel.ERROR, msg, ctx); }
    fatal(msg, ctx) { return this.log(LogLevel.FATAL, msg, ctx); }

    /**
     * [获取日志] 获取指定 Trace 的所有日志
     */
    getLogsByTrace(traceId) {
        // 简化实现，实际应从文件读取
        return [];
    }

    // ============ 私有方法 ============

    _createSpan(traceId, parentSpanId, operationName) {
        return `span_${Date.now()}_${++this.spanIndex}`;
    }

    _generateTraceId() {
        return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 2+8)}`;
    }

    _ensureOutputDir() {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    _getCurrentFile() {
        if (!this.currentFile) {
            const date = new Date().toISOString().split('T')[0];
            const filename = `hyperagent_${date}.log`;
            this.currentFile = path.join(this.outputDir, filename);
            this.currentFileSize = 0;
        }
        return this.currentFile;
    }

    _write(line) {
        try {
            const file = this._getCurrentFile();
            fs.appendFileSync(file, line);
            this.currentFileSize += Buffer.byteLength(line);
            
            // 轮转
            if (this.currentFileSize >= this.maxFileSize) {
                this._rotate();
            }
        } catch (e) {
            console.error('[ExecutionLogger] Write error:', e.message);
        }
    }

    _rotate() {
        if (!this.currentFile) return;
        
        // 重命名当前文件
        const timestamp = Date.now();
        const rotated = this.currentFile.replace('.log', `_${timestamp}.log`);
        
        try {
            fs.renameSync(this.currentFile, rotated);
        } catch (e) { console.warn(`[HyperAgent_Monitoring] Unhandled error: ${e.message}`); }
        
        this.currentFile = null;
        this.currentFileSize = 0;
        
        // 清理旧文件
        this._cleanupOldFiles();
    }

    _cleanupOldFiles() {
        try {
            const files = fs.readdirSync(this.outputDir)
                .filter(f => f.endsWith('.log'))
                .sort()
                .reverse();
            
            if (files.length > this.maxFiles) {
                for (const f of files.slice(this.maxFiles)) {
                    fs.unlinkSync(path.join(this.outputDir, f));
                }
            }
        } catch (e) { console.warn(`[HyperAgent_Monitoring] Unhandled error: ${e.message}`); }
    }

    _console(level, entry) {
        const prefix = {
            [LogLevel.TRACE]: '🔍',
            [LogLevel.DEBUG]: '🐛',
            [LogLevel.INFO]: 'ℹ️',
            [LogLevel.WARN]: '⚠️',
            [LogLevel.ERROR]: '❌',
            [LogLevel.FATAL]: '💀'
        }[level] || '•';

        const msg = `${prefix} [${entry.timestamp}] ${entry.message}`;
        if (level >= LogLevel.ERROR) {
            console.error(msg);
        } else {
            console.log(msg);
        }
    }
}

module.exports = ExecutionLogger;