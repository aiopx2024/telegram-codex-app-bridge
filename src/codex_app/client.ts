import { EventEmitter } from 'node:events';
import net from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: any;
}

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: any;
}

export class CodexAppClient extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private socket: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private desiredRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private port: number | null = null;
  private connected = false;
  private userAgent: string | null = null;

  constructor(
    private readonly launchCommand: string,
    private readonly autolaunch: boolean,
    private readonly logger: Logger,
  ) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getUserAgent(): string | null {
    return this.userAgent;
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.connected) return;
    await this.startServer();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.child?.kill('SIGTERM');
    this.rejectPending(new Error('Codex app bridge stopped'));
    this.socket = null;
    this.child = null;
    this.connected = false;
  }

  async listThreads(limit: number): Promise<any[]> {
    const result = await this.request('thread/list', { limit, archived: false });
    return Array.isArray((result as any).data) ? (result as any).data : [];
  }

  async readThread(threadId: string, includeTurns = false): Promise<any> {
    const result = await this.request('thread/read', { threadId, includeTurns });
    return (result as any).thread;
  }

  async startThread(cwd: string | null, approvalPolicy: string): Promise<any> {
    const result = await this.request('thread/start', {
      cwd,
      approvalPolicy,
      model: null,
      modelProvider: null,
      sandbox: null,
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: null,
      dynamicTools: null,
      mockExperimentalField: null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    return (result as any).thread;
  }

  async resumeThread(threadId: string): Promise<any> {
    const result = await this.request('thread/resume', {
      threadId,
      cwd: null,
      approvalPolicy: null,
      baseInstructions: null,
      developerInstructions: null,
      config: null,
      sandbox: null,
      model: null,
      modelProvider: null,
      personality: null,
    });
    return (result as any).thread;
  }

  async startTurn(threadId: string, text: string, approvalPolicy: string, cwd: string | null): Promise<{ id: string; status: string }> {
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd,
      approvalPolicy,
      sandboxPolicy: null,
      model: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });
    return (result as any).turn;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, result });
  }

  async respondError(requestId: string | number, message: string): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message } });
  }

  private async startServer(): Promise<void> {
    if (this.autolaunch) {
      const launcher = spawn(this.launchCommand, { shell: true, detached: true, stdio: 'ignore' });
      launcher.unref();
    }
    this.port = await reservePort();
    this.child = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', chunk => {
      this.logger.debug('codex.app-server.stderr', chunk.toString().trim());
    });
    this.child.stdout?.on('data', chunk => {
      this.logger.debug('codex.app-server.stdout', chunk.toString().trim());
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.handleDisconnect({ code, signal, source: 'process-exit' });
    });
    await this.connectWebSocket();
    await this.initialize();
  }

  private async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.port}`;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          const onError = (event: Event) => {
            ws.close();
            reject(new Error(`WebSocket connect failed: ${String(event.type)}`));
          };
          ws.addEventListener('open', () => {
            this.socket = ws;
            this.connected = true;
            ws.addEventListener('message', message => this.handleMessage(String(message.data)));
            ws.addEventListener('close', () => {
              this.socket = null;
              this.handleDisconnect({ code: 'ws-close', source: 'websocket-close' });
            });
            ws.addEventListener('error', err => {
              this.logger.warn('codex.ws.error', String((err as ErrorEvent).message ?? 'unknown'));
            });
            resolve();
          }, { once: true });
          ws.addEventListener('error', onError, { once: true });
        });
        this.emit('connected');
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`Timed out connecting to ${url}`);
  }

  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'telegram-codex-app-bridge',
        title: 'Telegram Codex App Bridge',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'codex/event/agent_message_content_delta',
          'codex/event/agent_reasoning_delta',
          'codex/event/reasoning_content_delta',
          'codex/event/reasoning_raw_content_delta',
          'codex/event/exec_command_output_delta',
          'codex/event/item_started',
          'codex/event/item_completed',
        ]
      }
    });
    this.userAgent = (result as any).userAgent ?? null;
    this.send({ jsonrpc: '2.0', method: 'initialized' });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || !this.connected) {
      await this.start();
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('codex app-server socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.logger.warn('codex.message.parse_failed', { raw, error: String(error) });
      return;
    }

    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC error'));
      } else {
        pending.resolve((message as JsonRpcResponse).result);
      }
      return;
    }

    if ('id' in message && 'method' in message) {
      this.emit('serverRequest', message satisfies JsonRpcServerRequest);
      return;
    }

    if ('method' in message) {
      this.emit('notification', message satisfies JsonRpcNotification);
    }
  }

  private handleDisconnect(meta: Record<string, unknown>): void {
    if (this.connected) {
      this.connected = false;
    }
    this.rejectPending(new Error(`codex app-server disconnected: ${JSON.stringify(meta)}`));
    this.emit('disconnected', meta);
    if (this.desiredRunning) {
      this.scheduleReconnect();
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.desiredRunning) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.startServer();
      } catch (error) {
        this.logger.error('codex.reconnect_failed', { error: String(error) });
        this.scheduleReconnect();
      }
    }, 1500);
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
