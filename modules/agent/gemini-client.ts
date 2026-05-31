// ================================================================
// Gemini CLI Client — spawn gemini subprocess, stream events
// ================================================================
// Similar to Claude Code SDK approach
// ================================================================

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

export interface GeminiClientOptions {
  workingDir: string;
  systemPrompt?: string;
  cancelSignal?: AbortSignal;
}

export interface GeminiOutput {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
  };
  error?: string;
}

export class GeminiClient {
  private process: ChildProcess | null = null;
  private output = '';
  private resolved = false;

  async run(prompt: string, options: GeminiClientOptions): Promise<GeminiOutput> {
    return new Promise((resolve, reject) => {
      this.output = '';
      this.resolved = false;

      try {
        const args = ['--prompt', prompt];
        if (options.systemPrompt) {
          args.unshift('--system-instruction', options.systemPrompt);
        }

        this.process = spawn('gemini', args, {
          cwd: options.workingDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        this.process.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        this.process.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        this.process.on('close', (code) => {
          if (this.resolved) return;
          this.resolved = true;

          if (code === 0) {
            resolve({
              text: stdout.trim(),
              error: undefined,
            });
          } else {
            resolve({
              text: '',
              error: stderr.trim() || `gemini exited with code ${code}`,
            });
          }
        });

        this.process.on('error', (err) => {
          if (this.resolved) return;
          this.resolved = true;
          resolve({
            text: '',
            error: `gemini spawn failed: ${err.message}`,
          });
        });

        // Handle cancel signal
        if (options.cancelSignal) {
          options.cancelSignal.addEventListener('abort', () => {
            if (this.process && !this.resolved) {
              this.process.kill('SIGTERM');
              this.resolved = true;
              resolve({
                text: this.output,
                error: 'Cancelled by user',
              });
            }
          });
        }

      } catch (err: any) {
        this.resolved = true;
        resolve({
          text: '',
          error: `gemini launch failed: ${err.message}`,
        });
      }
    });
  }

  kill(): void {
    if (this.process && !this.resolved) {
      this.process.kill('SIGTERM');
      this.resolved = true;
    }
  }
}
