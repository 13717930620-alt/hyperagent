/**
 * JingxuanAgent_PluginAPI.js — 插件系统
 *
 * 从 plugins/ 目录自动发现和加载外部工具插件
 * 插件 = 一个导出以下接口的 .js 文件：
 *
 *   module.exports = {
 *     name: 'my-tool',
 *     description: 'Plugin description',
 *     schema: { type: 'object', properties: { ... } },
 *     handler: async (params, context) => { ... },
 *     isEnabled: () => true/false,
 *   }
 *
 * 也支持导出数组批量注册。
 */

const fs = require('fs');
const path = require('path');

class PluginLoader {
  constructor(toolRegistry, pluginDirs = []) {
    this.registry = toolRegistry;
    this.dirs = pluginDirs.length > 0 ? pluginDirs : [
      path.join(process.cwd(), 'plugins'),
      path.join(process.cwd(), 'JingxuanAgent_Plugins'),
    ];
    this.loaded = [];
    this.failed = [];
    this.watchers = [];
  }

  async discover() {
    this.loaded = [];
    this.failed = [];

    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f =>
        f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('.')
      );

      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const mod = require(fullPath);
          const plugins = Array.isArray(mod) ? mod : [mod];

          for (const plugin of plugins) {
            this._registerPlugin(plugin, file, fullPath);
          }
          this.loaded.push({ file, name: Array.isArray(mod) ? mod.map(m => m.name).join(',') : mod.name });
        } catch (err) {
          this.failed.push({ file, error: err.message });
        }
      }
    }

    return { loaded: this.loaded, failed: this.failed };
  }

  _registerPlugin(plugin, fileName, fullPath) {
    if (!plugin.name || !plugin.handler) {
      this.failed.push({ file: fileName, error: 'Missing name or handler' });
      return;
    }

    const { ToolDefinition, Schema } = require('./JingxuanAgent_CC_ToolSystem.js');

    const schema = plugin.schema
      ? (plugin.schema instanceof Schema ? plugin.schema : Schema.object(plugin.schema.properties || {}))
      : Schema.object({});

    const tool = new ToolDefinition({
      name: plugin.name,
      description: plugin.description || `Plugin: ${plugin.name}`,
      schema,
      category: plugin.category || 'plugin',
      handler: plugin.handler,
      isEnabled: typeof plugin.isEnabled === 'function' ? plugin.isEnabled() : (plugin.isEnabled !== false),
      hidden: plugin.hidden || false,
    });

    this.registry.register(tool);
  }

  watch() {
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, (eventType, fileName) => {
          if (fileName && fileName.endsWith('.js')) {
            console.log(`[PluginAPI] Plugin file changed: ${fileName}`);
            // 清除缓存并重新加载
            const fullPath = path.join(dir, fileName);
            delete require.cache[require.resolve(fullPath)];
            this.discover().then(r =>
              console.log(`[PluginAPI] Reloaded: ${r.loaded.length} OK, ${r.failed.length} failed`)
            );
          }
        });
        this.watchers.push(watcher);
      } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
    }
  }

  stopWatching() {
    for (const w of this.watchers) {
      try { w.close(); } catch (e) { console.warn(`[.] Unhandled error: ${e.message}`); }
    }
    this.watchers = [];
  }

  getStats() {
    return {
      loaded: this.loaded.length,
      failed: this.failed.length,
      dirs: this.dirs,
      failures: this.failed,
    };
  }
}

module.exports = PluginLoader;
