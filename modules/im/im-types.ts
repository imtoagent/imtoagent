// 共享 IM 适配器类型定义
// 为飞书、企业微信、微信的回调事件、消息结构、API 响应提供类型

// ================================================================
// 飞书（Lark）事件与消息类型
// ================================================================

/** 飞书消息事件载荷（im.message.receive_v1 回调 data） */
export interface FeishuMessageEvent {
  message?: {
    message_id?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;  // JSON string
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 飞书卡片消息元素 */
export interface FeishuCardElement {
  tag: string;
  [key: string]: unknown;
}

/** 飞书卡片消息整体结构 */
export interface FeishuCardMessage {
  config: { wide_screen_mode: boolean };
  elements: FeishuCardElement[];
  [key: string]: unknown;
}

/** 飞书富文本帖子段落元素 */
export interface FeishuPostElement {
  tag: string;
  text?: string;
  link?: string;
  image_key?: string;
  user_id?: string;
  [key: string]: unknown;
}

/** 飞书富文本帖子段落 */
export interface FeishuPostParagraph extends Array<FeishuPostElement> {}

/** 飞书富文本帖子 locale 内容 */
export interface FeishuPostLocale {
  title: string;
  content: FeishuPostParagraph[];
}

// ================================================================
// 企业微信（WeCom）WebSocket 帧类型
// ================================================================

/** WeCom 消息帧 body 中的选中项 */
export interface WeComSelectedItem {
  question_key?: string;
  option_ids?: {
    option_id?: string[];
  };
  [key: string]: unknown;
}

/** WeCom 消息帧 body 中的事件数据 */
export interface WeComEventData {
  eventtype?: string;
  card_type?: string;
  event_key?: string;
  selected_items?: {
    selected_item?: WeComSelectedItem[];
  };
  [key: string]: unknown;
}

/** WeCom 消息帧 body */
export interface WeComMessageBody {
  msgtype?: string;
  event?: WeComEventData;
  text?: { content?: string };
  image?: { image_key?: string };
  voice?: { voice_key?: string };
  file?: { file_key?: string };
  [key: string]: unknown;
}

/** WeCom WebSocket 消息帧 */
export interface WeComMessageFrame {
  body?: WeComMessageBody;
  [key: string]: unknown;
}

// ================================================================
// 微信（iLink）API 响应
// ================================================================

/** iLink API 通用响应（各端点结构不同，保留扩展性） */
export interface ILinkResponse {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
