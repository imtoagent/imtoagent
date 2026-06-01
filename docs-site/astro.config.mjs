import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'IMtoAgent',
      logo: {
        src: './src/assets/logo.svg',
      },
      social: {
        github: 'https://github.com/imtoagent/imtoagent',
      },
      sidebar: [
        { label: 'Get Started', link: '/' },
        {
          label: 'Guide',
          items: [
            { label: 'Installation', link: '/guide/installation' },
            { label: 'Quick Start', link: '/guide/quick-start' },
            { label: 'Configuration', link: '/guide/configuration' },
            { label: 'CLI Commands', link: '/guide/cli' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', link: '/architecture/overview' },
            { label: 'IM Adapters', link: '/architecture/im-adapters' },
            { label: 'Agent Backends', link: '/architecture/agent-backends' },
            { label: 'Message Format', link: '/architecture/message-format' },
          ],
        },
        {
          label: 'IM Adapters',
          collapsed: true,
          items: [
            { label: 'Feishu', link: '/adapters/feishu' },
            { label: 'Telegram', link: '/adapters/telegram' },
            { label: 'WeCom', link: '/adapters/wecom' },
            { label: 'WeChat', link: '/adapters/wechat' },
          ],
        },
        {
          label: 'Agent Backends',
          collapsed: true,
          items: [
            { label: 'Claude Code', link: '/agents/claude' },
            { label: 'Codex', link: '/agents/codex' },
            { label: 'OpenCode', link: '/agents/opencode' },
          ],
        },
      ],
      customCss: ['./src/custom.css'],
    }),
  ],
});
