// ================================================================
// Task Management Tools
// ================================================================
// 供 Agent 调用的小任务管理工具集。
// Task 系统基于 HEARTBEAT.md 存储，与 Goal 系统独立。
// ================================================================

import type { ToolDefinition } from "../agent/tool-registry";
import type { TaskManager } from "../core/task-manager";
import type { ScheduledTask, TaskType } from "../core/types";

export function createTaskTools(taskManager: TaskManager): ToolDefinition[] {

  // ================================================================
  // create_task — 创建小任务
  // ================================================================
  const createTaskTool: ToolDefinition = {
    name: "imtoagent_create_task",
    description: "Create a small scheduled task in HEARTBEAT.md. Supports interval, once, scheduled, countdown types.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique task name" },
        type: { type: "string", description: "Task type: interval, once, scheduled, countdown" },
        interval: { type: "string", description: "Interval format: 5m, 1h, 30s (for interval/countdown types)" },
        at: { type: "string", description: "Scheduled time: HH:MM or ISO (for once/scheduled types)" },
        after: { type: "string", description: "Delay before execution: 10m, 1h (for once type)" },
        prompt: { type: "string", description: "Task prompt/instruction for the Agent" },
        maxRuns: { type: "number", description: "Max runs for countdown type" },
        onFailure: { type: "string", description: "On failure strategy: ignore, alert, retry" },
      },
      required: ["name", "type", "prompt"],
    },
    handler: async (params) => {
      const task: ScheduledTask = {
        name: params.name as string,
        type: (params.type as TaskType) || "interval",
        interval: params.interval as string,
        at: params.at as string,
        after: params.after as string,
        prompt: params.prompt as string,
        max_runs: params.maxRuns as number,
        on_failure: (params.onFailure as "ignore" | "alert" | "retry") || "alert",
      };
      const result = taskManager.addTask(task);
      return result.success
        ? { success: true, message: `Task "${params.name}" created` }
        : { success: false, message: result.error };
    },
  };

  // ================================================================
  // list_tasks — 查看小任务列表
  // ================================================================
  const listTasksTool: ToolDefinition = {
    name: "imtoagent_list_tasks",
    description: "List all small tasks from HEARTBEAT.md.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      const tasks = taskManager.listTasks();
      return { tasks: tasks.map(t => ({ name: t.name, type: t.type, interval: t.interval, at: t.at, prompt: t.prompt?.slice(0, 100) })) };
    },
  };

  // ================================================================
  // get_task — 查看单个小任务详情
  // ================================================================
  const getTaskTool: ToolDefinition = {
    name: "imtoagent_get_task",
    description: "Get details of a specific task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
      },
      required: ["name"],
    },
    handler: async (params) => {
      const task = taskManager.getTask(params.name as string);
      return task ? { task } : { error: `Task "${params.name}" not found` };
    },
  };

  // ================================================================
  // update_task — 更新小任务
  // ================================================================
  const updateTaskTool: ToolDefinition = {
    name: "imtoagent_update_task",
    description: "Update a small task's interval, prompt, or other properties.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
        interval: { type: "string", description: "New interval" },
        prompt: { type: "string", description: "New prompt" },
        at: { type: "string", description: "New scheduled time" },
        onFailure: { type: "string", description: "New on_failure strategy" },
      },
      required: ["name"],
    },
    handler: async (params) => {
      const updates: Partial<ScheduledTask> = {};
      if (params.interval) updates.interval = params.interval as string;
      if (params.prompt) updates.prompt = params.prompt as string;
      if (params.at) updates.at = params.at as string;
      if (params.onFailure) updates.on_failure = params.onFailure as "ignore" | "alert" | "retry";
      const result = taskManager.updateTask(params.name as string, updates);
      return result.success
        ? { success: true, message: `Task "${params.name}" updated` }
        : { success: false, message: result.error };
    },
  };

  // ================================================================
  // delete_task — 删除小任务
  // ================================================================
  const deleteTaskTool: ToolDefinition = {
    name: "imtoagent_delete_task",
    description: "Delete a small task from HEARTBEAT.md.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
      },
      required: ["name"],
    },
    handler: async (params) => {
      const result = taskManager.removeTask(params.name as string);
      return result.success
        ? { success: true, message: `Task "${params.name}" deleted` }
        : { success: false, message: result.error };
    },
  };

  return [createTaskTool, listTasksTool, getTaskTool, updateTaskTool, deleteTaskTool];
}
