// ================================================================
// Skill Tools — Agent 读取/创建技能
// ================================================================
import type { ToolDefinition } from "../agent/tool-registry";
import { SkillsManager } from "../utils/skills-manager";
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function createSkillTools(
  systemSkills: SkillsManager,
  botSkills: SkillsManager,
): ToolDefinition[] {
  // ================================================================
  // imtoagent_read_skill — 读取指定技能的完整内容
  // ================================================================
  const readSkillTool: ToolDefinition = {
    name: "imtoagent_read_skill",
    description: "Read the full content of an installed skill by name. Use when you see a skill listed in 'Installed Skills' and need its detailed instructions.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (e.g., 'code-review')" },
        scope: { type: "string", enum: ["system", "bot"], description: "Skill scope. Default: 'system'" },
      },
      required: ["name"],
    },
    handler: async (params) => {
      const scope = (params.scope as "system" | "bot") || "system";
      const name = params.name as string;
      const manager = scope === "system" ? systemSkills : botSkills;
      const content = manager.getSkillContent(name);
      if (!content) {
        return { error: `Skill "${name}" not found. Available: ${manager.list().map(s => s.name).join(", ") || "(none)"}` };
      }
      return { name, scope, content };
    },
  };

  // ================================================================
  // imtoagent_list_skills — 列出所有可用技能
  // ================================================================
  const listSkillsTool: ToolDefinition = {
    name: "imtoagent_list_skills",
    description: "List all installed skills with their names and descriptions.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["system", "bot", "all"], description: "Default: 'all'" },
      },
    },
    handler: async (params) => {
      const scope = (params.scope as any) || "all";
      const skills: any[] = [];
      if (scope === "system" || scope === "all") {
        for (const s of systemSkills.list()) skills.push({ name: s.name, description: s.description, scope: "system" });
      }
      if (scope === "bot" || scope === "all") {
        for (const s of botSkills.list()) skills.push({ name: s.name, description: s.description, scope: "bot" });
      }
      return { skills, count: skills.length };
    },
  };

  // ================================================================
  // imtoagent_create_skill — 创建新技能
  // ================================================================
  const createSkillTool: ToolDefinition = {
    name: "imtoagent_create_skill",
    description: "Create a new skill by generating a SKILL.md file in ~/.imtoagent/skills/<name>/",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (will be used as directory name, use kebab-case)" },
        description: { type: "string", description: "One-line description of what this skill does" },
        content: { type: "string", description: "Full SKILL.md content (Markdown). If omitted, a template is generated." },
        version: { type: "string", description: "Version string. Default: '1.0.0'" },
        requires_tools: { type: "array", items: { type: "string" }, description: "List of tool names this skill depends on" },
      },
      required: ["name", "description"],
    },
    handler: async (params) => {
      const name = params.name as string;
      const description = params.description as string;
      const version = (params.version as string) || "1.0.0";
      const requiresTools = (params.requires_tools as string[]) || [];
      let content = params.content as string | undefined;

      // Validate name
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        return { error: `Invalid skill name "${name}". Use lowercase letters, numbers, and hyphens, starting with a letter.` };
      }

      const skillsDir = path.join(os.homedir(), '.imtoagent', 'skills', name);

      // Check if already exists
      if (fs.existsSync(skillsDir)) {
        return { error: `Skill "${name}" already exists at ${skillsDir}` };
      }

      // Generate default content if not provided
      if (!content) {
        const requiresYaml = requiresTools.length > 0
          ? `requires_tools:\n${requiresTools.map(t => `  - ${t}`).join('\n')}`
          : 'requires_tools: []';

        content = `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n${requiresYaml}\n---\n\n# ${name}\n\n## 触发条件\n\n什么情况下模型会使用这个技能。\n\n## 使用方法\n\n1. 第一步\n2. 第二步\n3. 第三步\n\n## 注意事项\n\n- 重要提醒\n`;
      }

      // Create directory and write file
      try {
        fs.mkdirSync(skillsDir, { recursive: true });
        fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), content, 'utf-8');
        return {
          success: true,
          name,
          path: skillsDir,
          message: `Skill "${name}" created successfully.`,
        };
      } catch (err) {
        return { error: `Failed to create skill: ${(err as Error).message}` };
      }
    },
  };

  return [readSkillTool, listSkillsTool, createSkillTool];
}
