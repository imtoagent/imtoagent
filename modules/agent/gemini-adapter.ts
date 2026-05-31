// ================================================================
// Gemini CLI Adapter — implements AgentAdapter interface
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput } from '../core/types';
import { GeminiClient } from './gemini-client';

export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';
  private client: GeminiClient;

  constructor() {
    this.client = new GeminiClient();
  }

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, systemPrompt, cancelSignal, sendProgress } = input;

    try {
      // Build full prompt with context
      let fullPrompt = text;

      // Add recent conversation context
      if (session.recentMessages && session.recentMessages.length > 0) {
        const context = session.recentMessages.slice(-4).join('\n\n');
        fullPrompt = `Previous conversation:\n${context}\n\n---\n\nUser: ${text}`;
      }

      // Send progress
      if (sendProgress) {
        await sendProgress('💭 Gemini is thinking...');
      }

      // Run Gemini CLI
      const result = await this.client.run(fullPrompt, {
        workingDir,
        systemPrompt,
        cancelSignal,
      });

      if (result.error) {
        return { error: result.error };
      }

      return {
        text: result.text,
        usage: result.usage || {
          inputTokens: 0,
          outputTokens: 0,
        },
      };

    } catch (err: any) {
      return { error: err.message || 'Gemini adapter failed' };
    }
  }

  healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');
      try {
        execSync('gemini --version', { stdio: 'pipe', timeout: 5000 });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  }

  cancel(): void {
    this.client.kill();
  }
}
