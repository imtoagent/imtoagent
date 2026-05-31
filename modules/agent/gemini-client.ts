// ================================================================
// Gemini CLI Client — spawn gemini subprocess, stream output
// ================================================================
// Note: gemini-adapter.ts now handles subprocess management inline.
// This file is kept for reference and potential future use (e.g.,
// streaming mode, API-based access without CLI).
// ================================================================

import { spawn, ChildProcess } from 'child_process';

export interface GeminiClientOptions {
  model: string;
  prompt: string;
  systemPrompt?: string;
  workingDir?: string;
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
  private resolved = false;

  async run(options: GeminiClientOptions): Promise<GeminiOutput> {
    return new Promise((resolve) => {
      this.resolved = false;

      try {
        const args = ['--model', options.model, '--prompt', options.prompt];
        if (options.systemPrompt) {
          args.unshift('--system-instruction', options.systemPrompt);
        }

        this.process = spawn('gemini', args, {
          cwd: options.workingDir || process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
          },
        });

        let stdout = '';
        let stderr = '';

        this.process.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        this.process.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        this.process.on('close', (code) => {
          if (this.resolved) return;
          this.resolved = true;
          if (code === 0) {
            resolve({ text: stdout.trim() });
          } else {
            resolve({ text: '', error: stderr.trim() || `gemini exited with code ${code}` });
          }
        });

        this.process.on('error', (err) => {
          if (this.resolved) return;
          this.resolved = true;
          resolve({ text: '', error: `gemini spawn failed: ${err.message}` });
        });

        if (options.cancelSignal) {
          options.cancelSignal.addEventListener('abort', () => {
            if (this.process && !this.resolved) {
              this.process.kill('SIGTERM');
              this.resolved = true;
              resolve({ text: stdout, error: 'Cancelled by user' });
            }
          });
        }
      } catch (err: unknown) {
        this.resolved = true;
        resolve({ text: '', error: `gemini launch failed: ${err.message}` });
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
