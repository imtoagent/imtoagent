/**
 * imtoagent 工具模板
 * 
 * 将此文件复制到 ~/.imtoagent/tools/ 目录下，
 * 修改 name、description 和 handler 即可创建自定义工具。
 * 
 * 框架启动时会自动扫描 ~/.imtoagent/tools/ 并注册。
 */

export default {
  /** 工具名称（唯一标识，建议用下划线分隔） */
  name: 'my_custom_tool',

  /** 工具描述（会发送给 LLM，决定何时调用） */
  description: '这个工具的作用描述',

  /** 参数定义（JSON Schema 格式，可选） */
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: '要处理的消息内容',
      },
    },
    required: ['message'],
  },

  /**
   * 处理函数
   * @param params - LLM 传入的参数（按上面的 properties 定义）
   * @param context - 运行时上下文，包含：
   *   - taskManager: TaskManager 实例
   *   - goalManager: GoalManager 实例  
   *   - goalStore: GoalStore 实例
   *   - resolveChatId: () => string  获取当前活跃聊天 ID
   */
  handler: async (params: Record<string, unknown>, context: any) => {
    const { message } = params;
    
    // 示例：访问任务管理器
    // const tasks = context.taskManager.listTasks();
    
    return `收到消息: ${message}`;
  },
};
