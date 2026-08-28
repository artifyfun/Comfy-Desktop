export default {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Comfy 令牌映射（退役过渡：旧类名 bg-tech-dark/text-tech-blue 等继续可用，
        // 值已切到 charcoal/azure 体系；二期统一改类名后删除此映射）
        'tech-dark': '#171718',
        'tech-darker': '#0d0d0e',
        'tech-blue': '#0b8ce9',
        'tech-purple': '#0b8ce9',
        'tech-pink': '#f56c6c',
        'tech-cyan': '#31b9f4',
        'tech-green': '#4ade80',
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        float: 'float 6s ease-in-out infinite',
        glow: 'glow 3s ease-in-out infinite alternate',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        glow: {
          // 发光退役（Comfy 无发光语义）：降级为淡入
          '0%': { opacity: '0.85' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
}
