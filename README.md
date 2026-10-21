# buffer-mcp — Buffer 社媒发布 MCP 服务器

通过 Buffer 统一发布/排期到 **Facebook、Instagram、YouTube** 等渠道，内置 **Cloudinary** 媒体上传与校验，共 **24 个工具**。帮助运营与办公场景实现 **AI 自动化**（内容排期、批量发布、媒体处理与数据分析）。

- 远程端点：`https://mcpweb.wjjnew.cn/buffer-mcp/mcp`（Streamable HTTP）
- 鉴权：`Authorization: Bearer mcp_sk_xxx`（在 https://mcpweb.wjjnew.cn/ 注册获取）
- 使用文档：https://mcpweb.wjjnew.cn/buffer-mcp-guide.html
- 产品介绍：https://mcpweb.wjjnew.cn/buffer-mcp

## 特性

- **一条上传链路**：`cloudinary_upload` 把本地文件变成公网 HTTPS 地址；密钥只留在进程内，不回显。
- **发布前校验**：文本长度、各平台必填元数据、媒体类型、YouTube Shorts 方向规则在调用前检查。
- **发布前探测**：`media_probe` 检查 HTTPS / HEAD / Range / Content-Type / 大小，避免 Buffer 拒收媒体。
- **写操作安全**：写工具需 `confirm` 令牌；修改/删除还需 `allowDestructive=true`；HTTP 写入需 `allowWrites=true`。
- **无 ffmpeg**：MP4 宽高/时长直接解析 `moov` box。
- **双传输**：stdio 与 Streamable HTTP 共用同一套工具注册。

## 客户端配置（远程托管，推荐）

```json
{
  "mcpServers": {
    "buffer-mcp": {
      "type": "http",
      "url": "https://mcpweb.wjjnew.cn/buffer-mcp/mcp",
      "headers": { "Authorization": "Bearer <你的 mcp_sk_xxx>" }
    }
  }
}
```

## 工具清单（24）

| 分组 | 工具 |
|---|---|
| 配置（3） | `buffer_get_config` `buffer_set_config` `buffer_reset_config` |
| 渠道（3） | `buffer_list_organizations` `buffer_list_channels` `buffer_get_channel` |
| 帖子（5） | `buffer_list_posts` `buffer_get_post` `buffer_create_post` `buffer_update_post` `buffer_delete_post` |
| 媒体（8） | `cloudinary_upload` `cloudinary_upload_batch` `cloudinary_link` `cloudinary_variants` `cloudinary_list_assets` `cloudinary_delete` `media_probe` `media_preflight` |
| 分析（5） | `buffer_list_daily_limits` `buffer_get_analytics` `buffer_list_ideas` `buffer_list_idea_groups` `buffer_create_idea` |

> `cloudinary_list_assets` 支持 `resourceType`、`type`（默认 `upload`）、`maxResults`、`nextCursor`、`prefix`、`tags`、`direction`。

### 写操作确认

| 工具 | `confirm` | 额外要求 |
|---|---|---|
| `buffer_create_post` | `"create"` | 允许写入 |
| `buffer_update_post` / `buffer_delete_post` | 帖子 id | 允许修改/删除 |
| `cloudinary_upload` / `cloudinary_upload_batch` | `"upload"` | 已配置 Cloudinary |
| `cloudinary_delete` | `public_id` | 允许修改/删除 |

## 会话与稳定性（HTTP）

- SaaS 托管默认 `MCP_HTTP_STATELESS=true`：不依赖 `Mcp-Session-Id`，服务端重启/会话过期不会出现 `Session not found`；客户端携带旧 session id 会被直接忽略。
- 本地需要**有状态会话**时保持默认（不设置该变量）即可；此时服务端重启后客户端应重新 `initialize`。

## 本地运行

```bash
npm ci
npm run build

# stdio（默认）
BUFFER_API_KEY=你的Key node dist/index.js

# Streamable HTTP
BUFFER_API_KEY=你的Key MCP_TRANSPORT=http MCP_HTTP_PORT=8787 node dist/index.js
```

客户端（stdio）：

```json
{
  "mcpServers": {
    "buffer-mcp": {
      "command": "node",
      "args": ["/path/buffer-mcp/dist/index.js"],
      "env": { "BUFFER_API_KEY": "你的Key" }
    }
  }
}
```

## 配置

- 环境变量示例：`.env.example`
- 完整配置说明：`CONFIG.md`
- 配置示例：`buffer-mcp.config.example.json`

**Cloudinary 需自备**（`CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`，或 `CLOUDINARY_URL`）；未配置时不启用上传，可改用公网媒体 URL 发布。代码中的默认值为空，不会回退到任何第三方账号。

## 要求

- Node.js >= 20
- Buffer 个人 API Key（Buffer 后台 → Developers / API）
- 可选：Cloudinary 账号（仅本地上传需要）

## License

MIT © 2026 wjjnew123
