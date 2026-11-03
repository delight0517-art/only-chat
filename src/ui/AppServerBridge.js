/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Standard JSON-RPC 2.0 Codex App-Server Bridge matching Desktop & VSCode protocol specifications.
 */
'use strict';

const readline = require('node:readline');
const { AgentEngine } = require('../core/AgentEngine.js');

class AppServerBridge {
  constructor(options = {}) {
    this.engine = new AgentEngine(options);
    this.initialized = false;
  }

  startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async line => {
      if (!line.trim()) return;
      let request;
      try {
        request = JSON.parse(line);
      } catch (e) {
        this.sendError(null, -32700, 'Parse error');
        return;
      }

      await this.handleMessage(request);
    });

    rl.on('close', () => {
      process.exit(0);
    });
  }

  async handleMessage(req) {
    const { id, method, params } = req;

    switch (method) {
      case 'initialize': {
        this.initialized = true;
        this.sendResult(id, {
          serverInfo: {
            name: 'my-codex-app-server',
            version: '1.0.0'
          },
          capabilities: {
            tools: true,
            priorityChain: true,
            multiAccount: true
          }
        });
        break;
      }

      case 'initialized': {
        // Notification only, no response required
        break;
      }

      case 'account/rateLimits/read': {
        const status = this.engine.priorityChain.getStatus();
        this.sendResult(id, {
          rateLimitsByLimitId: {},
          quotaSource: 'unavailable',
          priorityChainStatus: status
        });
        break;
      }

      case 'account/read': {
        const active = this.engine.priorityChain.resolveActiveTier();
        this.sendResult(id, {
          account: active ? {
            id: active.id,
            email: active.email,
            provider: active.provider,
            model: active.model
          } : null
        });
        break;
      }

      case 'turn/start': {
        const prompt = params?.prompt || params?.message || '';
        try {
          const result = await this.engine.executeTurn(prompt, {
            onReasoningDelta: delta => {
              this.sendNotification('item/reasoning/textDelta', { delta });
            },
            onMessageDelta: delta => {
              this.sendNotification('item/agentMessage/delta', { delta });
            },
            onToolStart: call => {
              this.sendNotification('item/commandExecution/outputDelta', {
                command: call.name,
                status: 'started'
              });
            }
          });
          this.sendResult(id, { status: 'completed', result });
        } catch (turnErr) {
          this.sendError(id, -32000, turnErr.message);
        }
        break;
      }

      default: {
        this.sendError(id, -32601, `Method '${method}' not found`);
        break;
      }
    }
  }

  sendResult(id, result) {
    if (id === undefined || id === null) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(msg + '\n');
  }

  sendError(id, code, message) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    process.stdout.write(msg + '\n');
  }

  sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    process.stdout.write(msg + '\n');
  }
}

module.exports = { AppServerBridge };
