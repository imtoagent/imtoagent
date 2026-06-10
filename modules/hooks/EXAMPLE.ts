/**
 * imtoagent 钩子模板
 * 
 * 将此文件复制到 ~/.imtoagent/hooks/ 目录下，
 * 修改 name、when 和 handler 即可创建自定义钩子。
 * 
 * 可用挂载点（when）：
 *   before_tool_call  - 工具执行前（可拦截）
 *   after_tool_call   - 工具执行后（可审计/修改结果）
 *   before_reply      - 回复发送前（可过滤/格式化）
 *   on_error          - 错误发生时（可自定义处理）
 * 
 * 框架启动时会自动扫描 ~/.imtoagent/hooks/ 并注册。
 */

export default {
  /** 钩子名称 */
  name: 'my_custom_hook',

  /** 挂载点 */
  when: 'after_tool_call',

  /**
   * 处理函数
   * 根据挂载点不同，上下文包含不同字段：
   * 
   * before_tool_call:
   *   { toolName, args, chatId, intercept }
   *   调用 intercept() 可拦截工具执行
   * 
   * after_tool_call:
   *   { toolName, args, result, success, chatId, modifyResult }
   *   调用 modifyResult(newResult) 可修改工具结果
   * 
   * before_reply:
   *   { text, chatId, modifyText }
   *   调用 modifyText(newText) 可修改回复
   * 
   * on_error:
   *   { error, context, chatId }
   */
  handler: async (ctx) => {
    console.log(`[MyHook] Tool: ${ctx.toolName}, Success: ${ctx.success}`);
  },
};
