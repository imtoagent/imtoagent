// ================================================================
// Goal & Task Management Tools
// ================================================================
// 供 Agent 调用的工具集，用于创建/管理定时任务和目标。
// 不直接编辑 HEARTBEAT.md，通过 GoalStore 持久化。
// ================================================================

import type { ToolDefinition } from "../agent/tool-registry";
import type { GoalManager } from "../core/goal-manager";
import type { GoalStore } from "../core/goal-store";
import { createGoal } from "../core/goal-types";
import type { GoalType, TriggerType, ActionType, RepeatStrategy } from "../core/goal-types";

export function createGoalTools(
  goalManager: GoalManager,
  goalStore: GoalStore,
  chatId: string,
): ToolDefinition[] {

  const createGoalTool: ToolDefinition = {
    name: "imtoagent_create_goal",
    description: "Create a scheduled task or goal. Supports reminders, periodic reports, monitoring alerts.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Goal type: reminder, periodic_report, monitor_alert, one_shot" },
        rawInput: { type: "string", description: "User original input for logging" },
        triggerType: { type: "string", description: "Trigger type: time, cron, interval" },
        triggerTime: { type: "string", description: "Time for time trigger, e.g. 09:00" },
        triggerCron: { type: "string", description: "Cron expression, e.g. 0 9 * * *" },
        triggerInterval: { type: "number", description: "Interval seconds" },
        actionType: { type: "string", description: "Action type: send_message, run_tool" },
        actionContent: { type: "string", description: "Message content for send_message" },
        actionTool: { type: "string", description: "Tool name for run_tool" },
        actionToolParams: { type: "object", description: "Tool params for run_tool" },
        repeat: { type: "string", description: "Repeat strategy: once, hourly, daily, weekly, custom" },
        tag: { type: "string", description: "Tag for categorization" },
      },
      required: ["rawInput", "triggerType", "actionType"],
    },
    handler: async (params) => {
      try {
        const goal = createGoal({
          type: (params.type as GoalType) || "reminder",
          trigger: {
            type: params.triggerType as TriggerType,
            time: params.triggerTime as string,
            cron: params.triggerCron as string,
            intervalSeconds: params.triggerInterval as number,
          },
          action: {
            type: params.actionType as ActionType,
            content: params.actionContent as string,
            tool: params.actionTool as string,
            toolParams: params.actionToolParams as Record<string, unknown>,
          },
          lifecycle: { repeat: (params.repeat as RepeatStrategy) || "once" },
          metadata: {
            createdBy: "agent",
            sourceChatId: chatId,
            rawInput: (params.rawInput as string) || "",
            tags: params.tag ? [params.tag as string] : undefined,
          },
        });
        const result = goalStore.add(goal);
        return result.success
          ? { success: true, goalId: goal.id, message: `Goal created: ${goal.id}` }
          : { success: false, message: result.message };
      } catch (e: unknown) {
        return { success: false, message: `Failed: ${(e as Error).message}` };
      }
    },
  };

  const listGoalsTool: ToolDefinition = {
    name: "imtoagent_list_goals",
    description: "List all goals/tasks, optionally filter by tag or status.",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter by tag" },
        status: { type: "string", description: "Filter by status: pending, active, done, failed, cancelled" },
        createdBy: { type: "string", description: "Filter by creator" },
      },
      required: [],
    },
    handler: async (params) => {
      return { goals: goalManager.listGoals({ createdBy: params.createdBy as string, tag: params.tag as string }) };
    },
  };

  const pauseGoalTool: ToolDefinition = {
    name: "imtoagent_pause_goal",
    description: "Pause a running task.",
    parameters: { type: "object", properties: { goalId: { type: "string", description: "Goal ID" } }, required: ["goalId"] },
    handler: async (params) => goalManager.pauseGoal(params.goalId as string),
  };

  const resumeGoalTool: ToolDefinition = {
    name: "imtoagent_resume_goal",
    description: "Resume a paused task.",
    parameters: { type: "object", properties: { goalId: { type: "string", description: "Goal ID" } }, required: ["goalId"] },
    handler: async (params) => goalManager.resumeGoal(params.goalId as string),
  };

  const updateGoalTool: ToolDefinition = {
    name: "imtoagent_update_goal",
    description: "Update a task trigger, action, or metadata.",
    parameters: {
      type: "object",
      properties: {
        goalId: { type: "string", description: "Goal ID" },
        triggerTime: { type: "string", description: "New trigger time" },
        triggerCron: { type: "string", description: "New cron expression" },
        actionContent: { type: "string", description: "New action content" },
        tag: { type: "string", description: "New tag" },
      },
      required: ["goalId"],
    },
    handler: async (params) => {
      const patch: Record<string, unknown> = {};
      if (params.triggerTime || params.triggerCron) {
        patch.trigger = { ...(params.triggerTime ? { time: params.triggerTime } : {}), ...(params.triggerCron ? { cron: params.triggerCron } : {}) };
      }
      if (params.actionContent) patch.action = { type: "send_message", content: params.actionContent };
      if (params.tag) patch.metadata = { tags: [params.tag as string] };
      return goalManager.updateGoal(params.goalId as string, patch);
    },
  };

  const deleteGoalTool: ToolDefinition = {
    name: "imtoagent_delete_goal",
    description: "Delete a task.",
    parameters: { type: "object", properties: { goalId: { type: "string", description: "Goal ID" } }, required: ["goalId"] },
    handler: async (params) => {
      const deleted = goalStore.delete(params.goalId as string);
      return deleted ? { success: true, message: `Goal ${params.goalId} deleted` } : { success: false, message: `Goal ${params.goalId} not found` };
    },
  };

  return [createGoalTool, listGoalsTool, pauseGoalTool, resumeGoalTool, updateGoalTool, deleteGoalTool];
}
